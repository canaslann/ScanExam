import sharp from "sharp";
import { allowedReaderOrigin } from "@/lib/request-origin";
import { SharedError } from "@/lib/shared-session";
import { sharedStore, wakeSharedReader } from "@/lib/shared-service";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
function authorize(request: Request) {
  const target = new URL(request.url), host = target.hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]"
    || /^10\.\d+\.\d+\.\d+$/.test(host) || /^192\.168\.\d+\.\d+$/.test(host)
    || /^172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
  const publicHost = process.env.SCANEXAM_PUBLIC_ORIGIN && new URL(process.env.SCANEXAM_PUBLIC_ORIGIN).host === target.host;
  if (!local && !publicHost) throw new SharedError("Ortak tablo bu adresten açılamaz.", 403);
  const origin = request.headers.get("origin");
  if ((request.method !== "GET" && !origin) || !allowedReaderOrigin(request.url, origin, {
    directHttps: process.env.NODE_ENV !== "production" && Boolean(process.env.SCANEXAM_HTTPS_CERT && process.env.SCANEXAM_HTTPS_KEY),
    publicOrigin: process.env.SCANEXAM_PUBLIC_ORIGIN,
  })) throw new SharedError("Bu kaynaktan tablo işlemi yapılamaz.", 403);
}
function failure(error: unknown) {
  return Response.json({ error: error instanceof SharedError ? error.message : "Ortak tablo işlemi tamamlanamadı; mevcut veriler korunuyor." },
    { status: error instanceof SharedError ? error.status : 500, headers });
}
export async function GET(request: Request) {
  try {
    authorize(request);
    const photo = new URL(request.url).searchParams.get("photo");
    if (photo) {
      const bytes = sharedStore().photo(photo);
      if (!bytes) throw new SharedError("Kaynak görüntü bulunamadı.", 404);
      const type = bytes[0] === 0xff ? "image/jpeg" : bytes[0] === 0x89 ? "image/png" : "image/webp";
      return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": type, "X-Content-Type-Options": "nosniff" } });
    }
    wakeSharedReader();
    return Response.json(sharedStore().snapshot(), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    authorize(request);
    const target = new URL(request.url), capture = target.searchParams.get("action") === "capture";
    const roster = target.searchParams.get("action") === "roster";
    const limit = capture ? 25 * 1024 * 1024 : roster ? 2 * 1024 * 1024 : 128 * 1024;
    if (Number(request.headers.get("content-length") || 0) > limit) throw new SharedError("İstek boyutu sınırı aşıldı.", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new SharedError("İstek verisi eksik.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) { await reader.cancel(); throw new SharedError("İstek boyutu sınırı aşıldı.", 413); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let result;
    if (capture) {
      let metadata;
      try { metadata = await sharp(bytes, { limitInputPixels: 24_000_000 }).metadata(); }
      catch { throw new SharedError("Görüntü açılamadı; JPEG, PNG veya WebP kullanın."); }
      if (!["jpeg", "png", "webp"].includes(metadata.format || "") || !metadata.width || !metadata.height
        || metadata.width * metadata.height > 24_000_000) throw new SharedError("Görüntü biçimi/boyutu desteklenmiyor.");
      result = sharedStore().mutate({ action: "capture", id: target.searchParams.get("id"), opId: target.searchParams.get("opId"),
        examId: target.searchParams.get("examId"), mode: target.searchParams.get("mode"), reader: target.searchParams.get("reader") ?? undefined, source:target.searchParams.get("source") ?? undefined }, bytes);
    } else {
      let command;
      try { command = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new SharedError("Tablo işlemi JSON biçiminde olmalı."); }
      if (roster && command?.action !== "roster") throw new SharedError("Öğrenci listesi işlemi geçersiz.");
      result = sharedStore().mutate(command);
    }
    wakeSharedReader();
    return Response.json(result, { headers });
  } catch (error) { return failure(error); }
}
