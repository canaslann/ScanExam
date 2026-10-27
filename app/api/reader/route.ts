import {
  ReaderError,
  validateReaderInput,
} from "@/lib/local-reader";
import { readSelectedPaper, selectedReaderStatus, validateReaderChoice } from "@/lib/selected-reader";
import { allowedReaderOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    const choice = validateReaderChoice(new URL(request.url).searchParams.get("reader") ?? undefined);
    return Response.json(await selectedReaderStatus(choice), { headers });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: error instanceof ReaderError ? error.status : 500, headers });
  }
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (!allowedReaderOrigin(request.url, origin, {
      directHttps: process.env.NODE_ENV !== "production" && Boolean(process.env.SCANEXAM_HTTPS_CERT && process.env.SCANEXAM_HTTPS_KEY),
      publicOrigin: process.env.SCANEXAM_PUBLIC_ORIGIN,
    }))
      throw new ReaderError("Bu kaynaktan tarama yapılamaz.", 403);
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 8_001_000)
      throw new ReaderError("Görüntü boyutu sınırı aşıldı.", 413);
    // The reader never receives a client-supplied model name, prompt, URL or filename.
    const reader = request.body?.getReader();
    if (!reader) throw new ReaderError("Görüntü gönderilmedi.", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8_001_000) {
        await reader.cancel();
        throw new ReaderError("Görüntü boyutu sınırı aşıldı.", 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ReaderError("Geçersiz tarama isteği.", 400);
    }
    const { image, checkMode, regions, compactImage, questionCount } =
      validateReaderInput(body);
    const choice = validateReaderChoice((body as Record<string, unknown>).reader);
    return Response.json(
      await readSelectedPaper(
        choice,
        image,
        checkMode,
        request.signal,
        regions,
        compactImage,
        questionCount,
      ),
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof ReaderError
            ? error.message
            : "Okuma sırasında beklenmeyen bir hata oluştu.",
      },
      { status: error instanceof ReaderError ? error.status : 500, headers },
    );
  }
}
