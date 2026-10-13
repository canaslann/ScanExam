import { normalizePaper, parseScore, sumScores } from "./reader-contract.ts";
import type { ScanOutput } from "./exam.ts";
import type { PreparedPaper } from "./paper-preparation.ts";
import { refineConfusableScores, refineExcessScores } from "./score-refinement.ts";

export function ocrText(raw: string): string {
  return raw.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/tr\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : "")
    .replace(/^```[^\n]*\n|\n```$/g, "").trim();
}
export function identityText(raw: string, field: "fullName" | "studentNumber"): string {
  // Strip only the field's printed label at the start, including observed OCR
  // label variants. Never remove letters embedded in handwritten numbers.
  const label = field === "studentNumber"
    ? /^\s*(?:Ö[ğg]renci\s*)?Numara(?:s[ıi]|r)?\s*[:|]?\s*(?=\d)/iu
    : /^\s*Ad[ıi]\s*Soyad[ıi]?(?:\s*[:|]\s*|\s+)/iu;
  const text = ocrText(raw).normalize("NFC").replace(label, "");
  const value = field === "studentNumber" ? text.replace(/\s+/g, "") : text.replace(/\s+/g, " ");
  // Do not turn a repeating/hallucinated number into a plausible prefix.
  return value.length <= (field === "fullName" ? 120 : 30) ? value : "";
}
function validIdentity(value: string, field: "fullName" | "studentNumber"): boolean {
  return field === "studentNumber" ? /^\d{5,20}$/.test(value)
    : /^[\p{L}\s'’-]+$/u.test(value) && value.includes(" ");
}
function selectIdentity(primary: string, secondary: string, field: "fullName" | "studentNumber"): string {
  return validIdentity(primary, field) ? primary : validIdentity(secondary, field) ? secondary : "";
}
function tableRows(raw: string): string[][] {
  if (/<table\b/i.test(raw)) {
    return [...raw.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map(match =>
      [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map(cell => ocrText(cell[1]).replace(/\s+/g, " ")),
    );
  }
  return raw.split(/\r?\n/).filter(line => line.includes("|")).map(line =>
    line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim()),
  ).filter(row => !row.every(cell => /^[\s:-]*$/.test(cell)));
}
export function parseGlmScores(raw: string, count: number) {
  const rows = tableRows(raw);
  const header = rows.find(row => row.some(cell => /\(?S\d+\)?\s*[-–]?\s*P\s*[ÇC]/iu.test(cell)));
  let scoreRow = rows.find(row => /^Puan\s*:?$/iu.test(row[0] || ""));
  const totalRow = rows.find(row => /^Not\s*:?$/iu.test(row[0] || ""));
  const uncertainFields: string[] = [];
  const pcMap = Array<string>(count).fill("");
  if (header?.length === count + 1) {
    for (let i = 0; i < count; i++) {
      const match = header[i + 1].match(/^\(?\s*S(\d+)\s*\)?\s*[-–]?\s*P\s*[ÇC]\s*(\d{1,2})\s*$/iu);
      if (match && Number(match[1]) === i + 1 && Number(match[2]) > 0) pcMap[i] = `PÇ${Number(match[2])}`;
    }
  }
  // Observed OCR typos in the printed Puan label must not discard correctly
  // transcribed handwriting. Recover only the uniquely labelled row directly
  // below a complete, ordered question header; never infer digits or columns.
  if (!scoreRow && header && pcMap.every(Boolean)) {
    const candidates = rows.filter(row => /^(?:Poan|Punan)\s*:?$/iu.test(row[0] || ""));
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidate && rows.indexOf(candidate) === rows.indexOf(header) + 1 && candidate.length === count + 1)
      scoreRow = candidate;
  }
  const scores = scoreRow?.length === count + 1 ? scoreRow.slice(1) : Array<string>(count).fill("");
  if (!scoreRow || scoreRow.length !== count + 1)
    uncertainFields.push(...Array.from({ length: count }, (_, i) => `s${i + 1}`));
  if (pcMap.some(pc => !pc)) uncertainFields.push("pcMap");
  return { scores, pcMap, writtenTotal: totalRow?.[1] || "", uncertainFields };
}
export function parseGlmCourse(raw: string) {
  const text = ocrText(raw).replace(/\s+/g, " ");
  const match = text.match(/^([\p{L}]{2,10}\s*\d{2,6}(?:\s*-\s*\d{2,4})?)\s*[-–:]?\s*(.+)$/u);
  return { courseCode: match?.[1].replace(/\s/g, "") || "", courseName: match?.[2] || "" };
}

/** Native OCR has no calibrated field confidence. Keep genuine crop disagreements. */
export async function readGlmRegions(
  paper: PreparedPaper,
  count: number,
  read: (image: string, prompt: "Text Recognition:" | "Table Recognition:") => Promise<string>,
  verifyScore?: (image: string) => Promise<string>,
): Promise<ScanOutput> {
  if (!paper.regions || !paper.identity)
    throw new Error("Üst formun tamamı algılanamadı. Üst form ve Puan / Not tablosunu hizalayıp yeniden tarayın.");
  const numbers = parseGlmScores(await read(paper.regions.scores, "Table Recognition:"), count);
  const uncertain = new Set(numbers.uncertainFields);
  const alternatives: Record<string, string[]> = {};
  const textRead = async (image: string, field: "fullName" | "studentNumber" | "writtenTotal") => {
    try {
      const raw = await read(image, "Text Recognition:");
      return field === "writtenTotal" ? ocrText(raw).replace(/^Not\s*:\s*/iu, "").trim() : identityText(raw, field);
    }
    catch (error) {
      // A truncated text field must not discard already completed score cells.
      // Network failure, cancellation and timeouts still stop the entire job.
      if (!error || typeof error !== "object" || !("status" in error) || error.status !== 502) throw error;
      uncertain.add(field); return "";
    }
  };
  const refineScores = (sumScores(numbers.scores) ?? 0) > 100 ? refineExcessScores : refineConfusableScores;
  const scoreCheck = await refineScores(numbers.scores, paper.scoreCells,
    async image => {
      try { return ocrText(await read(image, "Text Recognition:")).trim(); }
      catch (error) {
        if (error && typeof error === "object" && "status" in error && error.status === 502) return "";
        throw error;
      }
    }, verifyScore);
  numbers.scores = scoreCheck.scores;
  Object.assign(alternatives, scoreCheck.alternatives);
  scoreCheck.reviewFields.forEach(field => uncertain.add(field));
  // Arithmetic can trigger an independent check, never choose its answer.
  // A valid first total is retained even if a retry matches the score sum.
  const firstTotal = parseScore(numbers.writtenTotal);
  const scoreSum = sumScores(numbers.scores);
  const mismatchedTotal = firstTotal !== null && scoreSum !== null && Math.abs(firstTotal - scoreSum) > 0.001;
  if ((firstTotal === null || mismatchedTotal) && paper.totalImage) {
    uncertain.add("writtenTotal");
    const candidates = [numbers.writtenTotal];
    let candidate = await textRead(paper.totalImage, "writtenTotal");
    candidates.push(candidate);
    if (parseScore(candidate) === null && paper.totalContrastImage) {
      candidate = await textRead(paper.totalContrastImage, "writtenTotal");
      candidates.push(candidate);
    }
    if (firstTotal === null && parseScore(candidate) !== null) numbers.writtenTotal = candidate;
    alternatives.writtenTotal = [...new Set(candidates.filter(Boolean))];
  }
  // Two isolated cells prevent a number-only response from dropping the name.
  // Zoom preserves color/strokes; it adds no actual optical detail.
  const nameZoom = await textRead(paper.identity.fullNameZoom, "fullName");
  const nameLabelled = await textRead(paper.identity.fullNameLabelled, "fullName");
  const numberLabelled = await textRead(paper.identity.studentNumberLabelled, "studentNumber");
  const numberZoom = await textRead(paper.identity.studentNumberZoom, "studentNumber");
  const fullName = selectIdentity(nameZoom, nameLabelled, "fullName");
  // The isolated handwriting avoids printed-label contamination. A labelled
  // read is a fallback only; numeric disagreements still require review.
  const studentNumber = selectIdentity(numberZoom, numberLabelled, "studentNumber");
  const course = parseGlmCourse(await read(paper.regions.course, "Text Recognition:"));
  for (const [key, a, b] of [["fullName", nameZoom, nameLabelled], ["studentNumber", numberLabelled, numberZoom]]) {
    if (a.toLocaleLowerCase("tr-TR") !== b.toLocaleLowerCase("tr-TR")) {
      uncertain.add(key);
      alternatives[key] = [...new Set([a, b].filter(Boolean))];
    }
  }
  // Typed field gates do not guess character substitutions. Invalid native
  // text stays visible as an alternative, never as a name/number/score value.
  const reject = (field: string, value: string) => {
    uncertain.add(field);
    alternatives[field] = [...new Set([...(alternatives[field] || []), value].filter(Boolean))];
  };
  if (!fullName) { reject("fullName", nameZoom); reject("fullName", nameLabelled); }
  if (!studentNumber) { reject("studentNumber", numberLabelled); reject("studentNumber", numberZoom); }
  numbers.scores = numbers.scores.map((value, i) => {
    if (parseScore(value) !== null) return value;
    reject(`s${i + 1}`, value); return "";
  });
  if (parseScore(numbers.writtenTotal) === null) {
    reject("writtenTotal", numbers.writtenTotal); numbers.writtenTotal = "";
  }
  const output = normalizePaper({ fullName, studentNumber, ...numbers, ...course, uncertainFields: [...uncertain] }, count);
  return { ...output, alternatives, readingStrategy: "regions",
    warnings: [...(output.warnings || []), ...(alternatives.fullName || alternatives.studentNumber
      ? ["İsim/numaranın hücre ve etiketli kırpım okumaları farklı veya eksik. Alternatifleri fotoğrafla kontrol edin; isim/numara hiçbir listeyle tamamlanmadı."] : []),
      ...(alternatives.writtenTotal ? ["Yazılı toplam eksik, geçersiz veya puanlarla farklıydı; Not hücresi bağımsız yeniden okundu. Geçerli ilk toplam ve alternatifler korundu; fotoğrafla onaylayın."] : []),
      ...scoreCheck.warnings,
      "GLM-OCR yerel okuması; model alan bazında ölçülmüş güven yüzdesi vermez."],
  };
}
