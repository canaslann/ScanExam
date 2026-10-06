import type { ScanOutput } from "@/lib/exam";
import type { CheckMode } from "@/lib/reader-contract";
import { compactPaperHeight, detectPaperRegions, REGION_KEYS, type PaperRegions } from "@/lib/paper-regions";

type ProgressCallback = (progress: number, label: string) => void;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Görüntü açılamadı. JPEG veya PNG fotoğraf seçin.")); };
    image.src = url;
  });
}

async function preparePaper(file: File) {
  if (file.size > 25 * 1024 * 1024) throw new Error("Fotoğraf 25 MB sınırını aşıyor.");
  const image = await loadImage(file);
  if (image.naturalWidth < 300 || image.naturalHeight < 150) throw new Error("Fotoğraf çok küçük. Üst tabloyu daha yakından çekin.");
  // Preserve labels and natural pencil/red/black strokes without erasing grid lines.
  const sourceHeight = Math.min(image.naturalHeight, Math.round(image.naturalWidth * 0.6));
  const width = Math.min(1600, image.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round(sourceHeight * width / image.naturalWidth);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Fotoğraf işleme başlatılamadı.");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, image.naturalWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  const imageData = canvas.toDataURL("image/jpeg", 0.94);
  try {
    const detector = document.createElement("canvas");
    detector.width = Math.min(800, canvas.width);
    detector.height = Math.round(canvas.height * detector.width / canvas.width);
    const detectorCtx = detector.getContext("2d", { willReadFrequently: true });
    if (!detectorCtx) return { image: imageData };
    detectorCtx.drawImage(canvas, 0, 0, detector.width, detector.height);
    const boxes = detectPaperRegions(detectorCtx.getImageData(0, 0, detector.width, detector.height).data, detector.width, detector.height);
    if (!boxes) return { image: imageData };
    const regions = {} as PaperRegions;
    const scale = canvas.width / detector.width;
    const compact = document.createElement("canvas");
    compact.width = canvas.width;
    compact.height = compactPaperHeight(boxes.scores, scale, canvas.height);
    const compactCtx = compact.getContext("2d");
    if (!compactCtx) return { image: imageData };
    compactCtx.drawImage(canvas, 0, 0, compact.width, compact.height, 0, 0, compact.width, compact.height);
    const compactImage = compact.toDataURL("image/jpeg", 0.94);
    for (const name of REGION_KEYS) {
      const box = boxes[name];
      const region = document.createElement("canvas");
      region.width = Math.round(box.width * scale);
      region.height = Math.round(box.height * scale);
      const regionCtx = region.getContext("2d");
      if (!regionCtx) return { image: imageData };
      regionCtx.drawImage(canvas, Math.round(box.left * scale), Math.round(box.top * scale), region.width, region.height, 0, 0, region.width, region.height);
      regions[name] = region.toDataURL("image/jpeg", 0.94);
    }
    // Extra crops must not make a previously valid full-table upload too large.
    if (imageData.length + compactImage.length + Object.values(regions).reduce((sum, value) => sum + value.length, 0) > 8_000_000) return { image: imageData };
    return { image: imageData, regions, compactImage };
  } catch { return { image: imageData }; } // Geometry failure never prevents the original reader.
}

export async function readExamPaper(file: File, onProgress: ProgressCallback, options: { checkMode?: CheckMode; signal?: AbortSignal; onImagePrepared?: (image: string) => void } = {}): Promise<ScanOutput> {
  const checkMode = options.checkMode || "single";
  const { image, regions, compactImage } = await preparePaper(file);
  if (options.signal?.aborted) throw new DOMException("Okuma iptal edildi.", "AbortError");
  options.onImagePrepared?.(image);
  onProgress(0.15, regions ? "Tablo bölgeleri hazır; bilgisayardaki okuyucuya iletiliyor" : "Üst tablo hazır; bilgisayardaki okuyucuya iletiliyor");
  const started = Date.now();
  const timer = window.setInterval(() => onProgress(0.2,
    `${checkMode === "double" ? "İki ayrı okuma ve karşılaştırma yapılıyor" : "Yazılar ve tablo alanları okunuyor"} · ${Math.round((Date.now() - started) / 1000)} sn`), 1000);
  try {
    const response = await fetch("/api/reader", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, checkMode, ...(regions ? { regions, compactImage } : {}) }),
      signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(checkMode === "double" ? 250_000 : 130_000)]),
    });
    const result = await response.json() as ScanOutput & { error?: string };
    if (!response.ok) throw new Error(result.error || "Okuma tamamlanamadı.");
    onProgress(1, "Okuma tamamlandı; sonuçları fotoğrafla karşılaştırın");
    return result;
  } finally { window.clearInterval(timer); }
}
