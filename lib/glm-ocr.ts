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
export function parseGlmScores(raw: string, count: number, measuredGrid = false) {
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
  if (!scoreRow && header && (pcMap.every(Boolean) || (measuredGrid && header.length === count + 1))) {
    const candidates = rows.filter(row => /^(?:Poan|Punan|Pam|Pun)\s*:?$/iu.test(row[0] || ""));
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

/** Read the model's literal document transcription without requiring fixed crop coordinates. */
export function parseGlmDocument(raw: string, count: number): ScanOutput {
  const lines = ocrText(raw.replace(/<\/t[dh]\s*>/gi, "\n")).split(/\r?\n/)
    .map(line => line.replace(/^[#*\s]+|[*\s]+$/g, "").trim()).filter(Boolean);
  const alternatives: Record<string, string[]> = {};
  const field = (label: RegExp, key: string) => {
    const candidates = lines.flatMap((line, i) => {
      const match = line.match(label);
      if (!match) return [];
      const value = line.slice(match[0].length).trim() || lines[i + 1] || "";
      return [value.replace(/\s+(?:İmza|Imza|Numarası|Numarasi)\b.*$/iu, "").trim()];
    }).filter(Boolean);
    const unique = [...new Set(candidates)];
    if (unique.length) alternatives[key] = unique;
    return unique.length === 1 ? unique[0] : "";
  };
  const name = field(/^Ad[ıi]\s+S\S*\s*[:：]?\s*/iu, "fullName");
  const number = field(/^(?:Ö[ğg]renci\s*)?Numara(?:s[ıi]|r)?\s*[:：]?\s*/iu, "studentNumber").replace(/\s+/g, "");
  const course = parseGlmCourse(field(/^Dersin\s+Kodu\s+ve\s+Ad[ıi]\s*[:：]?\s*/iu, "course"));
  const numbers = parseGlmScores(raw, count);
  // Text Recognition can emit plain lines instead of HTML/Markdown tables.
  // Accept exactly one explicitly labelled row with exactly the configured
  // number of literal tokens. Never pad missing columns or shift question IDs.
  const orderedHeaders = [...ocrText(raw).matchAll(/\(?S(\d+)\)?\s*[-–]?\s*P\s*[ÇC]\s*(\d{1,2})/giu)];
  const hasOrderedHeaders = orderedHeaders.length === count
    && orderedHeaders.every((match, i) => Number(match[1]) === i + 1 && Number(match[2]) > 0);
  const scoreLabel = hasOrderedHeaders ? /^P(?:uan|oan|unan)(?:\s*[:：]|\s|$)/iu : /^Puan(?:\s*[:：]|\s|$)/iu;
  const scoreStarts = lines.flatMap((line, i) => scoreLabel.test(line) ? [i] : []);
  if (numbers.scores.every(value => !value) && scoreStarts.length === 1) {
    const start = scoreStarts[0];
    const end = lines.findIndex((line, i) => i > start && /^Not\b\s*[:：]?/iu.test(line));
    if (end > start) {
      const tokens = [lines[start].replace(/^P(?:uan|oan|unan)\s*[:：]?\s*/iu, ""), ...lines.slice(start + 1, end)]
        .join(" ").trim().split(/\s+/).filter(Boolean);
      if (tokens.length === count) numbers.scores = tokens;
    }
  }
  const totals = lines.flatMap((line, i) => {
    const match = line.match(/^Not\s*[:：]?\s*/iu);
    return match ? [line.slice(match[0].length).trim() || lines[i + 1] || ""] : [];
  });
  if (!numbers.writtenTotal && totals.length === 1) numbers.writtenTotal = totals[0];
  if (numbers.pcMap.some(value => !value)) {
    const headers = [...ocrText(raw).matchAll(/\(?S(\d+)\)?\s*[-–]?\s*P\s*[ÇC]\s*(\d{1,2})/giu)];
    if (headers.length === count && headers.every((match, i) => Number(match[1]) === i + 1 && Number(match[2]) > 0))
      numbers.pcMap = headers.map(match => `PÇ${Number(match[2])}`);
  }
  const cleanNumber = (value: string, key: string) => {
    if (parseScore(value) !== null) return value;
    if (value) alternatives[key] = [value];
    // A faint erased total and its darker rewrite can be transcribed twice.
    // Keep an identical multi-digit literal once, with the original as an
    // alternative for review. Different values and separated single digits
    // remain ambiguous; never choose by the sum of question scores.
    if (key === "writtenTotal") {
      const repeated = value.trim().split(/\s+/);
      if (repeated.length > 1 && /^\d{2,3}$/.test(repeated[0])
        && repeated.every(token => token === repeated[0]) && parseScore(repeated[0]) !== null)
        return repeated[0];
    }
    return "";
  };
  const output = normalizePaper({
    fullName: validIdentity(name, "fullName") ? name : "",
    studentNumber: validIdentity(number, "studentNumber") ? number : "",
    ...course, pcMap: numbers.pcMap,
    scores: numbers.scores.map((value, i) => cleanNumber(value, `s${i + 1}`)),
    writtenTotal: cleanNumber(numbers.writtenTotal, "writtenTotal"),
    uncertainFields: ["fullName", "studentNumber", "writtenTotal", ...Array.from({ length: count }, (_, i) => `s${i + 1}`)],
  }, count);
  return { ...output, alternatives, readingStrategy: "full-table", warnings: [...(output.warnings || []),
    "Serbest fotoğraf: alanlar tam sayfa okumasından bulundu. Sabit hücre kırpımıyla ek kontrol yapılamadı; sonuçları kaynak fotoğrafla karşılaştırın."] };
}

/** Native OCR has no calibrated field confidence. Keep genuine crop disagreements. */
export async function readGlmRegions(
  paper: PreparedPaper,
  count: number,
  read: (image: string, prompt: "Text Recognition:" | "Table Recognition:", maxTokens?: number) => Promise<string>,
  verifyScore?: (image: string) => Promise<string>,
  detailed = true,
): Promise<ScanOutput> {
  if (!paper.regions || !paper.identity)
    return parseGlmDocument(await read(paper.documentImage || paper.image, "Text Recognition:", Math.max(1800, count * 70 + 900)), count);
  let tableText = "";
  try { tableText = await read(paper.regions.scores, "Table Recognition:"); }
  catch (error) {
    if (!error || typeof error !== "object" || !("status" in error) || error.status !== 502) throw error;
    // A malformed/truncated table can still yield usable positional cells.
    // Connection failures and cancellation must continue to stop the job.
  }
  const numbers = parseGlmScores(tableText, count);
  const uncertain = new Set(numbers.uncertainFields);
  const alternatives: Record<string, string[]> = {};
  const textRead = async (image: string, field: "fullName" | "studentNumber" | "writtenTotal" | `s${number}`) => {
    try {
      const raw = await read(image, "Text Recognition:");
      return field === "fullName" || field === "studentNumber" ? identityText(raw, field)
        : ocrText(raw).replace(/^(?:Not|Puan)\s*:\s*/iu, "").trim();
    }
    catch (error) {
      // A truncated text field must not discard already completed score cells.
      // Network failure, cancellation and timeouts still stop the entire job.
      if (!error || typeof error !== "object" || !("status" in error) || error.status !== 502) throw error;
      uncertain.add(field); return "";
    }
  };
  let rowReadings: string[] | undefined;
  const incompleteScores = numbers.scores.some(value => parseScore(value) === null);
  if (paper.scoreRowImage && (detailed || incompleteScores) && (sumScores(numbers.scores) ?? 0) <= 100) {
    try {
      const row = ocrText(await read(paper.scoreRowImage, "Text Recognition:", Math.max(64, count * 10)))
        .replace(/^Puan\s*:?\s*/iu, "").trim().split(/[|\s]+/).filter(Boolean);
      if (row.length === count && row.every(value => parseScore(value) !== null)) rowReadings = row;
    } catch (error) {
      if (!error || typeof error !== "object" || !("status" in error) || error.status !== 502) throw error;
    }
  }
  // An exact, positional row can recover missing table cells. Never shift a
  // shorter row into place or replace a valid primary score without evidence.
  if (rowReadings && incompleteScores) {
    numbers.scores = numbers.scores.map((value, i) => {
      if (parseScore(value) !== null) return value;
      const key = `s${i + 1}`;
      uncertain.add(key);
      alternatives[key] = [...new Set([value, rowReadings![i]].filter(Boolean))];
      return rowReadings![i];
    });
  }
  if (incompleteScores && paper.scoreCells?.length === count) {
    for (let i = 0; i < count; i++) {
      if (parseScore(numbers.scores[i]) !== null) continue;
      const key = `s${i + 1}`;
      const candidates = [numbers.scores[i]];
      for (const image of [paper.scoreCells[i].color, paper.scoreCells[i].padded]) {
        const candidate = await textRead(image, `s${i + 1}`);
        candidates.push(candidate);
        if (parseScore(candidate) !== null) { numbers.scores[i] = candidate; break; }
      }
      if (!detailed && !numbers.scores[i])
        numbers.scores[i] = candidates.find(value => /\d/.test(value) && value.length <= 20) || "";
      uncertain.add(key);
      alternatives[key] = [...new Set(candidates.filter(Boolean))];
    }
  }
  const consistentTotal = parseScore(numbers.writtenTotal) !== null
    && sumScores(numbers.scores) === parseScore(numbers.writtenTotal);
  const refineScores = (sumScores(numbers.scores) ?? 0) > 100 ? refineExcessScores : refineConfusableScores;
  const scoreCheck = detailed
    ? await refineScores(numbers.scores, paper.scoreCells,
    async image => {
      try { return ocrText(await read(image, "Text Recognition:")).trim(); }
      catch (error) {
        if (error && typeof error === "object" && "status" in error && error.status === 502) return "";
        throw error;
      }
    }, verifyScore, consistentTotal ? rowReadings : undefined)
    : { scores: numbers.scores, alternatives: {}, reviewFields: [], warnings: [] };
  numbers.scores = scoreCheck.scores;
  Object.assign(alternatives, scoreCheck.alternatives);
  scoreCheck.reviewFields.forEach(field => uncertain.add(field));
  // Arithmetic can trigger an independent check, never choose its answer.
  // A valid first total is retained even if a retry matches the score sum.
  const firstTotal = parseScore(numbers.writtenTotal);
  const scoreSum = sumScores(numbers.scores);
  const mismatchedTotal = firstTotal !== null && scoreSum !== null && Math.abs(firstTotal - scoreSum) > 0.001;
  if ((firstTotal === null || (detailed && mismatchedTotal)) && paper.totalImage) {
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
  const numberZoom = await textRead(paper.identity.studentNumberZoom, "studentNumber");
  const numberLabelled = await textRead(paper.identity.studentNumberLabelled, "studentNumber");
  const fullName = selectIdentity(nameZoom, nameLabelled, "fullName")
    || (!detailed ? nameZoom || nameLabelled : "");
  // The isolated handwriting avoids printed-label contamination. A labelled
  // read is a fallback only; numeric disagreements still require review.
  const studentNumber = selectIdentity(numberZoom, numberLabelled, "studentNumber")
    || (!detailed ? numberZoom || numberLabelled : "");
  const course = parseGlmCourse(await read(paper.regions.course, "Text Recognition:"));
  for (const [key, a, b] of [["fullName", nameZoom, nameLabelled], ["studentNumber", numberLabelled, numberZoom]]) {
    if (a.toLocaleLowerCase("tr-TR") !== b.toLocaleLowerCase("tr-TR")) {
      uncertain.add(key);
      alternatives[key] = [...new Set([a, b].filter(Boolean))];
    }
  }
  // Fast reading retains literal imperfect transcriptions for manual review;
  // validation must not turn a populated cell into an empty one.
  const reject = (field: string, value: string) => {
    uncertain.add(field);
    alternatives[field] = [...new Set([...(alternatives[field] || []), value].filter(Boolean))];
  };
  if (!fullName) { reject("fullName", nameZoom); reject("fullName", nameLabelled); }
  if (!studentNumber) { reject("studentNumber", numberLabelled); reject("studentNumber", numberZoom); }
  numbers.scores = numbers.scores.map((value, i) => {
    if (parseScore(value) !== null) return value;
    reject(`s${i + 1}`, value); return detailed ? "" : value;
  });
  if (parseScore(numbers.writtenTotal) === null) {
    reject("writtenTotal", numbers.writtenTotal);
    if (detailed) numbers.writtenTotal = "";
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
