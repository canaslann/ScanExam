import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";

const MAX_BODY = 8_001_000;
const MAX_JOBS = 16;
const JOB_TTL = 5 * 60_000;
const hash = (value) => createHash("sha256").update(value).digest();
const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
function cleanHeaders(headers) {
  const excluded = new Set([...hopHeaders, ...(headers.connection || "").toLowerCase().split(",").map((v) => v.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key)));
}

/** This gateway binds ONLY to loopback. Authentication covers HTML, assets and every API. */
export function createPhoneGateway({ password }) {
  if (typeof password !== "string" || password.length < 8) throw new Error("Telefon bağlantısı için en az 8 karakterlik parola gerekir.");
  const credential = hash(`Basic ${Buffer.from(`scanexam:${password}`).toString("base64")}`);
  const jobs = new Map();
  let origin, upstream, uploads = 0;
  const json = (res, status, value) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    res.end(JSON.stringify(value));
  };
  const expire = () => {
    const now = Date.now();
    for (const [id, job] of jobs) if (now - job.created > JOB_TTL) {
      job.controller.abort();
      jobs.delete(id);
    }
  };
  const sweep = setInterval(expire, 30_000);
  sweep.unref();
  function headersFor(req) {
    const headers = cleanHeaders(req.headers);
    // Never pass gateway credentials or client-controlled proxy headers to the application.
    for (const key of Object.keys(headers)) if (key === "authorization" || key === "forwarded" || key.startsWith("x-forwarded-") || key.startsWith("cf-")) delete headers[key];
    headers.host = new URL(origin).host;
    return headers;
  }
  async function submit(req, res) {
    expire();
    if (jobs.size >= MAX_JOBS) { req.resume(); return json(res, 409, { error: "Telefon okuma kuyruğu dolu; biraz sonra yeniden deneyin." }); }
    if (Number(req.headers["content-length"] || 0) > MAX_BODY) { req.resume(); return json(res, 413, { error: "Görüntü boyutu sınırı aşıldı." }); }
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_BODY) { req.resume(); return json(res, 413, { error: "Görüntü boyutu sınırı aşıldı." }); }
      chunks.push(chunk);
    }
    if (jobs.size >= MAX_JOBS) return json(res, 409, { error: "Telefon okuma kuyruğu dolu; biraz sonra yeniden deneyin." });
    const body = Buffer.concat(chunks);
    const id = randomUUID();
    const controller = new AbortController();
    const job = { created: Date.now(), controller, result: null };
    jobs.set(id, job);
    // Keep long OCR requests entirely on loopback. The phone only polls short HTTPS requests.
    const headers = headersFor(req);
    headers["content-length"] = String(body.length);
    // Node's HTTP client does not decompress like browser fetch; capture plain JSON for polling.
    headers["accept-encoding"] = "identity";
    const request = httpRequest(new URL("/api/reader", upstream), { method: "POST", headers, signal: controller.signal }, (response) => {
      const resultChunks = [];
      let resultSize = 0;
      response.on("data", (chunk) => {
        resultSize += chunk.length;
        if (resultSize > 1_000_000) request.destroy(new Error("Okuyucu yanıtı çok büyük."));
        else resultChunks.push(chunk);
      });
      response.on("error", () => {
        job.result = { status: 502, body: { error: "Yerel okuyucu bağlantısı kesildi." } };
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(resultChunks).toString("utf8"));
          job.result = { status: response.statusCode || 502, body: parsed };
        } catch {
          job.result = { status: 502, body: { error: "Yerel okuyucudan geçerli bir yanıt alınamadı." } };
        }
      });
    });
    request.setTimeout(260_000, () => request.destroy(new Error("Okuma süresi aşıldı.")));
    request.on("error", () => {
      job.result = { status: controller.signal.aborted ? 499 : 502, body: { error: "Okuma iptal edildi veya yerel okuyucu bağlantısı kesildi." } };
    });
    request.end(body);
    json(res, 202, { readJob: id });
  }
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!origin || !upstream) return json(res, 503, { error: "Telefon bağlantısı hazırlanıyor." });
    if (req.headers.host !== new URL(origin).host) return json(res, 421, { error: "Geçersiz bağlantı adresi." });
    if (req.headers["x-forwarded-proto"] !== "https") return json(res, 403, { error: "Telefon bağlantısı HTTPS ile açılmalı." });
    if (!timingSafeEqual(hash(req.headers.authorization || ""), credential)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="ScanExam", charset="UTF-8"');
      return json(res, 401, { error: "Bu bağlantı için kullanıcı adı ve parola gerekiyor." });
    }
    if (!["GET", "HEAD"].includes(req.method) && req.headers.origin !== origin)
      return json(res, 403, { error: "Bu kaynaktan tarama yapılamaz." });
    // Also reject foreign-Origin reads. No permissive CORS or proxy-header trust.
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: "Bu kaynaktan erişim yapılamaz." });
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) return json(res, 400, { error: "Geçersiz istek." });
    const url = new URL(req.url, origin);
    if (url.origin !== origin) return json(res, 400, { error: "Geçersiz istek adresi." });
    if (url.pathname === "/api/reader" && req.method === "POST") {
      if (uploads >= 4) { req.resume(); return json(res, 409, { error: "Fotoğraf aktarım sınırı dolu; yeniden deneyin." }); }
      uploads++;
      void submit(req, res).catch(() => { if (!res.headersSent) json(res, 400, { error: "Fotoğraf aktarımı tamamlanamadı." }); else res.destroy(); }).finally(() => { uploads--; });
      return;
    }
    if (url.pathname.startsWith("/api/phone-readings/")) {
      const id = url.pathname.slice("/api/phone-readings/".length);
      expire();
      const job = jobs.get(id);
      if (!job) return json(res, 404, { error: "Okuma oturumu sona erdi; kâğıdı tablodan yeniden deneyin." });
      if (req.method === "DELETE") {
        job.controller.abort();
        jobs.delete(id);
        return json(res, 200, { cancelled: true });
      }
      if (req.method !== "GET") return json(res, 405, { error: "Geçersiz işlem." });
      if (!job.result) return json(res, 202, { pending: true });
      // Retain completed jobs briefly so a lost polling response can be fetched again safely.
      return json(res, job.result.status, job.result.body);
    }
    const proxy = httpRequest(new URL(req.url, upstream), { method: req.method, headers: headersFor(req) }, (response) => {
      const headers = cleanHeaders(response.headers);
      headers["cache-control"] = "no-store";
      headers["referrer-policy"] = "no-referrer";
      res.writeHead(response.statusCode || 502, headers);
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    proxy.setTimeout(30_000, () => proxy.destroy(new Error("Bağlantı zaman aşımı.")));
    proxy.on("error", () => { if (!res.headersSent) json(res, 502, { error: "Yerel uygulamaya ulaşılamıyor." }); else res.destroy(); });
    req.on("aborted", () => proxy.destroy());
    res.on("close", () => { if (!res.writableFinished) proxy.destroy(); });
    req.pipe(proxy);
  });
  server.maxHeadersCount = 100;
  return {
    server,
    configure(publicOrigin, upstreamUrl) {
      const external = new URL(publicOrigin), local = new URL(upstreamUrl);
      if (external.protocol !== "https:" || external.origin !== publicOrigin || external.username || external.password) throw new Error("Tam HTTPS kaynağı gerekir.");
      if (local.protocol !== "http:" || local.hostname !== "127.0.0.1" || local.username || local.password || local.pathname !== "/" || local.search || local.hash) throw new Error("Telefon geçidi yalnız yerel uygulamaya bağlanabilir.");
      if (origin) throw new Error("Aktif telefon geçidinin adresi değiştirilemez.");
      origin = publicOrigin;
      upstream = upstreamUrl;
    },
    close() {
      clearInterval(sweep);
      for (const job of jobs.values()) job.controller.abort();
      jobs.clear();
      server.closeAllConnections();
      server.close();
    },
  };
}
