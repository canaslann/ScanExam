import {
  DEFAULT_EXAM,
  validPcCode,
  validQuestionCount,
  type ExamState,
  type WorkbookExam,
  type PcCode,
  type ScanOutput,
} from "./exam.ts";
import { parseScore, sumScores, type CheckMode } from "./reader-contract.ts";
import { matchRoster, validateRosterStudents, type StudentRoster } from "./student-roster.ts";

export type CellKey =
  | "fullName"
  | "studentNumber"
  | "writtenTotal"
  | `s${number}`;
export type ScanRow = {
  id: string;
  createdAt: string;
  status: "queued" | "reading" | "done" | "error";
  draft: ScanOutput;
  edited: CellKey[];
  confirmed: CellKey[];
  checkMode: CheckMode;
  captureSource?: "camera" | "gallery";
  error?: string;
  hasPhoto: boolean;
  metadataApproval?: string;
  totalApproval?: string;
};
export type ScanSession = {
  roster?: StudentRoster;
  version: 2;
  courseCode: string;
  courseName: string;
  pcMap: PcCode[];
  rows: ScanRow[];
};
export const rowSignature = (row: ScanRow, session: ScanSession) =>
  JSON.stringify([row.draft, session.courseCode, session.courseName, session.pcMap]);
export const MAX_PENDING = 20;
export function newSession(): ScanSession {
  return {
    version: 2,
    courseCode: DEFAULT_EXAM.courseCode,
    courseName: DEFAULT_EXAM.courseName,
    pcMap: [...DEFAULT_EXAM.pcMap],
    rows: [],
  };
}
export function cellKeys(count: number): CellKey[] {
  return [
    "studentNumber",
    "fullName",
    ...Array.from({ length: count }, (_, i) => `s${i + 1}` as CellKey),
    "writtenTotal",
  ];
}
export function emptyRow(
  count: number,
  id: string,
  mode: CheckMode,
  hasPhoto = true,
): ScanRow {
  if (!validQuestionCount(count)) throw new Error("Geçersiz soru sayısı.");
  return {
    id,
    createdAt: new Date().toISOString(),
    status: hasPhoto ? "queued" : "done",
    hasPhoto,
    checkMode: mode,
    edited: [],
    confirmed: [],
    draft: {
      fullName: "",
      studentNumber: "",
      writtenTotal: "",
      scores: Array(count).fill(""),
      confidence: {},
    },
  };
}
export function cellValue(row: ScanRow, key: CellKey): string {
  return /^s\d+$/.test(key)
    ? row.draft.scores[Number(key.slice(1)) - 1]
    : row.draft[key as "fullName" | "studentNumber" | "writtenTotal"];
}
export function editCell(row: ScanRow, key: CellKey, value: string): ScanRow {
  const draft = { ...row.draft, scores: [...row.draft.scores] };
  if (/^s\d+$/.test(key)) draft.scores[Number(key.slice(1)) - 1] = value;
  else draft[key as "fullName" | "studentNumber" | "writtenTotal"] = value;
  return {
    ...row,
    draft,
    totalApproval:
      key === "writtenTotal" || /^s\d+$/.test(key)
        ? undefined
        : row.totalApproval,
    edited: [...new Set([...row.edited, key])],
    confirmed: [...new Set([...row.confirmed, key])],
  };
}
export function mergeReading(row: ScanRow, output: ScanOutput): ScanRow {
  if (output.scores.length !== row.draft.scores.length)
    throw new Error("Okunan soru sayısı sınavla eşleşmiyor.");
  let merged: ScanRow = {
    ...row,
    status: "done",
    error: undefined,
    draft: { ...output, scores: [...output.scores] },
    confirmed: row.confirmed.filter((key) => row.edited.includes(key)),
    metadataApproval: undefined,
    totalApproval: undefined,
  };
  // Edits made while the request was in flight belong to the user, not to the model.
  for (const key of row.edited)
    merged = editCell(merged, key, cellValue(row, key));
  return merged;
}
/** Identity edits/approvals belong to the teacher; a roster never overwrites them. */
export function reconcileRoster(row: ScanRow, roster?: StudentRoster): ScanRow {
  if (row.status !== "done" || ["fullName", "studentNumber"].some(key =>
    row.edited.includes(key as CellKey) || row.confirmed.includes(key as CellKey))) return row;
  return { ...row, draft: matchRoster(row.draft, roster) };
}
export function validCell(row: ScanRow, key: CellKey): boolean {
  const value = cellValue(row, key)?.trim();
  if (key === "fullName") return Boolean(value && value.length >= 2);
  if (key === "studentNumber") return /^\d{5,20}$/.test(value || "");
  return parseScore(value || "") !== null;
}
export function duplicateNumber(session: ScanSession, row: ScanRow): boolean {
  const number = row.draft.studentNumber.trim();
  return Boolean(
    number &&
      session.rows.some(
        (other) =>
          other.id !== row.id && other.draft.studentNumber.trim() === number,
      ),
  );
}
/** Explain validation before approval, using the same rules on both devices. */
export function approvalIssue(session: ScanSession, row: ScanRow): string | undefined {
  if (row.status === "error") return row.error || "Okuma başarısız. Yeniden deneyin veya alanları elle tamamlayın.";
  if (row.status !== "done") return "Satırın okuması henüz tamamlanmadı.";
  if ((sumScores(row.draft.scores) ?? 0) > 100)
    return "Puan toplamı 100'ü aşıyor. Onaylamadan önce puanları fotoğrafla düzeltin.";
  const missing = cellKeys(session.pcMap.length).filter(key => !validCell(row, key));
  const label = (key: CellKey) => key === "fullName" ? "Ad soyad" : key === "studentNumber" ? "Öğrenci no" : key === "writtenTotal" ? "Yazılı toplam" : key.toUpperCase();
  if (missing.length) return `Eksik veya geçersiz alanları düzeltin: ${missing.map(label).join(", ")}.`;
  if (duplicateNumber(session, row)) {
    const others = session.rows.flatMap((other, i) => other.id !== row.id && other.draft.studentNumber.trim() === row.draft.studentNumber.trim() ? [i + 1] : []);
    return `Bu öğrenci numarası ${others.join(", ")}. satırda da var. Numarayı fotoğrafla kontrol edin veya mükerrer satırı kaldırın.`;
  }
}
export function cellState(
  session: ScanSession,
  row: ScanRow,
  key: CellKey,
): { color: "pending" | "yellow" | "green"; reason: string } {
  if (!row.edited.includes(key) && row.status !== "done")
    return {
      color: "pending",
      reason:
        row.status === "error"
          ? "Okuma başarısız; yeniden deneyin veya elle doldurun."
          : "Okuma bekleniyor.",
    };
  if (!validCell(row, key))
    return { color: "yellow", reason: "Eksik veya geçersiz değer." };
  if (key === "studentNumber" && duplicateNumber(session, row))
    return {
      color: "yellow",
      reason: "Bu numara başka bir satırda da var; mükerrer kaydı çözün.",
    };
  const calculated = sumScores(row.draft.scores),
    total = parseScore(row.draft.writtenTotal);
  if (calculated !== null && calculated > 100 && (key === "writtenTotal" || /^s\d+$/.test(key)))
    return { color: "yellow", reason: "100 puanlık sınavda puan toplamı 100'ü aşamaz. Puanları düzeltin; bu çelişki yalnız onayla geçilemez." };
  const mismatch =
    calculated !== null &&
    total !== null &&
    Math.abs(calculated - total) > 0.001;
  if (
    mismatch &&
    row.totalApproval !==
      JSON.stringify([row.draft.scores, row.draft.writtenTotal]) &&
    key === "writtenTotal"
  )
    return {
      color: "yellow",
      reason:
        "Puanların toplamı kâğıtta yazan notla farklı. Hangi alanın hatalı olduğu bilinmiyor; tüm puanları fotoğrafla karşılaştırın. Değerler değiştirilmedi.",
    };
  if (row.confirmed.includes(key))
    return {
      color: "green",
      reason: "Kullanıcı kontrol etti/düzenledi; doğruluk garantisi değildir.",
    };
  if ((key === "fullName" || key === "studentNumber") && session.roster
    && row.draft.rosterMatch?.rosterId === session.roster.id && row.draft.rosterMatch.status === "matched"
    && row.draft.rosterMatch.student?.fullName === row.draft.fullName
    && row.draft.rosterMatch.student?.studentNumber === row.draft.studentNumber)
    return { color: "green", reason: "Yüklenen Excel öğrenci listesiyle eşleşti; özgün okuma alternatiflerde saklanıyor." };
  if (key === "fullName" || key === "studentNumber")
    return {
      color: "yellow",
      reason: "Kimlik alanını fotoğrafla karşılaştırın.",
    };
  if (
    row.draft.reviewFields?.includes(key) ||
    row.draft.alternatives?.[key]?.length ||
    (row.draft.confidence[key] !== undefined && row.draft.confidence[key] < 60)
  )
    return {
      color: "yellow",
      reason:
        "Okuyucu belirsizlik veya farklı okuma bildirdi; fotoğrafla karşılaştırın.",
    };
  return {
    color: "green",
    reason:
      "Okuyucu şüphe bildirmedi. Ölçülmüş güven oranı veya doğruluk garantisi değildir.",
  };
}
const canonical = (value: string) =>
  value.trim().toLocaleUpperCase("tr-TR").replaceAll("İ", "I");
