import { parseScore, sumScores } from "./reader-contract.ts";
import type { PreparedPaper } from "./paper-preparation.ts";

/** Replacement digits must come from a new visual reading, never subtraction. */
export async function recoverFastOverflow(first: string[], paper: PreparedPaper,
  read: (image: string, tokens: number) => Promise<string>, writtenTotal = "") {
  const result = { scores: [...first], alternatives: {} as Record<string, string[]>, reviewFields: [] as string[], warnings: [] as string[] };
  if ((sumScores(first) ?? 0) <= 100 || !paper.scoreRowImage || paper.scoreCells?.length !== first.length) return result;
  const row = (await read(paper.scoreRowImage, Math.max(64, first.length * 10))).replace(/^Puan\s*:?\s*/iu, "")
    .trim().split(/[|\s]+/).filter(Boolean);
  if (row.length !== first.length || row.some(value => parseScore(value) === null)) return result;
  const changes = row.flatMap((value, i) => parseScore(value) !== parseScore(first[i]) ? [i] : [])
    .sort((a, b) => (parseScore(first[b])! - parseScore(row[b])!) - (parseScore(first[a])! - parseScore(row[a])!)).slice(0, 2);
  const proposed = [...first];
  // A complete second visual row agreeing with the independently written Not
  // can resolve a single bad digit. Both literal readings remain reviewable.
  if(changes.length===1 && parseScore(writtenTotal)!==null && sumScores(row)===parseScore(writtenTotal)) {
    const i=changes[0],key=`s${i+1}`;
    result.scores=row;
    result.alternatives[key]=[first[i],row[i]];
    result.reviewFields.push(key);
    result.warnings.push("100 puanı aşan ilk okuma, puan satırının yeni görsel okumasıyla düzeltildi. Yeni satır kâğıtta yazan Not ile uyuşuyor; ilk değer alternatiflerde korunuyor.");
    return result;
  }
  for (const i of changes) {
    const detail = (await read(paper.scoreCells[i].color, 24)).replace(/^Puan\s*:?\s*/iu, "").trim();
    const key = `s${i + 1}`;
    result.alternatives[key] = [...new Set([first[i], row[i], detail].filter(Boolean))]; result.reviewFields.push(key);
    if (parseScore(detail) !== null && parseScore(detail) === parseScore(row[i])) proposed[i] = row[i];
  }
  if ((sumScores(proposed) ?? 101) <= 100) {
    result.scores = proposed;
    result.warnings.push("100 puan sınırı aşıldığı için şüpheli puan, kendi hücresi ve puan satırından kontrol edildi. Desteklenen okuma seçildi; ilk değer alternatiflerde saklanıyor.");
  }
  return result;
}

