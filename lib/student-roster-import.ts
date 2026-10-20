import * as XLSX from "xlsx";
import { MAX_ROSTER_STUDENTS, validateRosterStudents, type RosterStudent } from "./student-roster.ts";

export type RosterColumns = { headerRow: number; numberColumn: number; nameColumn: number; surnameColumn: number };
export type RosterSheet = { name: string; rows: string[][]; columns: RosterColumns };
const headerText = (value: string) => value.toLocaleLowerCase("tr-TR").normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i").replace(/[^a-z0-9]/g, "");
const numberHeaders = new Set(["ogrencino", "ogrencinumarasi", "ogrencinumaralari", "numara", "numarasi", "no", "okulno", "okulnumarasi", "studentnumber", "studentid"]);
const nameHeaders = new Set(["adisoyadi", "adsoyad", "isimsoyisim", "isimsoyadi", "adivesoyadi", "advesoyad", "fullname", "studentname", "ogrenciadisoyadi"]);
const firstHeaders = new Set(["ad", "adi", "isim", "name", "firstname", "ogrenciadi"]);
const lastHeaders = new Set(["soyad", "soyadi", "soyisim", "surname", "lastname"]);

function suggestedColumns(rows: string[][]): RosterColumns {
  for (let r = 0; r < Math.min(25, rows.length); r++) {
    const keys = rows[r].map(headerText), numberColumn = keys.findIndex(key => numberHeaders.has(key));
    const combined = keys.findIndex(key => nameHeaders.has(key)), first = keys.findIndex(key => firstHeaders.has(key));
    const surnameColumn = keys.findIndex(key => lastHeaders.has(key));
    if (numberColumn >= 0 && (combined >= 0 || first >= 0))
      return { headerRow: r, numberColumn, nameColumn: combined >= 0 ? combined : first,
        surnameColumn: combined >= 0 ? -1 : surnameColumn };
  }
  return { headerRow: -1, numberColumn: -1, nameColumn: -1, surnameColumn: -1 };
}

/** Import only displayed strings; numeric formats such as 00000000000 retain leading zeroes. */
export function readRosterWorkbook(bytes: ArrayBuffer): RosterSheet[] {
  if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024) throw new Error("Excel dosyası boş veya 5 MB sınırını aşıyor.");
  let workbook: XLSX.WorkBook;
  try { workbook = XLSX.read(bytes, { type: "array", cellText: true, sheetRows: MAX_ROSTER_STUDENTS + 30 }); }
  catch { throw new Error("Excel dosyası açılamadı. .xlsx veya .xls biçiminde tekrar kaydedin."); }
  const sheets: RosterSheet[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!fullref"] || sheet["!ref"]!);
    if (range.e.r > MAX_ROSTER_STUDENTS + 28 || range.e.c > 99)
      throw new Error(`“${name}” sayfası çok büyük. Yalnız öğrenci listesini yeni bir Excel dosyasına kaydedin (en fazla ${MAX_ROSTER_STUDENTS} öğrenci).`);
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false })
      .map(row => row.map(value => String(value ?? "").trim()));
    if (rows.length) sheets.push({ name, rows, columns: suggestedColumns(rows) });
  }
  if (!sheets.length) throw new Error("Excel dosyasında öğrenci kaydı bulunamadı.");
  return sheets;
}

export function rosterStudentsFromSheet(sheet: RosterSheet, columns: RosterColumns): RosterStudent[] {
  const { numberColumn, nameColumn, surnameColumn, headerRow } = columns;
  if (numberColumn < 0 || nameColumn < 0 || numberColumn === nameColumn
    || surnameColumn === numberColumn || surnameColumn === nameColumn)
    throw new Error("Öğrenci numarası ve isim için farklı sütunlar seçin.");
  const entries: RosterStudent[] = [];
  const invalid: number[] = [];
  for (let i = headerRow + 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i], studentNumber = (row[numberColumn] || "").replace(/\s+/g, "");
    const fullName = [row[nameColumn] || "", ...(surnameColumn >= 0 ? [row[surnameColumn] || ""] : [])].join(" ").trim();
    if (!studentNumber && !fullName) continue;
    // Repeated printed headers may appear inside exported class lists.
    if (numberHeaders.has(headerText(studentNumber))) continue;
    if (!/^\d{5,20}$/.test(studentNumber) || !fullName) { invalid.push(i + 1); continue; }
    entries.push({ studentNumber, fullName });
  }
  if (invalid.length) throw new Error(`İsim veya numarası eksik/geçersiz satırlar var: ${invalid.slice(0, 8).join(", ")}. Sütunları ve başlık satırını kontrol edin.`);
  return validateRosterStudents(entries);
}
