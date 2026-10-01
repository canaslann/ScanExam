import type { ScanOutput } from "@/lib/exam";
import type { CheckMode } from "@/lib/reader-contract";

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
  return canvas.toDataURL("image/jpeg", 0.94);
}

export async function readExamPaper(file: File, onProgress: ProgressCallback, options: { checkMode?: CheckMode; signal?: AbortSignal; onImagePrepared?: (image: string) => void } = {}): Promise<ScanOutput> {
  const checkMode = options.checkMode || "single";
  const image = await preparePaper(file);
  if (options.signal?.aborted) throw new DOMException("Okuma iptal edildi.", "AbortError");
  options.onImagePrepared?.(image);
  onProgress(0.15, "Üst tablo hazır; bilgisayardaki okuyucuya iletiliyor");
  const started = Date.now();
  const timer = window.setInterval(() => onProgress(0.2,
    `${checkMode === "double" ? "İki ayrı okuma ve karşılaştırma yapılıyor" : "Yazılar ve tablo alanları okunuyor"} · ${Math.round((Date.now() - started) / 1000)} sn`), 1000);
  try {
    const response = await fetch("/api/reader", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, checkMode }),
      signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(checkMode === "double" ? 250_000 : 130_000)]),
    });
    const result = await response.json() as ScanOutput & { error?: string };
    if (!response.ok) throw new Error(result.error || "Okuma tamamlanamadı.");
    onProgress(1, "Okuma tamamlandı; sonuçları fotoğrafla karşılaştırın");
    return result;
  } finally { window.clearInterval(timer); }
}
