import sharp from "sharp";
import { ReaderError } from "./local-reader.ts";
import { QWEN_MODEL } from "./reader-choice.ts";
import { normalizePaper, paperContract } from "./reader-contract.ts";
import { validQuestionCount, type ScanOutput } from "./exam.ts";
import { checkQwenNumbers, QWEN_CHECK_TIMEOUT_MS } from "./qwen-checks.ts";

// Let Ollama fit layers to available VRAM and leave the rest on CPU/RAM.
// This independent Qwen profile is never shared with GLM or its checker.
const options = { temperature: 0, num_ctx: 8192, num_gpu: -1, repeat_penalty: 1, presence_penalty: 0 };
const installMessage = "Qwen3.5-9B kurulu değil. Bilgisayarda npm run reader:setup:qwen çalıştırın; ardından bu satırı tekrar deneyin. Fotoğraf korunuyor.";
function serviceUrl() {
  const url = new URL(process.env.SCANEXAM_READER_URL || "http://127.0.0.1:11435");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password)
    throw new ReaderError("Okuyucu adresi yerel bilgisayarı göstermeli.", 503);
  return url.origin;
}

export async function getQwenStatus() {
  try {
    const response = await fetch(`${serviceUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error();
    const data = await response.json() as { models?: { name: string }[] };
    const ready = data.models?.some(item => item.name === QWEN_MODEL) ?? false;
    return { ready, model: QWEN_MODEL, message: ready ? "Qwen3.5-9B hazır. Seçilen fotoğrafları doğrudan bu model okur." : installMessage };
  } catch {
    return { ready: false, model: QWEN_MODEL, message: "Yerel Qwen okuyucusuna ulaşılamıyor. Bilgisayarda npm run reader:setup:qwen çalıştırın." };
  }
}

/** Load only on a Qwen job, outside its recognition deadline, without images. */
export async function warmQwenReader(signal: AbortSignal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  try {
    const response = await fetch(`${serviceUrl()}/api/generate`, { method: "POST", signal: bounded,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: QWEN_MODEL, stream: false, keep_alive: "30m", options }) });
    if (response.status === 404) throw new ReaderError(installMessage, 503);
    if (!response.ok) throw new ReaderError("Qwen modeli hazırlanamadı; motoru ve GPU belleğini kontrol edin.", 503);
    const result = await response.json() as { done?: boolean };
    if (!result.done) throw new ReaderError("Qwen model hazırlığı tamamlanamadı.", 503);
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    throw new ReaderError(bounded.aborted ? "Qwen hazırlığı iptal edildi veya süre sınırına ulaştı." : "Yerel Qwen motoruna ulaşılamadı.", bounded.aborted ? 504 : 503);
  }
}

/** Direct Qwen reading and source-crop checks; never invokes another model. */
export async function readQwenPaper(bytes: Uint8Array, questionCount: number, signal: AbortSignal): Promise<ScanOutput> {
  if (!validQuestionCount(questionCount)) throw new ReaderError("Geçersiz soru sayısı.", 400);
  const started = Date.now(), bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  try {
    bounded.throwIfAborted();
    const image = await sharp(bytes, { limitInputPixels: 24_000_000 }).rotate()
      .resize({ width: 1600, height: 2400, fit: "inside", withoutEnlargement: true })
      .removeAlpha().jpeg({ quality: 94 }).toBuffer();
    bounded.throwIfAborted();
    const { schema, prompt } = paperContract(questionCount);
    const response = await fetch(`${serviceUrl()}/api/chat`, { method: "POST", signal: bounded,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        model: QWEN_MODEL, stream: false, think: false, keep_alive: "30m", format: schema,
        options: { ...options, num_predict: Math.max(800, questionCount * 32 + 300) },
        messages: [{ role: "user", content: prompt, images: [image.toString("base64")] }],
      }) });
    if (response.status === 404) throw new ReaderError(installMessage, 503);
    if (!response.ok) throw new ReaderError("Qwen görüntüyü okuyamadı; yerel motoru ve GPU belleğini kontrol edin.", 502);
    const result = await response.json() as { done?: boolean; done_reason?: string; message?: { content?: string } };
    if (!result.done || result.done_reason === "length" || !result.message?.content)
      throw new ReaderError("Qwen okuması tamamlanamadı; kısmi sonuç kaydedilmedi.", 502);
    bounded.throwIfAborted();
    const raw = JSON.parse(result.message.content) as Record<string, unknown>;
    const first = { ...normalizePaper(raw, questionCount), readingStrategy: "full-table" as const };
    const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(QWEN_CHECK_TIMEOUT_MS)]);
    const output = await checkQwenNumbers(bytes, first, async (part, format, content, num_predict) => {
      checkSignal.throwIfAborted();
      const check = await fetch(`${serviceUrl()}/api/chat`, { method: "POST", signal: checkSignal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          model: QWEN_MODEL, stream: false, think: false, keep_alive: "30m", format,
          options: { ...options, num_predict }, messages: [{ role: "user", content, images: [part.toString("base64")] }],
        }) });
      if (!check.ok) throw new Error("Yakın alan okunamadı.");
      const value = await check.json() as { done?: boolean; done_reason?: string; message?: { content?: string } };
      if (!value.done || value.done_reason === "length" || !value.message?.content) throw new Error("Yakın alan okuması eksik.");
      return JSON.parse(value.message.content);
    }, checkSignal, Array.isArray(raw.uncertainFields) ? raw.uncertainFields.filter((s): s is string => typeof s === "string") : [], signal);
    return { ...output, checkMode: "single", elapsedMs: Date.now() - started };
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    throw new ReaderError(bounded.aborted ? "Qwen okuması iptal edildi veya 120 saniyelik sınıra ulaştı; fotoğraf korunuyor."
      : "Qwen geçerli bir okuma döndürmedi; fotoğrafı kontrol edip tekrar deneyin.", bounded.aborted ? 504 : 502);
  }
}