/** Check common digit confusions even when the total looks plausible. */
export async function refineConfusableScores(
  first: string[],
  cells: PreparedPaper["scoreCells"],
  read: (image: string) => Promise<string>,
  verify?: (image: string) => Promise<string>,
  rowReadings?: string[],
) {
  const scores = [...first], alternatives: Record<string, string[]> = {};
  const reviewFields: string[] = [], warnings: string[] = [];
  if (cells?.length !== first.length) return { scores, alternatives, reviewFields, warnings };
  // Bound extra work for large forms. The complete table remains the primary
  // transcription; arithmetic and expected answers are never sent to readers.
  const targets = first.flatMap((value, index) => parseScore(value) !== null && (rowReadings ? parseScore(rowReadings[index]) !== parseScore(value) : /[1237]/.test(value)) ? [index] : []).slice(0, 6);
  for (const index of targets) {
    const detail = await read(cells[index].color);
    const padded = await read(cells[index].padded);
    const values = [first[index], detail, padded];
    const original = parseScore(first[index]);
    if ([detail, padded].every(value => parseScore(value) === original)) continue;
    // Require a second model's visual support. If native crops cannot support
    // its answer, check a second view with that model as well.
    const extra = verify ? await verify(cells[index].color) : "";
    values.push(extra);
    const verified = parseScore(extra);
    let selected = verified !== null && verified !== original
      ? [detail, padded].find(value => parseScore(value) === verified) : undefined;
    const confusable = (a: string, b: string) => a.length === b.length && [...a].every((digit, i) =>
      digit === b[i] || ["12", "21", "37", "73", "27", "72"].includes(digit + b[i]));
    if (selected === undefined && verified !== null && verified !== original && verify && confusable(first[index], extra)) {
      const second = await verify(cells[index].padded);
      values.push(second);
      if (parseScore(second) === verified) selected = extra;
    }
    // Formatting failures with no different numeric reading need no new alert.
    if (!values.some(value => parseScore(value) !== null && parseScore(value) !== original)) continue;
    const key = `s${index + 1}`;
    alternatives[key] = [...new Set(values.filter(Boolean))];
    reviewFields.push(key);
    if (selected !== undefined) scores[index] = selected;
  }
  // Literal evidence may still contradict the exam maximum. Preserve it for
  // review instead of accepting a new impossible total or repairing arithmetic.
  if ((sumScores(scores) ?? 0) > 100) scores.splice(0, scores.length, ...first);
  if (reviewFields.length) warnings.push("Benzer rakamlar hücre kırpımlarıyla yeniden kontrol edildi. Değişen okumalar ve alternatifler ilgili puan alanlarında gösteriliyor; fotoğrafla karşılaştırın.");
  return { scores, alternatives, reviewFields, warnings };
}

/** Arithmetic locates a contradiction; only literal image reads supply values. */
export async function refineExcessScores(
  first: string[],
  cells: PreparedPaper["scoreCells"],
  read: (image: string) => Promise<string>,
  verify?: (image: string) => Promise<string>,
) {
  const scores = [...first], alternatives: Record<string, string[]> = {};
  const reviewFields: string[] = [], warnings: string[] = [];
  const sum = sumScores(first);
  if (sum === null || sum <= 100 || cells?.length !== first.length)
    return { scores, alternatives, reviewFields, warnings };
  const overflow = sum - 100;
  const ranked = first.map((value, index) => ({ index, value: parseScore(value)! }))
    .sort((a, b) => b.value - a.value || a.index - b.index);
  // Prefer cells whose correction could resolve the excess alone, without
  // assuming equal question weights or a fixed number of questions. Bound
  // retries to two cells; an unresolved contradiction stays blocked for review.
  const possible = ranked.filter(item => item.value >= overflow);
  const targets = (possible.length ? possible : ranked).slice(0, 2);
  const proposed = [...first];
  for (const { index } of targets) {
    const key = `s${index + 1}`;
    const detail = await read(cells[index].color);
    const padded = await read(cells[index].padded);
    const values = [first[index], detail, padded];
    let selected: string | undefined;
    if (parseScore(detail) !== null && parseScore(detail) === parseScore(padded)) selected = detail;
    else if (verify) {
      const extra = await verify(cells[index].padded);
      values.push(extra);
      if (parseScore(extra) !== null) {
        if (parseScore(extra) === parseScore(detail)) selected = detail;
        else if (parseScore(extra) === parseScore(padded)) selected = padded;
      }
    }
    alternatives[key] = [...new Set(values.filter(Boolean))];
    reviewFields.push(key);
    if (selected !== undefined) proposed[index] = selected;
  }
  const newSum = sumScores(proposed);
  if (newSum !== null && newSum <= 100) {
    scores.splice(0, scores.length, ...proposed);
    warnings.push("Puan toplamı 100'ü aştığı için şüpheli hücreler ayrı okundu; birbirini destekleyen görsel okumalar seçildi. İlk değerler alternatiflerde korundu.");
  } else {
    warnings.push("Puan toplamı 100'ü aştı; hücre okumaları çelişkiyi çözemedi. İlk değerler korundu; puanları fotoğrafla karşılaştırın.");
  }
  return { scores, alternatives, reviewFields, warnings };
}
