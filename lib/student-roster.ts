import type { ScanOutput } from "./exam.ts";

export type RosterStudent = { studentNumber: string; fullName: string };
export type StudentRoster = { id: string; fileName: string; students: RosterStudent[] };
type IdentityField = "fullName" | "studentNumber";
export type RosterMatch = {
  rosterId: string;
  status: "matched" | "ambiguous" | "unmatched";
  reason?: "number-name-conflict" | "number-not-listed" | "ambiguous";
  original: RosterStudent & { reviewFields: string[]; alternatives: Partial<Record<IdentityField, string[]>> };
  student?: RosterStudent;
  candidates: RosterStudent[];
};
export const MAX_ROSTER_STUDENTS = 5000;
const fold = (s: string) => s.toLocaleLowerCase("tr-TR").normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const numberText = (s: string) => s.replace(/[\s\u200b-\u200d]+/g, "").trim();
const nameText = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ");

export function validateRosterStudents(input: unknown): RosterStudent[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_ROSTER_STUDENTS)
    throw new Error(`Öğrenci listesi 1–${MAX_ROSTER_STUDENTS} öğrenci içermeli.`);
  const students: RosterStudent[] = [], numbers = new Map<string, string>();
  for (const value of input) {
    if (!value || typeof value.fullName !== "string" || typeof value.studentNumber !== "string")
      throw new Error("Öğrenci listesinde isim ve numara alanları eksik.");
    const fullName = nameText(value.fullName), studentNumber = numberText(value.studentNumber);
    if (!/^\d{5,20}$/.test(studentNumber) || fullName.length < 2 || fullName.length > 120
      || !/^[\p{L}\s.'’\-]+$/u.test(fullName))
      throw new Error(`Öğrenci listesinde geçersiz isim veya numara var: ${students.length + 1}. kayıt.`);
    const previous = numbers.get(studentNumber);
    if (previous && fold(previous) !== fold(fullName))
      throw new Error(`${studentNumber} numarası listede farklı isimlerle tekrarlanıyor.`);
    if (!previous) { students.push({ studentNumber, fullName }); numbers.set(studentNumber, fullName); }
  }
  return students;
}

/** Bounded edit distance; no student-specific rules or digit replacement map. */
function distance(a: string, b: string, limit: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i]; let minimum = i;
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      minimum = Math.min(minimum, next[j]);
    }
    if (minimum > limit) return limit + 1;
    previous = next;
  }
  return previous[b.length];
}
function similarity(a: string, b: string, minimum = .4): number {
  if (!a || !b) return 0;
  const length = Math.max(a.length, b.length), limit = Math.floor(length * (1 - minimum));
  const edits = distance(a, b, limit);
  return edits > limit ? 0 : 1 - edits / length;
}
type Candidate = { student: RosterStudent; number: number; name: number; score: number };
type Prepared = { student: RosterStudent; number: string; name: string; sortedName: string };
type PreparedRoster = { rows: Prepared[]; byNumber: Map<string, Prepared> };
const cache = new Map<string, PreparedRoster>();
function preparedRoster(roster: StudentRoster): PreparedRoster {
  let values = cache.get(roster.id);
  if (!values) {
    const rows = roster.students.map(student => ({ student, number: student.studentNumber,
      name: fold(student.fullName), sortedName: fold(student.fullName).split(" ").sort().join(" ") }));
    values = { rows, byNumber: new Map(rows.map(row => [row.number, row])) };
    if (cache.size >= 4) cache.delete(cache.keys().next().value!);
    cache.set(roster.id, values);
  }
  return values;
}

