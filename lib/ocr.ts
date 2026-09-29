import type { ExamState, ScanOutput } from "@/lib/exam";

type ProgressCallback = (progress: number, label: string) => void;
type Region = { x: number; y: number; w: number; h: number };

const REGIONS: Record<string, Region> = {
  course: { x: 0.165, y: 0.405, w: 0.315, h: 0.09 },
  fullName: { x: 0.545, y: 0.295, w: 0.30, h: 0.125 },
  studentNumber: { x: 0.545, y: 0.415, w: 0.30, h: 0.09 },
  pcHeader: { x: 0.125, y: 0.785, w: 0.50, h: 0.08 },
  s1: { x: 0.125, y: 0.855, w: 0.10, h: 0.075 },
  s2: { x: 0.225, y: 0.855, w: 0.10, h: 0.075 },
  s3: { x: 0.325, y: 0.855, w: 0.10, h: 0.075 },
  s4: { x: 0.425, y: 0.855, w: 0.10, h: 0.075 },
  s5: { x: 0.525, y: 0.855, w: 0.10, h: 0.075 },
  total: { x: 0.125, y: 0.925, w: 0.50, h: 0.07 },
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

function normalizedTop(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = 1400;
  canvas.height = 600;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Görüntü işleme başlatılamadı.");

  const portrait = image.naturalHeight > image.naturalWidth * 0.95;
  const sourceY = portrait ? image.naturalHeight * 0.025 : 0;
  const desiredHeight = image.naturalWidth / 2.33;
  const sourceHeight = portrait
    ? Math.min(desiredHeight, image.naturalHeight - sourceY)
    : image.naturalHeight;

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

function crop(source: HTMLCanvasElement, region: Region, redInk = true) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(520, Math.round(source.width * region.w * 3));
  canvas.height = Math.max(130, Math.round(source.height * region.h * 3));
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
  for (let index = 0; index < pixels.data.length; index += 4) {
    const r = pixels.data[index];
    const g = pixels.data[index + 1];
    const b = pixels.data[index + 2];
    let value: number;
    if (redInk) {
      const redDifference = r - (g + b) / 2;
      value = 255 - Math.max(0, Math.min(255, (redDifference + 5) * 8));
    } else {
      value = Math.max(0, Math.min(255, (r * 0.3 + g * 0.59 + b * 0.11 - 90) * 2.2));
    }
    pixels.data[index] = value;
    pixels.data[index + 1] = value;
    pixels.data[index + 2] = value;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

function cleanNumber(text: string) {
  return text.replace(/[^0-9,.-]/g, "").replace(/^[.,-]+|[.,-]+$/g, "");
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
  return {
    courseCode: match[1].replace(/\s+/g, "").toLocaleUpperCase("tr-TR"),
    courseName: match[2].replace(/[^A-Za-zÇĞİÖŞÜçğıöşü\s-]/g, " ").replace(/\s+/g, " ").trim(),
  };
}

function parsePcMap(text: string): ExamState["pcMap"] | undefined {
  const matches = [...text.toLocaleUpperCase("tr-TR").matchAll(/P\s*[ÇC]\s*[-:]?\s*([1-5])/g)];
  if (matches.length !== 5) return undefined;
  return matches.map((match) => `PÇ${match[1]}`) as ExamState["pcMap"];
}

export async function readExamPaper(file: File, onProgress: ProgressCallback): Promise<ScanOutput> {
  const image = await loadImage(file);
  const source = normalizedTop(image);
  onProgress(0.08, "Görüntü alanlara ayrılıyor");

  const { createWorker, PSM } = await import("tesseract.js");
  const textWorkerPromise = createWorker("tur", undefined, {
    logger: (message) => {
      if (message.status === "recognizing text") onProgress(0.12 + message.progress * 0.28, "Ad soyad okunuyor");
    },
  });
  const numberWorkerPromise = createWorker("eng", undefined, {
    logger: (message) => {
      if (message.status === "recognizing text") onProgress(0.42 + message.progress * 0.5, "Numara ve puanlar okunuyor");
    },
  });

  const [textWorker, numberWorker] = await Promise.all([textWorkerPromise, numberWorkerPromise]);
  try {
    await textWorker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      preserve_interword_spaces: "1",
    });
    await numberWorker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      tessedit_char_whitelist: "0123456789,.-",
    });

    const textPromise = (async () => {
      const course = await textWorker.recognize(crop(source, REGIONS.course, false));
      const pcHeader = await textWorker.recognize(crop(source, REGIONS.pcHeader, false));
      const name = await textWorker.recognize(crop(source, REGIONS.fullName));
      return { course, pcHeader, name };
    })();
    const numberKeys = ["studentNumber", "s1", "s2", "s3", "s4", "s5", "total"] as const;
    const numericResults: Array<{ text: string; confidence: number }> = [];
    for (let index = 0; index < numberKeys.length; index += 1) {
      const key = numberKeys[index];
      const result = await numberWorker.recognize(crop(source, REGIONS[key]));
      numericResults.push({ text: cleanNumber(result.data.text), confidence: result.data.confidence });
      onProgress(0.45 + ((index + 1) / numberKeys.length) * 0.45, `${index + 1}/${numberKeys.length} sayısal alan okundu`);
    }
    const textResults = await textPromise;
    const course = parseCourse(textResults.course.data.text);

    onProgress(0.97, "Sonuçlar hazırlanıyor");
    return {
      ...course,
      pcMap: parsePcMap(textResults.pcHeader.data.text),
      fullName: cleanName(textResults.name.data.text),
      studentNumber: numericResults[0].text,
      scores: [numericResults[1].text, numericResults[2].text, numericResults[3].text, numericResults[4].text, numericResults[5].text],
      writtenTotal: numericResults[6].text,
      confidence: {
        fullName: textResults.name.data.confidence,
        studentNumber: numericResults[0].confidence,
        s1: numericResults[1].confidence,
        s2: numericResults[2].confidence,
        s3: numericResults[3].confidence,
        s4: numericResults[4].confidence,
        s5: numericResults[5].confidence,
        writtenTotal: numericResults[6].confidence,
      },
    };
  } finally {
    await Promise.all([textWorker.terminate(), numberWorker.terminate()]);
  }
}
