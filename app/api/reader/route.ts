import { getReaderStatus, readLocalPaper, ReaderError, validateReaderInput } from "@/lib/local-reader";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

export async function GET() {
  return Response.json(await getReaderStatus(), { headers });
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new ReaderError("Bu kaynaktan tarama yapılamaz.", 403);
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 8_001_000) throw new ReaderError("Görüntü boyutu sınırı aşıldı.", 413);
    // The reader never receives a client-supplied model name, prompt, URL or filename.
    const reader = request.body?.getReader();
    if (!reader) throw new ReaderError("Görüntü gönderilmedi.", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8_001_000) { await reader.cancel(); throw new ReaderError("Görüntü boyutu sınırı aşıldı.", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new ReaderError("Geçersiz tarama isteği.", 400); }
    const { image, checkMode } = validateReaderInput(body);
    return Response.json(await readLocalPaper(image, checkMode, request.signal), { headers });
  } catch (error) {
    return Response.json({ error: error instanceof ReaderError ? error.message : "Okuma sırasında beklenmeyen bir hata oluştu." },
      { status: error instanceof ReaderError ? error.status : 500, headers });
  }
}
