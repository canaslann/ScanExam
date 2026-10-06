import {
  compareReadings,
  fieldKeys,
  mergeRegionReadings,
  normalizePaper,
  paperContract,
  regionContract,
  type CheckMode,
} from "./reader-contract.ts";
import type { ScanOutput } from "./exam";
import { validQuestionCount } from "./exam.ts";
import {
  REGION_KEYS,
  type PaperRegions,
  type RegionKey,
} from "./paper-regions.ts";
import { readGlmRegions } from "./glm-ocr.ts";
import { prepareServerPaper, type PreparedPaper } from "./paper-preparation.ts";

const model = () => {
  const selected = process.env.SCANEXAM_MODEL || "glm-ocr-eot:q8_0";
  if (/cloud/i.test(selected))
    throw new ReaderError("Yalnızca yerel modeller kullanılabilir.", 503);
  return selected;
};
let warming: Promise<void> | undefined;
/** Startup/setup work has its own deadline and never sends a student's image. */
export function warmLocalReader(): Promise<void> {
  if (model() !== "glm-ocr-eot:q8_0") return Promise.resolve();
  if (warming) return warming;
  warming = (async () => {
    const signal = AbortSignal.timeout(180_000);
    // A completed image-free load is the readiness signal, not only a resident
    // model listing. On a warm model this is a cheap keep-alive acknowledgement.
    const response = await fetch(`${serviceUrl()}/api/generate`, { method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model(), stream: false, keep_alive: "30m" }) });
    if (!response.ok) throw new ReaderError("GLM modeli hazırlanamadı; yerel motoru kontrol edip yeniden deneyin.", 503);
    const result = await response.json() as { done?: boolean };
    if (!result.done) throw new ReaderError("GLM model hazırlığı tamamlanamadı.", 503);
  })().finally(() => { warming = undefined; });
  return warming;
}
function serviceUrl() {
  const url = new URL(
    process.env.SCANEXAM_READER_URL || "http://127.0.0.1:11435",
  );
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new ReaderError("Okuyucu adresi yerel bilgisayarı göstermeli.", 503);
  }
  return url.origin;
}

export class ReaderError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

