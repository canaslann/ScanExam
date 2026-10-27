import type { ScanOutput } from "./exam.ts";
import { normalizePaper, parseScore } from "./reader-contract.ts";

export type QwenNumericEvidence = { studentNumber?: string[]; scores?: string[][] };

/** Replace a literal only when both independently prepared views agree.
 * Arithmetic never supplies or selects a replacement value. */
export function refineQwenNumbers(first: ScanOutput, evidence: QwenNumericEvidence, primaryUncertain: string[] = []): ScanOutput {
  const scores = [...first.scores];
  let studentNumber = first.studentNumber;
  const uncertain = new Set(primaryUncertain);
  const alternatives = { ...first.alternatives };
  let differing = false;
  const resolve = (field: string, original: string, readings: string[], valid: (s: string) => boolean) => {
    const values = readings.map(s => field === "studentNumber" ? s.replace(/\s+/g, "") : s.trim());
    const candidates = [...new Set([original, ...values].filter(Boolean))];
    if (candidates.length > 1) {
      alternatives[field] = [...new Set([...(alternatives[field] || []), ...candidates])];
      uncertain.add(field); differing = true;
    }
    if (field === "studentNumber" && values.length >= 2) {
      const votes = new Map<string, number>();
      for (const value of values.filter(valid)) votes.set(value, (votes.get(value) || 0) + 1);
      const supported = [...votes].filter(([, count]) => count >= 2);
      if (supported.length === 1) return supported[0][0];
    } else if (values.length === 2 && values[0] === values[1] && valid(values[0])) return values[0];
    if (values.length) uncertain.add(field);
    return original;
  };
  if (evidence.studentNumber) studentNumber = resolve("studentNumber", studentNumber, evidence.studentNumber, s => /^\d{5,20}$/.test(s));
  if (evidence.scores?.length === 2 && evidence.scores.every(view => view.length === scores.length)) {
    for (let i = 0; i < scores.length; i++)
      scores[i] = resolve(`s${i + 1}`, scores[i], evidence.scores.map(view => view[i]), s => parseScore(s) !== null);
  }
  const output = normalizePaper({ ...first, studentNumber, scores, uncertainFields: [...uncertain] }, scores.length);
  return { ...output, alternatives,
    warnings: [...(output.warnings || []), ...(differing ? ["Qwen yakın görüntülerinde farklı okumalar bulundu. İlk değerler alternatiflerde korundu; değişen alanları fotoğrafla kontrol edin."] : [])] };
}
