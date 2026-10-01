import type { ExamState, ScanOutput } from "@/lib/exam";

type ProgressCallback = (progress: number, label: string) => void;
type Region = { x: number; y: number; w: number; h: number };
type InkMode = "binary" | "contrast" | "red";
type OcrCandidate = { text: string; confidence: number; mode?: InkMode };

const TEMPLATE_WIDTH = 1400;
const TEMPLATE_HEIGHT = 600;

// Koordinatlar, kâğıdın üst yatay çizgisinden Soru–PÇ tablosunun altına
// kadar olan sabit şablona göredir. Hücre kenarları daha sonra temizlenir.
const REGIONS: Record<string, Region> = {
  course: { x: 0.165, y: 0.395, w: 0.315, h: 0.095 },
  fullName: { x: 0.555, y: 0.30, w: 0.25, h: 0.105 },
  studentNumber: { x: 0.552, y: 0.39, w: 0.26, h: 0.09 },
  pcHeader: { x: 0.125, y: 0.755, w: 0.49, h: 0.09 },
  s1: { x: 0.125, y: 0.825, w: 0.10, h: 0.095 },
  s2: { x: 0.225, y: 0.825, w: 0.10, h: 0.095 },
  s3: { x: 0.325, y: 0.825, w: 0.10, h: 0.095 },
  s4: { x: 0.425, y: 0.825, w: 0.10, h: 0.095 },
  s5: { x: 0.525, y: 0.825, w: 0.10, h: 0.095 },
  total: { x: 0.125, y: 0.90, w: 0.50, h: 0.095 },
};

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Görüntü açılamadı.")); };
    image.src = url;
  });
}

function luminance(r: number, g: number, b: number) {
  return r * 0.299 + g * 0.587 + b * 0.114;
}

