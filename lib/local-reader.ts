import { compareReadings, normalizePaper, PAPER_SCHEMA, TRANSCRIBE_PROMPT, type CheckMode } from "./reader-contract.ts";
import type { ScanOutput } from "./exam";

const model = () => {
  const selected = process.env.SCANEXAM_MODEL || "qwen3.5:4b";
  if (/cloud/i.test(selected)) throw new ReaderError("Yalnızca yerel modeller kullanılabilir.", 503);
  return selected;
};
function serviceUrl() {
  const url = new URL(process.env.SCANEXAM_READER_URL || "http://127.0.0.1:11435");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new ReaderError("Okuyucu adresi yerel bilgisayarı göstermeli.", 503);
  }
  return url.origin;
}

export class ReaderError extends Error {
  status: number;
  constructor(message: string, status = 500) { super(message); this.status = status; }
}

export async function getReaderStatus() {
  const configured = process.env.SCANEXAM_MODEL || "qwen3.5:4b";
  try {
    const response = await fetch(`${serviceUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json() as { models?: { name: string }[] };
    const installed = data.models?.some((item) => item.name === model()) ?? false;
    return { ready: installed, model: model(), message: installed
      ? "Yerel el yazısı okuyucu hazır. Fotoğraflar bilgisayarınızda işlenir."
      : "Okuma modeli kurulu değil. Bilgisayarda npm run reader:setup çalıştırın." };
  } catch (error) {
    return { ready: false, model: configured, message: error instanceof ReaderError ? error.message
      : "Yerel okuyucuya ulaşılamıyor. Bilgisayarda npm run reader:setup, ardından npm run dev çalıştırın." };
  }
}

export function validateReaderInput(input: unknown): { image: string; checkMode: CheckMode } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReaderError("Geçerli bir görüntü gönderilmeli.", 400);
  const { image, checkMode = "single" } = input as Record<string, unknown>;
  if (typeof image !== "string" || image.length > 8_000_000 || !/^data:image\/jpeg;base64,\/[9]j\/[A-Za-z0-9+/=]+$/.test(image)) {
    throw new ReaderError("Görüntü geçerli bir JPEG olmalı ve 6 MB sınırını aşmamalı.", 400);
  }
  if (checkMode !== "single" && checkMode !== "double") throw new ReaderError("Kontrol modu geçersiz.", 400);
  return { image: image.slice(image.indexOf(",") + 1), checkMode };
}

async function transcribe(image: string, signal: AbortSignal, verify = false): Promise<ScanOutput> {
  let response: Response;
  try {
    response = await fetch(`${serviceUrl()}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ model: model(), stream: false, think: false, keep_alive: "10m", format: PAPER_SCHEMA,
        options: { temperature: 0, num_ctx: 4096, num_predict: 600 },
        messages: [{ role: "user", content: (verify ? "Make a fresh careful visual transcription. Pay special attention to ambiguous handwritten digits, leading zeroes, Turkish letters and the distinction between Puan and Not. " : "")
          + TRANSCRIBE_PROMPT + JSON.stringify(PAPER_SCHEMA), images: [image] }] }),
    });
  } catch {
    if (signal.aborted) throw new ReaderError("Okuma iptal edildi veya süre sınırına ulaştı. Daha net bir fotoğrafla tekrar deneyin.", 504);
    throw new ReaderError("Yerel okuyucuya bağlantı kurulamadı. Bilgisayarda npm run reader:setup çalıştırın.", 503);
  }
  if (!response.ok) {
    if (response.status === 404) throw new ReaderError("Okuma modeli kurulu değil. npm run reader:setup çalıştırın.", 503);
    throw new ReaderError("Yerel motor görüntüyü okuyamadı. Motor günlüğünü veya kullanılabilir belleği kontrol edin.", 502);
  }
  const result = await response.json() as { message?: { content?: string }; done?: boolean; done_reason?: string };
  if (!result.done || !result.message?.content || result.done_reason === "length") throw new ReaderError("Okuma tamamlanamadı; hiçbir tahmin kaydedilmedi.", 502);
  try { return normalizePaper(JSON.parse(result.message.content)); }
  catch { throw new ReaderError("Okuyucu geçerli bir tablo döndürmedi; fotoğrafı tekrar çekin veya elle giriş yapın.", 502); }
}

let busy = false;
export async function readLocalPaper(image: string, checkMode: CheckMode, signal: AbortSignal): Promise<ScanOutput> {
  if (busy) throw new ReaderError("Başka bir kâğıt okunuyor. Tamamlanınca yeniden deneyin.", 409);
  busy = true;
  const started = Date.now();
  try {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(checkMode === "double" ? 240_000 : 120_000)]);
    const first = await transcribe(image, bounded);
    let result: ScanOutput = { ...first, checkMode };
    if (checkMode === "double") {
      try { result = compareReadings(first, await transcribe(image, bounded, true)); }
      catch (error) {
        if (signal.aborted) throw error;
        result = { ...first, checkMode: "single", reviewFields: [...new Set([...(first.reviewFields || []), "fullName", "studentNumber", "s1", "s2", "s3", "s4", "s5", "writtenTotal"])],
          warnings: [...(first.warnings || []), "İkinci okuma tamamlanamadı. İlk sonuç korunuyor; alanları elle kontrol edin."] };
      }
    }
    return { ...result, elapsedMs: Date.now() - started };
  } finally { busy = false; }
}
