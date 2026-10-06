import { normalizePaper } from "./reader-contract.ts";
import type { ScanOutput } from "./exam.ts";
import type { PreparedPaper } from "./paper-preparation.ts";

export function ocrText(raw: string): string {
  return raw.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/tr\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : "")
    .replace(/^```[^\n]*\n|\n```$/g, "").trim();
}
export function identityText(raw: string, field: "fullName" | "studentNumber"): string {
  const text = ocrText(raw).replace(/^\s*(?:Ad[ıi]\s*Soyad[ıi]|Numaras[ıi])\s*[:|]?\s*/iu, "");
  const value = field === "studentNumber" ? text.replace(/\s+/g, "") : text.replace(/\s+/g, " ");
  // Do not turn a repeating/hallucinated number into a plausible prefix.
  return value.length <= (field === "fullName" ? 120 : 30) ? value : "";
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
  const scoreRow = rows.find(row => /^Puan\s*:?$/iu.test(row[0] || ""));
  const totalRow = rows.find(row => /^Not\s*:?$/iu.test(row[0] || ""));
  const scores = scoreRow?.length === count + 1 ? scoreRow.slice(1) : Array<string>(count).fill("");
  const uncertainFields: string[] = [];
  if (!scoreRow || scoreRow.length !== count + 1)
    uncertainFields.push(...Array.from({ length: count }, (_, i) => `s${i + 1}`));
  const pcMap = Array<string>(count).fill("");
  if (header?.length === count + 1) {
    for (let i = 0; i < count; i++) {
      const match = header[i + 1].match(/^\(?\s*S(\d+)\s*\)?\s*[-–]?\s*P\s*[ÇC]\s*(\d{1,2})\s*$/iu);
      if (match && Number(match[1]) === i + 1 && Number(match[2]) > 0) pcMap[i] = `PÇ${Number(match[2])}`;
    }
  }
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
): Promise<ScanOutput> {
  if (!paper.regions || !paper.identity)
    throw new Error("Üst formun tamamı algılanamadı. Üst form ve Puan / Not tablosunu hizalayıp yeniden tarayın.");
  const numbers = parseGlmScores(await read(paper.regions.scores, "Table Recognition:"), count);
  const uncertain = new Set(numbers.uncertainFields);
  const identityRead = async (image: string, field: "fullName" | "studentNumber") => {
    try { return identityText(await read(image, "Text Recognition:"), field); }
    catch (error) {
      // A truncated identity must not discard already completed score cells.
      // Network failure, cancellation and timeouts still stop the entire job.
      if (!error || typeof error !== "object" || !("status" in error) || error.status !== 502) throw error;
      uncertain.add(field); return "";
    }
  };
  // Two isolated cells prevent a number-only response from dropping the name.
  // Zoom preserves color/strokes; it adds no actual optical detail.
  const nameZoom = await identityRead(paper.identity.fullNameZoom, "fullName");
  const nameLabelled = await identityRead(paper.identity.fullNameLabelled, "fullName");
  const numberLabelled = await identityRead(paper.identity.studentNumberLabelled, "studentNumber");
  const numberZoom = await identityRead(paper.identity.studentNumberZoom, "studentNumber");
  const fullName = nameZoom || nameLabelled;
  const studentNumber = numberLabelled || numberZoom;
  const course = parseGlmCourse(await read(paper.regions.course, "Text Recognition:"));
  const alternatives: Record<string, string[]> = {};
  for (const [key, a, b] of [["fullName", nameZoom, nameLabelled], ["studentNumber", numberLabelled, numberZoom]]) {
    if (a.toLocaleLowerCase("tr-TR") !== b.toLocaleLowerCase("tr-TR")) {
      uncertain.add(key);
      alternatives[key] = [...new Set([a, b].filter(Boolean))];
    }
  }
  const output = normalizePaper({ fullName, studentNumber, ...numbers, ...course, uncertainFields: [...uncertain] }, count);
  return { ...output, alternatives, readingStrategy: "regions",
    warnings: [...(output.warnings || []), ...(Object.keys(alternatives).length
      ? ["İsim/numaranın hücre ve etiketli kırpım okumaları farklı veya eksik. Alternatifleri fotoğrafla kontrol edin; isim/numara hiçbir listeyle tamamlanmadı."] : []),
      "GLM-OCR yerel okuması; model alan bazında ölçülmüş güven yüzdesi vermez."],
  };
}