function detectTemplateTop(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  const scale = canvas.width / image.naturalWidth;
  canvas.height = Math.min(
    Math.round(image.naturalHeight * scale),
    Math.round(canvas.width * 0.65),
  );
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return image.naturalHeight * 0.025;
  ctx.drawImage(
    image,
    0,
    0,
    image.naturalWidth,
    canvas.height / scale,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const startX = Math.round(canvas.width * 0.015);
  const endX = Math.round(canvas.width * 0.985);
  const requiredDarkPixels = canvas.width * 0.17;
  const searchEnd = Math.min(canvas.height, Math.round(canvas.width * 0.24));

  for (let y = 2; y < searchEnd; y += 1) {
    let darkPixels = 0;
    for (let x = startX; x < endX; x += 1) {
      const index = (y * canvas.width + x) * 4;
      if (luminance(pixels[index], pixels[index + 1], pixels[index + 2]) < 150) darkPixels += 1;
    }
    if (darkPixels >= requiredDarkPixels) return y / scale;
  }
  return image.naturalHeight * 0.025;
}

function normalizedTop(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = TEMPLATE_WIDTH;
  canvas.height = TEMPLATE_HEIGHT;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Görüntü işleme başlatılamadı.");

  const detectedTop = detectTemplateTop(image);
  const sourceY = Math.max(0, detectedTop - image.naturalWidth * 0.01);
  const topSectionHeight = image.naturalWidth * 0.40;
  const sourceHeight = image.naturalHeight / image.naturalWidth < 0.48
    ? image.naturalHeight
    : Math.min(topSectionHeight, image.naturalHeight - sourceY);

  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    image,
    0,
    sourceY,
    image.naturalWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

function otsuThreshold(histogram: Uint32Array, total: number) {
  let weightedTotal = 0;
  for (let value = 0; value < 256; value += 1) weightedTotal += value * histogram[value];

  let backgroundWeight = 0;
  let backgroundTotal = 0;
  let bestVariance = -1;
  let threshold = 160;
  for (let value = 0; value < 256; value += 1) {
    backgroundWeight += histogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundTotal += value * histogram[value];
    const backgroundMean = backgroundTotal / backgroundWeight;
    const foregroundMean = (weightedTotal - backgroundTotal) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = value;
    }
  }
  return Math.max(105, Math.min(220, threshold + 10));
}

function crop(source: HTMLCanvasElement, region: Region, mode: InkMode, removeGridLines = true) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(520, Math.round(source.width * region.w * 3));
  canvas.height = Math.max(150, Math.round(source.height * region.h * 3));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Alan işlenemedi.");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    source,
    source.width * region.x,
    source.height * region.y,
    source.width * region.w,
    source.height * region.h,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const histogram = new Uint32Array(256);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const gray = Math.round(luminance(pixels.data[index], pixels.data[index + 1], pixels.data[index + 2]));
    histogram[gray] += 1;
  }
  const threshold = otsuThreshold(histogram, canvas.width * canvas.height);

  for (let index = 0; index < pixels.data.length; index += 4) {
    const r = pixels.data[index];
    const g = pixels.data[index + 1];
    const b = pixels.data[index + 2];
    const gray = luminance(r, g, b);
    let value: number;
    if (mode === "red") {
      const redDifference = r - (g + b) / 2;
      value = 255 - Math.max(0, Math.min(255, (redDifference - 5) * 11));
    } else if (mode === "contrast") {
      const lowerBound = Math.max(55, threshold - 75);
      value = Math.max(0, Math.min(255, ((gray - lowerBound) / Math.max(45, threshold - lowerBound)) * 255));
    } else {
      value = gray <= threshold ? 0 : 255;
    }
    pixels.data[index] = value;
    pixels.data[index + 1] = value;
    pixels.data[index + 2] = value;
  }

  if (removeGridLines) {
    // Hücrenin yatay ve dikey cetvel çizgilerini, rakamlara değseler bile kaldır.
    const rowsToClear = new Set<number>();
    const rowRadius = Math.max(2, Math.round(canvas.height * 0.018));
    for (let y = 0; y < canvas.height; y += 1) {
      let dark = 0;
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels.data[(y * canvas.width + x) * 4] < 110) dark += 1;
      }
      if (dark > canvas.width * 0.55) {
        for (let offset = -rowRadius; offset <= rowRadius; offset += 1) rowsToClear.add(y + offset);
      }
    }
    const columnsToClear = new Set<number>();
    const columnRadius = Math.max(2, Math.round(canvas.width * 0.004));
    for (let x = 0; x < canvas.width; x += 1) {
      let dark = 0;
      for (let y = 0; y < canvas.height; y += 1) {
        if (pixels.data[(y * canvas.width + x) * 4] < 110) dark += 1;
      }
      if (dark > canvas.height * 0.88) {
        for (let offset = -columnRadius; offset <= columnRadius; offset += 1) columnsToClear.add(x + offset);
      }
    }
    for (const y of rowsToClear) {
      if (y < 0 || y >= canvas.height) continue;
      for (let x = 0; x < canvas.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        pixels.data[index] = 255;
        pixels.data[index + 1] = 255;
        pixels.data[index + 2] = 255;
      }
    }
    for (const x of columnsToClear) {
      if (x < 0 || x >= canvas.width) continue;
      for (let y = 0; y < canvas.height; y += 1) {
        const index = (y * canvas.width + x) * 4;
        pixels.data[index] = 255;
        pixels.data[index + 1] = 255;
        pixels.data[index + 2] = 255;
      }
    }
  }

  // Sabit tablonun kenar çizgileri OCR tarafından 1/7 gibi algılanmasın.
  const borderX = Math.max(5, Math.round(canvas.width * 0.018));
  const borderY = Math.max(5, Math.round(canvas.height * 0.055));
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (x >= borderX && x < canvas.width - borderX && y >= borderY && y < canvas.height - borderY) continue;
      const index = (y * canvas.width + x) * 4;
      pixels.data[index] = 255;
      pixels.data[index + 1] = 255;
      pixels.data[index + 2] = 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