export function metadataWarnings(session: ScanSession, row: ScanRow): string[] {
  if (row.status !== "done" || !row.hasPhoto) return [];
  const d = row.draft,
    warnings: string[] = [];
  if (
    !d.courseCode ||
    canonical(d.courseCode) !== canonical(session.courseCode)
  )
    warnings.push(
      `Ders kodu: ${d.courseCode || "okunamadı"} (aktif: ${session.courseCode || "boş"})`,
    );
  if (
    !d.courseName ||
    canonical(d.courseName) !== canonical(session.courseName)
  )
    warnings.push(
      `Ders adı: ${d.courseName || "okunamadı"} (aktif: ${session.courseName || "boş"})`,
    );
  if (!d.pcMap || JSON.stringify(d.pcMap) !== JSON.stringify(session.pcMap))
    warnings.push(
      `PÇ eşleşmesi: ${d.pcMap?.join(", ") || "okunamadı"} (aktif: ${session.pcMap.join(", ")})`,
    );
  for (const [key, label] of [["courseCode", "Ders kodu"], ["courseName", "Ders adı"], ["pcMap", "PÇ eşleşmesi"]])
    if (d.reviewFields?.includes(key) && !warnings.some(warning => warning.startsWith(`${label}:`)))
      warnings.push(
        `${label}: fotoğrafla kontrol edin.${d.alternatives?.[key]?.length ? ` Alternatifler: ${d.alternatives[key].join(" / ")}` : ""}`,
      );
  return warnings;
}
export function metadataSignature(session: ScanSession, row: ScanRow) {
  return JSON.stringify(metadataWarnings(session, row));
}
export function confirmRow(session: ScanSession, row: ScanRow): ScanRow {
  const issue = approvalIssue(session, row);
  if (issue) throw new Error(issue);
  return {
    ...row,
    confirmed: cellKeys(session.pcMap.length),
    metadataApproval: metadataSignature(session, row),
    totalApproval: JSON.stringify([row.draft.scores, row.draft.writtenTotal]),
  };
}
export function exportIssues(session: ScanSession): string[] {
  if (
    !validQuestionCount(session.pcMap.length) ||
    !session.pcMap.every(validPcCode) ||
    !session.courseCode.trim() ||
    !session.courseName.trim()
  )
    return ["Sınav bilgileri ve PÇ eşleşmeleri geçerli olmalı."];
  return session.rows.flatMap((row, index) => {
    if (row.status !== "done")
      return [`${index + 1}. satırın okuması tamamlanmadı.`];
    const unresolved = cellKeys(session.pcMap.length).filter(
      (key) => cellState(session, row, key).color !== "green",
    );
    const metadata =
      metadataWarnings(session, row).length &&
      row.metadataApproval !== metadataSignature(session, row);
    return unresolved.length || metadata
      ? [
          `${index + 1}. satır kontrol bekliyor${unresolved.length ? ` (${unresolved.join(", ")})` : " (ders/PÇ)"}.`,
        ]
      : [];
  });
}
/** Export the current local snapshot; review and connectivity never gate it. */
export function sessionExam(session: ScanSession): WorkbookExam {
  const mark = (value: string) => value.trim() ? parseScore(value) ?? value : null;
  return {
    courseCode: session.courseCode,
    courseName: session.courseName,
    pcMap: session.pcMap,
    results: session.rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      fullName: row.draft.fullName.trim(),
      studentNumber: row.draft.studentNumber.trim(),
      scores: row.draft.scores.map(mark),
      writtenTotal: mark(row.draft.writtenTotal),
      calculatedTotal: sumScores(row.draft.scores),
      needsReview: cellKeys(session.pcMap.length).some(key => cellState(session, row, key).color !== "green"),
    })),
  };
}
export function restoreSession(raw: unknown, resumeReading = true): ScanSession {
  const value = raw as ScanSession;
  if (
    !value ||
    value.version !== 2 ||
    typeof value.courseCode !== "string" ||
    typeof value.courseName !== "string" ||
    !Array.isArray(value.pcMap) ||
    !validQuestionCount(value.pcMap.length) ||
    !value.pcMap.every(validPcCode) ||
    !Array.isArray(value.rows)
  )
    throw new Error("Kayıt biçimi geçersiz; mevcut kayıt silinmedi.");
  if (value.roster) {
    if (typeof value.roster.id !== "string" || typeof value.roster.fileName !== "string"
      || value.roster.fileName.length > 200) throw new Error("Öğrenci listesi kaydı geçersiz.");
    validateRosterStudents(value.roster.students);
  }
  const ids = new Set<string>();
  for (const row of value.rows) {
    if (
      !row ||
      typeof row.id !== "string" ||
      ids.has(row.id) ||
      typeof row.createdAt !== "string" ||
      !["queued", "reading", "done", "error"].includes(row.status) ||
      !["single", "double"].includes(row.checkMode) ||
      (row.captureSource!==undefined && !["camera","gallery"].includes(row.captureSource)) ||
      typeof row.hasPhoto !== "boolean" ||
      !Array.isArray(row.edited) ||
      !Array.isArray(row.confirmed) ||
      !row.draft ||
      !Array.isArray(row.draft.scores) ||
      row.draft.scores.length !== value.pcMap.length ||
      !row.draft.scores.every((s) => typeof s === "string") ||
      ![
        row.draft.fullName,
        row.draft.studentNumber,
        row.draft.writtenTotal,
      ].every((s) => typeof s === "string") ||
      !row.draft.confidence ||
      [...row.edited, ...row.confirmed].some(
        (key) => !cellKeys(value.pcMap.length).includes(key),
      )
    )
      throw new Error("Satır kaydı geçersiz; mevcut kayıt silinmedi.");
    const d = row.draft,
      strings = (v: unknown) =>
        Array.isArray(v) && v.every((item) => typeof item === "string");
    if (
      typeof d.confidence !== "object" ||
      Array.isArray(d.confidence) ||
      Object.values(d.confidence).some(
        (item) => typeof item !== "number" || !Number.isFinite(item),
      ) ||
      (d.reviewFields !== undefined && !strings(d.reviewFields)) ||
      (d.warnings !== undefined && !strings(d.warnings)) ||
      (d.alternatives !== undefined &&
        (!d.alternatives ||
          typeof d.alternatives !== "object" ||
          Array.isArray(d.alternatives) ||
          !Object.values(d.alternatives).every(strings))) ||
      (d.pcMap !== undefined &&
        (!Array.isArray(d.pcMap) ||
          d.pcMap.length !== value.pcMap.length ||
          !d.pcMap.every(validPcCode))) ||
      [
        d.courseCode,
        d.courseName,
        row.metadataApproval,
        row.totalApproval,
        row.error,
      ].some((item) => item !== undefined && typeof item !== "string")
    )
      throw new Error("Kontrol verisi geçersiz; mevcut kayıt silinmedi.");
    ids.add(row.id);
  }
  return {
    ...value,
    rows: value.rows.map((row) =>
      resumeReading && row.status === "reading" ? { ...row, status: "queued" } : row,
    ),
  };
}
export function migrateLegacy(raw: unknown): ScanSession {
  const old = raw as ExamState;
  if (
    !old ||
    typeof old.courseCode !== "string" ||
    typeof old.courseName !== "string" ||
    !Array.isArray(old.pcMap) ||
    !validQuestionCount(old.pcMap.length) ||
    !old.pcMap.every(validPcCode) ||
    !Array.isArray(old.results)
  )
    throw new Error("Önceki kayıt açılamadı; silinmedi.");
  return restoreSession({
    version: 2,
    courseCode: old.courseCode,
    courseName: old.courseName,
    pcMap: old.pcMap,
    rows: old.results.map((result) => ({
      ...emptyRow(old.pcMap.length, result.id, "single", false),
      createdAt: result.createdAt,
      draft: {
        fullName: result.fullName,
        studentNumber: result.studentNumber,
        scores: result.scores.map(String),
        writtenTotal: String(result.writtenTotal),
        confidence: {},
      },
      confirmed: result.needsReview ? [] : cellKeys(old.pcMap.length),
    })),
  });
}
