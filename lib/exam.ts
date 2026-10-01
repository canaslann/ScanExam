import * as XLSX from "xlsx";

export type PcCode = "PÇ1" | "PÇ2" | "PÇ3" | "PÇ4" | "PÇ5";

export type StudentResult = {
  id: string;
  studentNumber: string;
  fullName: string;
  scores: [number, number, number, number, number];
  writtenTotal: number;
  calculatedTotal: number;
  needsReview: boolean;
  createdAt: string;
};

export type ExamState = {
  courseCode: string;
  courseName: string;
  pcMap: [PcCode, PcCode, PcCode, PcCode, PcCode];
  results: StudentResult[];
};

export type ScanDraft = {
  studentNumber: string;
  fullName: string;
  scores: [string, string, string, string, string];
  writtenTotal: string;
  confidence: Record<string, number>;
  reviewFields?: string[];
  warnings?: string[];
  alternatives?: Record<string, string[]>;
  engine?: "local-vision" | "tesseract";
  checkMode?: "single" | "double";
  elapsedMs?: number;
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

export function pcTotals(scores: StudentResult["scores"], map: ExamState["pcMap"]) {
  const totals: Record<PcCode, number> = { PÇ1: 0, PÇ2: 0, PÇ3: 0, PÇ4: 0, PÇ5: 0 };
  scores.forEach((score, index) => { totals[map[index]] += score; });
  return totals;
}

function average(values: number[]) {
  return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : 0;
}

function safeFilename(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export function exportExamWorkbook(exam: ExamState) {
  const headers = [
    "Öğrenci No", "Ad Soyad",
    ...exam.pcMap.map((pc, index) => `S${index + 1} (${pc})`),
    "PÇ1", "PÇ2", "PÇ3", "PÇ4", "PÇ5", "Toplam Not",
  ];

  const rows = exam.results.map((result) => {
    const totals = pcTotals(result.scores, exam.pcMap);
    return [
      result.studentNumber, result.fullName, ...result.scores,
      totals.PÇ1, totals.PÇ2, totals.PÇ3, totals.PÇ4, totals.PÇ5,
      result.writtenTotal,
    ];
  });

  const numericColumns = Array.from({ length: 11 }, (_, offset) => offset + 2);
  const averageRow: (string | number)[] = ["", "ORTALAMA"];
  numericColumns.forEach((columnIndex) => {
    averageRow[columnIndex] = average(rows.map((row) => Number(row[columnIndex] ?? 0)));
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
    { wch: 16 }, { wch: 28 },
    ...Array.from({ length: 11 }, () => ({ wch: 12 })),
  ];
  worksheet["!autofilter"] = { ref: `A5:M${Math.max(5, 5 + rows.length)}` };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sonuçlar");
  const filename = `${safeFilename(exam.courseCode)}_${safeFilename(exam.courseName)}.xlsx`;
  XLSX.writeFile(workbook, filename);
}
