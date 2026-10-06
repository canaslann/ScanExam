import * as XLSX from "xlsx";

export type PcCode = `PÇ${number}`;
export const MAX_QUESTIONS = 30;
export function validQuestionCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_QUESTIONS
  );
}
export function validPcCode(value: unknown): value is PcCode {
  return typeof value === "string" && /^PÇ[1-9]\d?$/.test(value);
}

export type StudentResult = {
  id: string;
  studentNumber: string;
  fullName: string;
  scores: number[];
  writtenTotal: number;
  calculatedTotal: number;
  needsReview: boolean;
  createdAt: string;
};

export type ExamState = {
  courseCode: string;
  courseName: string;
  pcMap: PcCode[];
  results: StudentResult[];
};

export type ScanDraft = {
  studentNumber: string;
  fullName: string;
  scores: string[];
  writtenTotal: string;
  confidence: Record<string, number>;
  reviewFields?: string[];
  warnings?: string[];
  alternatives?: Record<string, string[]>;
  engine?: "local-vision" | "tesseract";
  checkMode?: "single" | "double";
  elapsedMs?: number;
  readingStrategy?: "regions" | "compact-table" | "full-table" | "mixed";
};

export type ScanOutput = ScanDraft & {
  courseCode?: string;
  courseName?: string;
  pcMap?: ExamState["pcMap"];
};

export const EMPTY_DRAFT: ScanDraft = {
  studentNumber: "",
  fullName: "",
  scores: ["", "", "", "", ""],
  writtenTotal: "",
  confidence: {},
};

export const DEFAULT_EXAM: ExamState = {
  courseCode: "BILM374-2022",
  courseName: "Yapay Zeka",
  pcMap: ["PÇ2", "PÇ1", "PÇ3", "PÇ2", "PÇ4"],
  results: [],
};

export function toNumber(value: string): number {
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function pcTotals(
  scores: StudentResult["scores"],
  map: ExamState["pcMap"],
) {
  const totals: Partial<Record<PcCode, number>> = {};
  map.forEach((pc) => {
    totals[pc] = 0;
  });
  scores.forEach((score, index) => {
    const pc = map[index];
    if (pc) totals[pc] = (totals[pc] || 0) + score;
  });
  return totals;
}

function average(values: number[]) {
  return values.length
    ? Number(
        (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(
          2,
        ),
      )
    : 0;
}

function safeFilename(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export function createExamWorkbook(exam: ExamState) {
  if (
    !validQuestionCount(exam.pcMap.length) ||
    !exam.pcMap.every(validPcCode) ||
    exam.results.some(
      (row) =>
        row.scores.length !== exam.pcMap.length ||
        row.scores.some(
          (score) => !Number.isFinite(score) || score < 0 || score > 100,
        ) ||
        !Number.isFinite(row.writtenTotal) ||
        row.writtenTotal < 0 ||
        row.writtenTotal > 100,
    )
  )
    throw new Error("Excel için soru sayısı ve puanlar geçerli olmalı.");
  const pcTypes = [...new Set(exam.pcMap)].sort(
    (a, b) => Number(a.slice(2)) - Number(b.slice(2)),
  );
  const headers = [
    "Öğrenci No",
    "Ad Soyad",
    ...exam.pcMap.map((pc, index) => `S${index + 1} (${pc})`),
    ...pcTypes,
    "Toplam Not",
  ];

  const rows = exam.results.map((result) => {
    const totals = pcTotals(result.scores, exam.pcMap);
    return [
      result.studentNumber,
      result.fullName,
      ...result.scores,
      ...pcTypes.map((pc) => totals[pc] || 0),
      result.writtenTotal,
    ];
  });

  const numericColumns = Array.from(
    { length: exam.pcMap.length + pcTypes.length + 1 },
    (_, offset) => offset + 2,
  );
  const averageRow: (string | number)[] = ["", "ORTALAMA"];
  numericColumns.forEach((columnIndex) => {
    averageRow[columnIndex] = average(
      rows.map((row) => Number(row[columnIndex] ?? 0)),
    );
  });

  const sheetData = [
    ["Ders Kodu", exam.courseCode],
    ["Ders Adı", exam.courseName],
    ["Öğrenci Sayısı", exam.results.length],
    [],
    headers,
    ...rows,
    averageRow,
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
  worksheet["!cols"] = [
    { wch: 16 },
    { wch: 28 },
    ...numericColumns.map(() => ({ wch: 12 })),
  ];
  worksheet["!autofilter"] = {
    ref: `A5:${XLSX.utils.encode_col(headers.length - 1)}${Math.max(5, 5 + rows.length)}`,
  };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sonuçlar");
  return workbook;
}

export function exportExamWorkbook(exam: ExamState) {
  const workbook = createExamWorkbook(exam);
  const filename = `${safeFilename(exam.courseCode)}_${safeFilename(exam.courseName)}.xlsx`;
  XLSX.writeFile(workbook, filename);
}
