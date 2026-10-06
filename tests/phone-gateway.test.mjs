import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createPhoneGateway } from "../reader/phone-gateway.mjs";

const origin = "https://test-scan.trycloudflare.com";
const password = "test-password-only-12345";
const auth = `Basic ${Buffer.from(`scanexam:${password}`).toString("base64")}`;
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function fixture(t, handler) {
  const upstream = createServer(handler || ((req, res) => res.end("ok")));
  const appPort = await listen(upstream);
  const gateway = createPhoneGateway({ password });
  const port = await listen(gateway.server);
  t.after(() => { gateway.close(); upstream.closeAllConnections(); upstream.close(); });
  return { gateway, port, appPort, configure: () => gateway.configure(origin, `http://127.0.0.1:${appPort}`) };
}
function call(port, path = "/", { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers: { host: new URL(origin).host, "x-forwarded-proto": "https", authorization: auth, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => { resolve({ status: res.statusCode, headers: res.headers, body: data }); });
    });
    req.on("error", reject);
    req.end(body);
  });
}
test("phone gateway fails closed until ready, binds to loopback and requires auth on all routes", async (t) => {
  const f = await fixture(t);
  assert.equal(f.gateway.server.address().address, "127.0.0.1");
  assert.equal((await call(f.port)).status, 503);
  f.configure();
  for (const path of ["/", "/api/reader", "/_next/static/worker.js", "/api/phone-readings/unknown"]) {
    const result = await call(f.port, path, { headers: { authorization: "" } });
    assert.equal(result.status, 401);
    assert.match(result.headers["www-authenticate"], /Basic/);
    assert.equal(result.headers["cache-control"], "no-store");
  }
  assert.equal((await call(f.port, "/", { headers: { authorization: "Basic wrong" } })).status, 401);
  assert.equal((await call(f.port)).status, 200);
});
test("phone gateway rejects HTTP, foreign hosts/origins, missing write Origin and remote upstreams", async (t) => {
  const f = await fixture(t); f.configure();
  assert.equal((await call(f.port, "/", { headers: { host: "evil.example" } })).status, 421);
  assert.equal((await call(f.port, "/\\evil.example/path")).status, 400);
  for (const protocol of ["http", "", "https,http"]) assert.equal((await call(f.port, "/", { headers: { "x-forwarded-proto": protocol } })).status, 403);
  assert.equal((await call(f.port, "/", { headers: { origin: "https://evil.example" } })).status, 403);
  for (const supplied of [undefined, "null", "https://evil.example"]) assert.equal((await call(f.port, "/api/reader", { method: "POST", headers: supplied ? { origin: supplied } : {}, body: "{}" })).status, 403);
  const other = createPhoneGateway({ password }); t.after(() => other.close());
  assert.throws(() => other.configure(origin, "http://remote.example"));
  assert.throws(() => other.configure("http://insecure.example", "http://127.0.0.1:1234"));
  assert.throws(() => createPhoneGateway({ password: "short" }));
});
test("proxy preserves approved host/origin but strips passwords and forwarded headers", async (t) => {
  let seen;
  const f = await fixture(t, (req, res) => { seen = req.headers; res.end("ok"); }); f.configure();
  await call(f.port, "/api/reader", { headers: { origin, "x-forwarded-host": "evil.example", "cf-connecting-ip": "spoof", forwarded: "host=evil" } });
  assert.equal(seen.host, new URL(origin).host);
  assert.equal(seen.origin, origin);
  for (const key of ["authorization", "x-forwarded-host", "x-forwarded-proto", "cf-connecting-ip", "forwarded"]) assert.equal(seen[key], undefined);
});
test("long local reads return immediately as jobs, keep reader errors and allow cancellation", async (t) => {
  let finish, disconnected = false;
  const f = await fixture(t, (req, res) => {
    assert.equal(req.headers["accept-encoding"], "identity");
    req.resume();
    res.on("close", () => { if (!res.writableFinished) disconnected = true; });
    finish = () => { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "reader busy" })); };
  }); f.configure();
  const submitted = await call(f.port, "/api/reader", { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" });
  assert.equal(submitted.status, 202);
  const id = JSON.parse(submitted.body).readJob;
  const path = `/api/phone-readings/${id}`;
  assert.equal((await call(f.port, path)).status, 202);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  finish();
  let result;
  for (let n = 0; n < 30; n++) { result = await call(f.port, path); if (result.status !== 202) break; }
  assert.equal(result.status, 409);
  assert.equal(JSON.parse(result.body).error, "reader busy");
  assert.equal((await call(f.port, path)).status, 409); // lost polling response can be fetched again
  assert.equal((await call(f.port, path, { method: "DELETE", headers: { origin } })).status, 200);
  assert.equal((await call(f.port, path)).status, 404);
  finish = undefined;
  const second = await call(f.port, "/api/reader", { method: "POST", headers: { origin }, body: "{}" });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await call(f.port, `/api/phone-readings/${JSON.parse(second.body).readJob}`, { method: "DELETE", headers: { origin } });
  for (let n = 0; n < 30 && !disconnected; n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(disconnected, true);
});
test("gateway bounds photo bodies and finished jobs, refusing overload instead of dropping rows", async (t) => {
  const f = await fixture(t, (req, res) => { req.resume(); res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"bad input"}'); }); f.configure();
  assert.equal((await call(f.port, "/api/reader", { method: "POST", headers: { origin, "content-length": "8001002" }, body: "x".repeat(8_001_002) })).status, 413);
  for (let n = 0; n < 16; n++) assert.equal((await call(f.port, "/api/reader", { method: "POST", headers: { origin }, body: "{}" })).status, 202);
  assert.equal((await call(f.port, "/api/reader", { method: "POST", headers: { origin }, body: "{}" })).status, 409);
});
