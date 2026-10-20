import { identityText, parseGlmDocument } from "./glm-ocr.ts";
import { needsNameRefinement } from "./name-refinement.ts";
import type { FastIdentity } from "./fast-paper-reader.ts";
import type { PreparedPaper } from "./paper-preparation.ts";

const validName = (value: string) => /^[\p{L}\s'’-]+$/u.test(value) && value.includes(" ");
/** Preserve literal identity even when an optional name check misses its deadline. */
export async function readFastIdentity(paper: PreparedPaper, count: number,
  read: (image: string, tokens: number) => Promise<string>,
  language: () => Promise<FastIdentity | undefined>, signal: AbortSignal,
  recover: typeof read = read): Promise<FastIdentity> {
  let fields: FastIdentity = { fullName: "", studentNumber: "" }, suspectName = true;
  const alternatives: Record<string, string[]> = {};
  const remember = (key: string, value: string) => {
    if (value) alternatives[key] = [...new Set([...(alternatives[key] || []), value])];
  };
  try {
    const parsed = parseGlmDocument(await read(paper.identityTextImage || paper.identityImage!, 220), count);
    fields = { fullName: parsed.fullName, studentNumber: parsed.studentNumber,
      courseCode: parsed.courseCode, courseName: parsed.courseName };
    // A recognizer may write a letter as a digit. Keep that literal as a
    // reviewable fallback instead of silently dropping the entire name.
    fields.fullName ||= identityText(parsed.alternatives?.fullName?.[0] || "", "fullName");
    remember("fullName", fields.fullName);
    suspectName = needsNameRefinement({ ...parsed, fullName: fields.fullName });
  } catch { signal.throwIfAborted(); }
  if (suspectName && paper.identity?.fullNameZoom) {
    try {
      const detail = identityText(await recover(paper.identity.fullNameZoom, 64), "fullName");
      remember("fullName", detail);
      // Keep the initial suspicion for a second visual opinion, but retain
      // this populated literal if that optional reader cannot finish.
      if (validName(detail)) fields.fullName = detail;
    } catch { signal.throwIfAborted(); }
  }
  if (!fields.fullName || !fields.studentNumber || suspectName) {
    try {
      const extra = await language();
      if (extra && validName(extra.fullName) && (!fields.fullName || suspectName)) {
        remember("fullName",extra.fullName); fields.fullName = extra.fullName;
      }
      fields.studentNumber ||= extra?.studentNumber || "";
    } catch { signal.throwIfAborted(); }
  }
  fields.alternatives = alternatives;
  if (suspectName || alternatives.fullName?.length > 1 || !validName(fields.fullName)) fields.reviewFields = ["fullName"];
  return fields;
}