function hasRedInk(source: HTMLCanvasElement, region: Region) {
  const ctx = source.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  const x = Math.max(0, Math.round(source.width * region.x));
  const y = Math.max(0, Math.round(source.height * region.y));
  const width = Math.min(source.width - x, Math.max(1, Math.round(source.width * region.w)));
  const height = Math.min(source.height - y, Math.max(1, Math.round(source.height * region.h)));
  const pixels = ctx.getImageData(x, y, width, height).data;
  let sampled = 0;
  let redPixels = 0;
  for (let index = 0; index < pixels.length; index += 16) {
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    sampled += 1;
    if (r - (g + b) / 2 > 12 && r > g + 10 && r > b + 10) redPixels += 1;
  }
  return redPixels > Math.max(10, sampled * 0.002);
}

function cleanNumber(text: string) {
  return text.replace(/[^0-9,.-]/g, "").replace(/^[.,-]+|[.,-]+$/g, "");
}

function normalizeCandidateNumber(text: string, kind: "student" | "score") {
  const cleaned = cleanNumber(text);
  if (kind === "student") return cleaned.replace(/\D/g, "");
  let normalized = cleaned;
  while (/^\d{3,}1$/.test(normalized)) {
    const withoutBorder = normalized.slice(0, -1);
    if (Number(withoutBorder) <= 100) return withoutBorder;
    normalized = withoutBorder;
  }
  return cleaned;
}

