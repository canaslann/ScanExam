import test from "node:test";
import assert from "node:assert/strict";
import { requestReader } from "../lib/reader-transport.ts";
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const response = (status, body) => new Response(JSON.stringify(body), { status });
test("direct local reader remains single-request and preserves busy status", async () => {
  const calls = [];
  const read = async (path, options) => { calls.push([path, options.method]); return response(200, { scores: [19], writtenTotal: "19" }); };
  assert.deepEqual(await requestReader({}, new AbortController().signal, read), { scores: [19], writtenTotal: "19" });
  assert.deepEqual(calls, [["/api/reader", "POST"]]);
  await assert.rejects(requestReader({}, new AbortController().signal, async () => response(409, { error: "busy" })), { status: 409, message: "busy" });
});
test("phone transport polls same-origin UUID paths, returns actual result and removes job", async () => {
  const calls = [], delays = [];
  let count = 0;
  const read = async (path, options) => {
    calls.push([path, options.method || "GET"]);
    return options.method === "POST" ? response(202, { readJob: id }) : options.method === "DELETE" ? response(200, {}) : ++count < 3 ? response(202, { pending: true }) : response(200, { scores: [19] });
  };
  assert.deepEqual(await requestReader({}, new AbortController().signal, read, async (ms) => { delays.push(ms); }), { scores: [19] });
  assert.deepEqual(delays, [1000, 1000, 1000]);
  assert.equal(calls.at(-1)[1], "DELETE");
  assert.equal(calls.filter(([path]) => path === `/api/phone-readings/${id}`).length, 4);
});
test("invalid job URLs are never fetched and asynchronous errors preserve status", async () => {
  for (const readJob of ["https://evil.example", "../../reader", "", null]) {
    let calls = 0;
    await assert.rejects(requestReader({}, new AbortController().signal, async () => { calls++; return response(202, { readJob }); }, async () => {}), { status: 502 });
    assert.equal(calls, 1);
  }
  await assert.rejects(requestReader({}, new AbortController().signal, async (_path, options) => options.method === "POST" ? response(202, { readJob: id }) : response(409, { error: "busy" }), async () => {}), { status: 409, message: "busy" });
});
test("cancelling polling sends DELETE with a fresh non-aborted signal", async () => {
  const control = new AbortController(); let cancelled = false;
  await assert.rejects(requestReader({}, control.signal, async (_path, options) => {
    if (options.method === "DELETE") { cancelled = !options.signal.aborted; return response(200, {}); }
    return response(202, { readJob: id });
  }, async () => { control.abort(); throw new DOMException("cancelled", "AbortError"); }), { name: "AbortError" });
  assert.equal(cancelled, true);
});
test("HTML gateway errors become actionable errors, never fake successful readings", async () => {
  await assert.rejects(requestReader({}, new AbortController().signal, async () => new Response("<!DOCTYPE html>gateway failed", { status: 502 })), { status: 502, message: /HTTP 502/ });
});