function findStudent(original: RosterStudent, roster: StudentRoster): { status: RosterMatch["status"]; candidates: Candidate[] } {
  const number = fold(numberText(original.studentNumber)).replace(/\s/g, "");
  const name = fold(original.fullName), sortedName = name.split(" ").sort().join(" ");
  if (!number && !name) return { status: "unmatched", candidates: [] };
  const prepared = preparedRoster(roster), exact = prepared.byNumber.get(number);
  if (exact) {
    const nam = name ? Math.max(similarity(name, exact.name), similarity(sortedName, exact.sortedName)) : 0;
    if (!name || nam >= .85) return { status: "matched", candidates: [{ student: exact.student, number: 1, name: nam, score: 1 }] };
  }
  const candidates: Candidate[] = [];
  for (const row of prepared.rows) {
    const num = number ? similarity(number, row.number, .7) : 0;
    if (number && num < .7) continue;
    const nam = name ? Math.max(similarity(name, row.name), similarity(sortedName, row.sortedName)) : 0;
    const score = number && name ? num * .6 + nam * .4 : number ? num : nam;
    if (score >= .5) candidates.push({ student: row.student, number: num, name: nam, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0], margin = best ? best.score - (candidates[1]?.score ?? 0) : 0;
  if (!best) return { status: "unmatched", candidates: [] };
  const exactNumber = best.number === 1 && (!name || best.name >= .4);
  const exactName = best.name === 1 && (!number || best.number >= .75);
  const joint = !!number && !!name && best.number >= .75 && best.name >= .55 && best.score >= .78;
  const nameOnly = !number && best.name >= .86;
  const numberOnly = !name && best.number >= .9;
  const resolvedExact = best.number === 1 && (!name || best.name >= .85);
  const accepted = resolvedExact || ((exactNumber || exactName || joint || nameOnly || numberOnly) && margin >= .06);
  return { status: accepted ? "matched" : "ambiguous", candidates: candidates.slice(0, 3) };
}

/** Restore literal OCR first, so replacing/removing a list never matches a past correction. */
export function withoutRoster(output: ScanOutput): ScanOutput {
  if (!output.rosterMatch) return output;
  const { rosterMatch, ...base } = output, original = rosterMatch.original;
  const alternatives = { ...base.alternatives };
  for (const key of ["fullName", "studentNumber"] as const) {
    delete alternatives[key];
    if (original.alternatives[key]) alternatives[key] = [...original.alternatives[key]!];
  }
  return { ...base, fullName: original.fullName, studentNumber: original.studentNumber, alternatives,
    reviewFields: [...new Set([...(base.reviewFields || []).filter(k => k !== "fullName" && k !== "studentNumber"), ...original.reviewFields])] };
}

export function matchRoster(output: ScanOutput, roster?: StudentRoster): ScanOutput {
  const base = withoutRoster(output);
  if (!roster) return base;
  const original: RosterMatch["original"] = { fullName: base.fullName, studentNumber: base.studentNumber,
    reviewFields: (base.reviewFields || []).filter(k => k === "fullName" || k === "studentNumber"),
    alternatives: { fullName: base.alternatives?.fullName, studentNumber: base.alternatives?.studentNumber } };
  const result = findStudent(original, roster), student = result.status === "matched" ? result.candidates[0].student : undefined;
  const rosterMatch: RosterMatch = { rosterId: roster.id, status: result.status, original,
    student, candidates: result.candidates.map(c => c.student) };
  if (!student) {
    const exact = preparedRoster(roster).byNumber.get(numberText(original.studentNumber));
    rosterMatch.reason = exact && original.fullName ? "number-name-conflict"
      : original.studentNumber && !exact ? "number-not-listed" : "ambiguous";
    return { ...base, rosterMatch,
      reviewFields: [...new Set([...(base.reviewFields || []), "fullName", "studentNumber"])] };
  }
  return { ...base, fullName: student.fullName, studentNumber: student.studentNumber, rosterMatch,
    alternatives: { ...base.alternatives,
      fullName: [...new Set([...(base.alternatives?.fullName || []), base.fullName, student.fullName].filter(Boolean))],
      studentNumber: [...new Set([...(base.alternatives?.studentNumber || []), base.studentNumber, student.studentNumber].filter(Boolean))] } };
}