function cleanName(text: string) {
  return text
    .replace(/[^A-Za-zÇĞİÖŞÜçğıöşü\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase("tr-TR"));
}

function parseCourse(text: string) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/([A-ZÇĞİÖŞÜ]{2,}\s*\d{2,}(?:\s*-\s*\d{2,})?)\s*[-–:]\s*(.+)/i);
  if (!match) return {};
  const courseCode = match[1]
    .replace(/\s+/g, "")
    .toLocaleUpperCase("tr-TR")
    .replaceAll("İ", "I")
    .replaceAll("Ç", "C")
    .replaceAll("Ğ", "G")
    .replaceAll("Ö", "O")
    .replaceAll("Ş", "S")
    .replaceAll("Ü", "U");
  const courseName = match[2]
    .replace(/[^A-Za-zÇĞİÖŞÜçğıöşü\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const meaningfulCourseName = courseName
    .split(" ")
    .filter((word) => Array.from(word).length > 1)
    .join(" ");
  return {
    courseCode,
    courseName: meaningfulCourseName,
  };
}

function parsePcMap(text: string): ExamState["pcMap"] | undefined {
  const matches = [...text.toLocaleUpperCase("tr-TR").matchAll(/P\s*[ÇC]\s*[-:]?\s*([1-5])/g)];
  if (matches.length !== 5) return undefined;
  return matches.map((match) => `PÇ${match[1]}`) as ExamState["pcMap"];
}

function numberCandidateScore(candidate: OcrCandidate, kind: "student" | "score") {
  const cleaned = cleanNumber(candidate.text);
  if (!cleaned) return -100;
  const digits = cleaned.replace(/\D/g, "");
  let score = candidate.confidence;
  if (kind === "student") {
    score += digits.length >= 7 && digits.length <= 14 ? 45 : -55;
    if (digits.length === 11) score += 15;
    if (candidate.mode === "contrast") score += 24;
  } else {
    const value = Number(cleaned.replace(",", "."));
    score += Number.isFinite(value) && value >= 0 && value <= 100 ? 40 : -70;
    score += digits.length <= 3 ? 10 : -35;
  }
  return score;
}

async function recognizeBestNumber(
  worker: Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>,
  source: HTMLCanvasElement,
  region: Region,
  kind: "student" | "score",
) {
  const candidates: OcrCandidate[] = [];
  const removeGridLines = kind !== "student";
  const primary = await worker.recognize(crop(source, region, "binary", removeGridLines));
  candidates.push({ text: normalizeCandidateNumber(primary.data.text, kind), confidence: primary.data.confidence, mode: "binary" });

  if (!candidates[0].text || candidates[0].confidence < 72) {
    const contrast = await worker.recognize(crop(source, region, "contrast", removeGridLines));
    candidates.push({ text: normalizeCandidateNumber(contrast.data.text, kind), confidence: contrast.data.confidence, mode: "contrast" });
    if (hasRedInk(source, region)) {
      const red = await worker.recognize(crop(source, region, "red", removeGridLines));
      candidates.push({ text: normalizeCandidateNumber(red.data.text, kind), confidence: red.data.confidence, mode: "red" });
    }
  }

  return candidates.sort((a, b) => numberCandidateScore(b, kind) - numberCandidateScore(a, kind))[0];
}

async function recognizeBestName(
  worker: Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>,
  source: HTMLCanvasElement,
) {
  const primary = await worker.recognize(crop(source, REGIONS.fullName, "binary"));
  const candidates: OcrCandidate[] = [{ text: cleanName(primary.data.text), confidence: primary.data.confidence }];
  if (candidates[0].text.length < 4 || candidates[0].confidence < 65) {
    const fallback = await worker.recognize(crop(source, REGIONS.fullName, "contrast"));
    candidates.push({ text: cleanName(fallback.data.text), confidence: fallback.data.confidence });
  }
  return candidates.sort((a, b) => {
    const aScore = a.confidence + (a.text.includes(" ") ? 12 : 0) + Math.min(a.text.length, 20);
    const bScore = b.confidence + (b.text.includes(" ") ? 12 : 0) + Math.min(b.text.length, 20);
    return bScore - aScore;
  })[0];
}

export async function readExamPaperWithTesseract(file: File, onProgress: ProgressCallback): Promise<ScanOutput> {
  const image = await loadImage(file);
  const source = normalizedTop(image);
  onProgress(0.08, "Şablon hizalandı, hücreler hazırlanıyor");

  const { createWorker, PSM } = await import("tesseract.js");
  const textWorkerPromise = createWorker("tur", undefined, {
    logger: (message) => {
      if (message.status === "recognizing text") onProgress(0.12 + message.progress * 0.25, "Metin alanları okunuyor");
    },
  });
  const numberWorkerPromise = createWorker("eng", undefined, {
    logger: (message) => {
      if (message.status === "recognizing text") onProgress(0.40 + message.progress * 0.48, "El yazısı rakamlar okunuyor");
    },
  });

  const [textWorker, numberWorker] = await Promise.all([textWorkerPromise, numberWorkerPromise]);
  try {
    await textWorker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      preserve_interword_spaces: "1",
    });
    await numberWorker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_WORD,
      tessedit_char_whitelist: "0123456789,.",
    });

    const textPromise = (async () => {
      const course = await textWorker.recognize(crop(source, REGIONS.course, "binary"));
      const pcHeader = await textWorker.recognize(crop(source, REGIONS.pcHeader, "binary"));
      const name = await recognizeBestName(textWorker, source);
      return { course, pcHeader, name };
    })();

    const numberKeys = ["studentNumber", "s1", "s2", "s3", "s4", "s5", "total"] as const;
    const numericResults: OcrCandidate[] = [];
    for (let index = 0; index < numberKeys.length; index += 1) {
      const key = numberKeys[index];
      const result = await recognizeBestNumber(
        numberWorker,
        source,
        REGIONS[key],
        key === "studentNumber" ? "student" : "score",
      );
      numericResults.push(result);
      onProgress(0.43 + ((index + 1) / numberKeys.length) * 0.46, `${index + 1}/${numberKeys.length} sayısal alan okundu`);
    }

    const textResults = await textPromise;
    const course = parseCourse(textResults.course.data.text);
    const scores = numericResults.slice(1, 6);
    const total = numericResults[6];

    onProgress(0.97, "Sonuçlar hazırlanıyor");
    return {
      ...course,
      pcMap: parsePcMap(textResults.pcHeader.data.text),
      fullName: textResults.name.text,
      studentNumber: numericResults[0].text.replace(/\D/g, ""),
      scores: [scores[0].text, scores[1].text, scores[2].text, scores[3].text, scores[4].text],
      writtenTotal: total.text,
      engine: "tesseract",
      confidence: {
        fullName: textResults.name.confidence,
        studentNumber: numericResults[0].confidence,
        s1: scores[0].confidence,
        s2: scores[1].confidence,
        s3: scores[2].confidence,
        s4: scores[3].confidence,
        s5: scores[4].confidence,
        writtenTotal: total.confidence,
      },
    };
  } finally {
    await Promise.all([textWorker.terminate(), numberWorker.terminate()]);
  }
}
