import type { ScanOutput } from "./exam.ts";
import { prepareQwenNumericViews } from "./qwen-preparation.ts";
import { qwenNumberContextContract, qwenNumericContract, qwenScoresOnlyContract } from "./qwen-contract.ts";
import { refineQwenNumbers, type QwenNumericEvidence } from "./qwen-refinement.ts";

export type QwenAsk = (image: Buffer, schema: object, prompt: string, tokens: number) => Promise<unknown>;
export const QWEN_CHECK_TIMEOUT_MS = 60_000;
const numberValue = (value: unknown) => {
  if (!value || typeof value !== "object" || !("studentNumber" in value) || typeof value.studentNumber !== "string")
    throw new Error("Eksik numara okuması.");
  return value.studentNumber;
};
function scoreValues(value: unknown, count: number): string[] {
  if (!value || typeof value !== "object" || !("scores" in value) || !Array.isArray(value.scores)
    || value.scores.length !== count || value.scores.some(s => typeof s !== "string"))
    throw new Error("Eksik puan okuması.");
  return value.scores;
}

/** The same Qwen checks source crops. Only visual agreement changes a literal. */
export async function checkQwenNumbers(bytes: Uint8Array, first: ScanOutput, ask: QwenAsk, signal: AbortSignal,
  primaryUncertain: string[] = [], cancelled: AbortSignal = signal): Promise<ScanOutput> {
  const evidence: QwenNumericEvidence = {};
  const count = first.scores.length;
  const checkScores = first.reviewFields?.some(field => field === "writtenTotal" || /^s[1-9]\d*$/.test(field)) ?? false;
  let attempted = false;
  try {
    signal.throwIfAborted();
    const views = await prepareQwenNumericViews(bytes, count);
    if (!views) return first;
    signal.throwIfAborted(); attempted = true;
    const contract = qwenNumericContract(count, checkScores);
    const fields = ["studentNumber", ...(checkScores ? first.scores.map((_, i) => `s${i + 1}`) : [])];
    const close = await ask(await views.render(fields), contract.schema, contract.prompt, Math.max(128, count * 12 + 80));
    const closeNumber = numberValue(close);
    evidence.studentNumber = [closeNumber];
    if (checkScores) {
      const closeScores = scoreValues(close, count);
      evidence.scores = [closeScores, first.scores];
      const scoreContract = qwenScoresOnlyContract(count);
      const vertical = await ask(await views.scores(), scoreContract.schema, scoreContract.prompt, Math.max(128, count * 12 + 48));
      evidence.scores = [closeScores, scoreValues(vertical, count)];
    }
    if (closeNumber.replace(/\s+/g, "") !== first.studentNumber || !/^\d{5,20}$/.test(closeNumber)) {
      const contextContract = qwenNumberContextContract();
      const context = await ask(await views.context(), contextContract.schema, contextContract.prompt, 96);
      evidence.studentNumber.push(numberValue(context));
      if (evidence.studentNumber[0] !== evidence.studentNumber[1]) {
        const labelledContract = qwenNumericContract(count, false);
        const labelled = await ask(await views.labelledNumber(), labelledContract.schema, labelledContract.prompt, 96);
        evidence.studentNumber.push(numberValue(labelled));
      }
    }
    return { ...refineQwenNumbers(first, evidence, primaryUncertain), readingStrategy: "mixed" };
  } catch {
    if (cancelled.aborted) cancelled.throwIfAborted();
    const output = attempted ? refineQwenNumbers(first, evidence, primaryUncertain) : first;
    return { ...output, warnings: [...(output.warnings || []), "Qwen yakın alan kontrolü tamamlanamadı; tamamlanan okumalar ve kaynak fotoğraf korundu. Şüpheli alanları kontrol edin."] };
  }
}