export async function getReaderStatus() {
  const configured = process.env.SCANEXAM_MODEL || "glm-ocr-eot:q8_0";
  try {
    const response = await fetch(`${serviceUrl()}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error("unavailable");
    const data = (await response.json()) as { models?: { name: string }[] };
    const installed =
      data.models?.some((item) => item.name === model()) ?? false;
    return {
      ready: installed,
      model: model(),
      message: installed
        ? warming ? "GLM modeli ilk kullanım için hazırlanıyor; kâğıtlar güvenli kuyrukta bekler."
          : "Yerel el yazısı okuyucu hazır. Fotoğraflar bilgisayarınızda işlenir."
        : "Okuma modeli kurulu değil. Bilgisayarda npm run reader:setup çalıştırın.",
    };
  } catch (error) {
    return {
      ready: false,
      model: configured,
      message:
        error instanceof ReaderError
          ? error.message
          : "Yerel okuyucuya ulaşılamıyor. Bilgisayarda npm run reader:setup, ardından npm run dev çalıştırın.",
    };
  }
}

export function validateReaderInput(input: unknown): {
  image: string;
  checkMode: CheckMode;
  regions?: PaperRegions;
  compactImage?: string;
  questionCount?: number;
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ReaderError("Geçerli bir görüntü gönderilmeli.", 400);
  const {
    image,
    checkMode = "single",
    regions,
    compactImage,
    questionCount,
  } = input as Record<string, unknown>;
  const jpeg = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length <= 8_000_000 &&
    /^data:image\/jpeg;base64,\/[9]j\/[A-Za-z0-9+/=]+$/.test(value);
  if (!jpeg(image))
    throw new ReaderError(
      "Görüntü geçerli bir JPEG olmalı ve 6 MB sınırını aşmamalı.",
      400,
    );
  if (checkMode !== "single" && checkMode !== "double")
    throw new ReaderError("Kontrol modu geçersiz.", 400);
  if (questionCount !== undefined && !validQuestionCount(questionCount))
    throw new ReaderError("Soru sayısı 1–30 arasında tam sayı olmalı.", 400);
  const result: {
    image: string;
    checkMode: CheckMode;
    regions?: PaperRegions;
    compactImage?: string;
    questionCount?: number;
  } = {
    image: image.slice(image.indexOf(",") + 1),
    checkMode,
    ...(questionCount === undefined ? {} : { questionCount }),
  };
  let size = image.length;
  if (compactImage !== undefined) {
    if (!jpeg(compactImage))
      throw new ReaderError("Kırpılmış tablo geçerli bir JPEG olmalı.", 400);
    size += compactImage.length;
    if (size > 8_000_000)
      throw new ReaderError("Görüntülerin toplam boyutu sınırı aşıldı.", 413);
    result.compactImage = compactImage.slice(compactImage.indexOf(",") + 1);
  }
  if (regions !== undefined) {
    if (
      !regions ||
      typeof regions !== "object" ||
      Array.isArray(regions) ||
      Object.keys(regions).length !== 3
    )
      throw new ReaderError("Bölge görüntüleri geçersiz.", 400);
    const supplied = regions as Record<string, unknown>;
    const decoded = {} as PaperRegions;
    for (const name of REGION_KEYS) {
      const value = supplied[name];
      if (!jpeg(value))
        throw new ReaderError("Bölgeler yerel JPEG görüntüleri olmalı.", 400);
      size += value.length;
      if (size > 8_000_000)
        throw new ReaderError("Görüntülerin toplam boyutu sınırı aşıldı.", 413);
      decoded[name] = value.slice(value.indexOf(",") + 1);
    }
    result.regions = decoded;
  }
  return result;
}

async function requestTranscription(
  image: string,
  signal: AbortSignal,
  schema: object,
  prompt: string,
  verify = false,
  questionCount = 5,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${serviceUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: model(),
        stream: false,
        think: false,
        keep_alive: "10m",
        format: schema,
        options: {
          temperature: 0,
          num_ctx: 4096,
          num_predict: Math.max(600, questionCount * 24 + 240),
          ...(process.env.SCANEXAM_READER_THREADS &&
          /^\d+$/.test(process.env.SCANEXAM_READER_THREADS)
            ? {
                num_thread: Math.max(
                  1,
                  Math.min(64, Number(process.env.SCANEXAM_READER_THREADS)),
                ),
              }
            : {}),
        },
        messages: [
          {
            role: "user",
            content:
              (verify
                ? "Make a fresh careful visual transcription. Pay special attention to ambiguous handwritten digits, leading zeroes, Turkish letters and the distinction between Puan and Not. "
                : "") + prompt,
            images: [image],
          },
        ],
      }),
    });
  } catch {
    if (signal.aborted)
      throw new ReaderError(
        "Okuma iptal edildi veya süre sınırına ulaştı. Daha net bir fotoğrafla tekrar deneyin.",
        504,
      );
    throw new ReaderError(
      "Yerel okuyucuya bağlantı kurulamadı. Bilgisayarda npm run reader:setup çalıştırın.",
      503,
    );
  }
  if (!response.ok) {
    if (response.status === 404)
      throw new ReaderError(
        "Okuma modeli kurulu değil. npm run reader:setup çalıştırın.",
        503,
      );
    throw new ReaderError(
      "Yerel motor görüntüyü okuyamadı. Motor günlüğünü veya kullanılabilir belleği kontrol edin.",
      502,
    );
  }
  const result = (await response.json()) as {
    message?: { content?: string };
    done?: boolean;
    done_reason?: string;
  };
  if (
    !result.done ||
    !result.message?.content ||
    result.done_reason === "length"
  )
    throw new ReaderError(
      "Okuma tamamlanamadı; hiçbir tahmin kaydedilmedi.",
      502,
    );
  try {
    return JSON.parse(result.message.content);
  } catch {
    throw new ReaderError(
      "Okuyucu geçerli bir tablo döndürmedi; fotoğrafı tekrar çekin veya elle giriş yapın.",
      502,
    );
  }
}

async function transcribe(
  image: string,
  signal: AbortSignal,
  verify = false,
  questionCount = 5,
): Promise<ScanOutput> {
  const { schema, prompt } = paperContract(questionCount);
  try {
    return {
      ...normalizePaper(
        await requestTranscription(
          image,
          signal,
          schema,
          prompt,
          verify,
          questionCount,
        ),
        questionCount,
      ),
      readingStrategy: "full-table",
    };
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    throw new ReaderError(
      "Okuyucu geçerli bir tablo döndürmedi; fotoğrafı tekrar çekin veya elle giriş yapın.",
      502,
    );
  }
}

async function transcribeRegions(
  regions: PaperRegions,
  signal: AbortSignal,
  verify = false,
  questionCount = 5,
): Promise<{ output: ScanOutput; parts: Record<RegionKey, unknown> }> {
  const parts = {} as Record<RegionKey, unknown>;
  for (const name of ["scores", "student", "course"] as const) {
    const { schema, prompt } = regionContract(name, questionCount);
    parts[name] = await requestTranscription(
      regions[name],
      signal,
      schema,
      prompt,
      verify,
      questionCount,
    );
    if (name === "scores") {
      const numericOnly = mergeRegionReadings(
        {
          student: { fullName: "", studentNumber: "", uncertainFields: [] },
          course: { courseCode: "", courseName: "", uncertainFields: [] },
          scores: parts.scores,
        },
        questionCount,
      );
      if (
        numericOnly.reviewFields?.some(
          (field) =>
            /^s\d+$/.test(field) ||
            field === "writtenTotal" ||
            field === "pcMap",
        )
      ) {
        // Stop before doing the other two regions: reserve time for the original
        // full-table prompt within the existing shared 120/240 second deadline.
        return { output: numericOnly, parts };
      }
    }
  }
  try {
    return {
      output: {
        ...mergeRegionReadings(parts, questionCount),
        readingStrategy: "regions",
      },
      parts,
    };
  } catch {
    throw new ReaderError("Bölgesel okuma eksik veya geçersiz.", 502);
  }
}

let busy = false;
async function loadedBackend(
  signal: AbortSignal,
): Promise<"cpu" | "gpu" | "unknown"> {
  const inspect = async () => {
    const response = await fetch(`${serviceUrl()}/api/ps`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as {
      models?: { name: string; size_vram?: number }[];
    };
    return data.models?.find((item) => item.name === model());
  };
  try {
    let loaded = await inspect();
    if (!loaded) {
      // An empty-prompt load only warms the selected local model; no image,
      // expected answer or generated transcription is involved.
      const response = await fetch(`${serviceUrl()}/api/generate`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model(),
          stream: false,
          keep_alive: "10m",
          options: { num_ctx: 4096 },
        }),
      });
      if (!response.ok) return "unknown";
      const result = (await response.json()) as { done?: boolean };
      if (!result.done) return "unknown";
      loaded = await inspect();
    }
    if (
      !loaded ||
      typeof loaded.size_vram !== "number" ||
      !Number.isFinite(loaded.size_vram) ||
      loaded.size_vram < 0
    )
      return "unknown";
    return loaded.size_vram > 0 ? "gpu" : "cpu";
  } catch {
    if (signal.aborted)
      throw new ReaderError(
        "Okuma iptal edildi veya süre sınırına ulaştı.",
        504,
      );
    return "unknown"; // Missing backend evidence keeps the legacy full-table path.
  }
}

export async function readLocalPaper(
  image: string,
  checkMode: CheckMode,
  signal: AbortSignal,
  regions?: PaperRegions,
  compactImage?: string,
  questionCount = 5,
  prepared?: PreparedPaper,
): Promise<ScanOutput> {
  if (!validQuestionCount(questionCount))
    throw new ReaderError("Geçersiz soru sayısı.", 400);
  if (busy)
    throw new ReaderError(
      "Başka bir kâğıt okunuyor. Tamamlanınca yeniden deneyin.",
      409,
    );
  busy = true;
  const started = Date.now();
  try {
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(checkMode === "double" ? 240_000 : 120_000),
    ]);
    const automatic =
      regions &&
      compactImage &&
      model() === "qwen3.5:4b" &&
      process.env.SCANEXAM_FAST_READING !== "off" &&
      process.env.SCANEXAM_REGION_READING === undefined;
    const backend = automatic ? await loadedBackend(bounded) : "unknown";
    const read = async (verify = false): Promise<ScanOutput> => {
      if (model() === "glm-ocr-eot:q8_0") {
        const paper = prepared ?? await prepareServerPaper(Buffer.from(image, "base64"), questionCount);
        return readGlmRegions(paper, questionCount, async (part, prompt) => {
          let response: Response;
          try {
            response = await fetch(`${serviceUrl()}/api/generate`, { method: "POST", signal: bounded,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: model(), prompt, images: [part], stream: false, keep_alive: "30m",
                options: { temperature: 0, num_ctx: 4096, num_predict: prompt === "Text Recognition:" ? 128 : Math.max(900, questionCount * 70 + 240),
                  ...(process.env.SCANEXAM_READER_THREADS ? { num_thread: Math.max(1, Math.min(64, Number(process.env.SCANEXAM_READER_THREADS) || 4)) } : {}),
                } }),
            });
          } catch {
            throw new ReaderError(bounded.aborted ? "Okuma iptal edildi veya süre sınırına ulaştı." : "Yerel GLM okuyucuya ulaşılamadı.", bounded.aborted ? 504 : 503);
          }
          if (!response.ok) throw new ReaderError("Yerel GLM modeli görüntüyü okuyamadı.", response.status === 404 ? 503 : 502);
          const result = await response.json() as { done?: boolean; done_reason?: string; response?: string };
          if (!result.done || result.done_reason === "length" || typeof result.response !== "string")
            throw new ReaderError("GLM okuması tamamlanamadı; kısmi sonuç kaydedilmedi.", 502);
          return result.response;
        });
      }
      if (automatic && backend === "cpu")
        return {
          ...(await transcribe(compactImage!, bounded, verify, questionCount)),
          readingStrategy: "compact-table",
        };
      if (
        !regions ||
        model() !== "qwen3.5:4b" ||
        !(
          (automatic && backend === "gpu") ||
          process.env.SCANEXAM_REGION_READING === "on"
        )
      )
        return transcribe(image, bounded, verify, questionCount);
      let fallbackStarted = false;
      try {
        const { output: regional, parts } = await transcribeRegions(
          regions,
          bounded,
          verify,
          questionCount,
        );
        if (
          regional.reviewFields?.some(
            (field) =>
              /^s\d+$/.test(field) ||
              field === "writtenTotal" ||
              field === "pcMap",
          )
        ) {
          fallbackStarted = true;
          const full = await transcribe(image, bounded, verify, questionCount);
          const previousNumbers = mergeRegionReadings(
            {
              student: {
                fullName: full.fullName,
                studentNumber: full.studentNumber,
                uncertainFields: [],
              },
              course: {
                courseCode: full.courseCode || "",
                courseName: full.courseName || "",
                uncertainFields: [],
              },
              scores: parts.scores,
            },
            questionCount,
          );
          const comparison = compareReadings(full, previousNumbers);
          return {
            ...comparison,
            checkMode: "single",
            readingStrategy: "full-table",
            warnings: [
              ...new Set([
                ...(full.warnings || []),
                "Sayısal bölge eksik, belirsiz veya tutarsızdı; özgün tam tablo istemiyle yeniden okundu. Farklı değerler alternatif olarak gösterildi; değerler aritmetik ile düzeltilmedi.",
              ]),
            ],
          };
        }
        return regional;
      } catch (error) {
        if (
          fallbackStarted ||
          bounded.aborted ||
          (error instanceof ReaderError && error.status === 503)
        )
          throw error;
        const full = await transcribe(image, bounded, verify, questionCount);
        return {
          ...full,
          warnings: [
            ...(full.warnings || []),
            "Bölgesel okuma tamamlanamadı; üst tablo bütünüyle yeniden okundu. Değerler aritmetik ile düzeltilmedi.",
          ],
        };
      }
    };
    const first = await read();
    let result: ScanOutput = { ...first, checkMode };
    if (checkMode === "double") {
      try {
        const second = await read(true);
        result = {
          ...compareReadings(first, second),
          readingStrategy:
            first.readingStrategy === second.readingStrategy
              ? first.readingStrategy
              : "mixed",
        };
      } catch (error) {
        if (signal.aborted) throw error;
        result = {
          ...first,
          checkMode: "single",
          reviewFields: [
            ...new Set([
              ...(first.reviewFields || []),
              ...fieldKeys(questionCount).filter(
                (field) =>
                  field !== "courseCode" &&
                  field !== "courseName" &&
                  field !== "pcMap",
              ),
            ]),
          ],
          warnings: [
            ...(first.warnings || []),
            "İkinci okuma tamamlanamadı. İlk sonuç korunuyor; alanları elle kontrol edin.",
          ],
        };
      }
    }
    return { ...result, elapsedMs: Date.now() - started };
  } finally {
    busy = false;
  }
}
