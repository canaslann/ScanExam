"use client";
import { useRef, useState } from "react";
import { FileSpreadsheet, LoaderCircle, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { StudentRoster } from "@/lib/student-roster";
import type { RosterColumns, RosterSheet } from "@/lib/student-roster-import";

type Command = (value: Record<string, unknown>) => Promise<void>;
export function StudentRosterUpload({ roster, disabled, command }: { roster?: StudentRoster; disabled: boolean; command: Command }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), [sheets, setSheets] = useState<RosterSheet[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0), [columns, setColumns] = useState<RosterColumns>({ headerRow: -1, numberColumn: -1, nameColumn: -1, surnameColumn: -1 });
  const [fileName, setFileName] = useState(""), [previousId, setPreviousId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const sheet = sheets[sheetIndex];
  async function open(file?: File) {
    if (!file) return;
    setBusy(true); setError("");
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("Excel dosyası en fazla 5 MB olabilir.");
      const { readRosterWorkbook } = await import("@/lib/student-roster-import");
      const values = readRosterWorkbook(await file.arrayBuffer());
      const index = Math.max(0, values.findIndex(value => value.columns.numberColumn >= 0 && value.columns.nameColumn >= 0));
      setFileName(file.name); setPreviousId(roster?.id ?? null); setSheetIndex(index); setColumns(values[index].columns); setSheets(values);
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "Öğrenci listesi açılamadı."); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  }
  async function saveList() {
    if (!sheet) return;
    setBusy(true); setError("");
    try {
      const { rosterStudentsFromSheet } = await import("@/lib/student-roster-import");
      const students = rosterStudentsFromSheet(sheet, columns);
      await command({ action: "roster", previousId, fileName, students });
      setSheets([]); toast.success(`${students.length} öğrencilik liste etkin. İsim ve numaralar listeyle karşılaştırılacak.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Öğrenci listesi kaydedilemedi."); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await command({ action: "roster", previousId: roster?.id ?? null, students: null });
      toast.success("Öğrenci listesi kaldırıldı. Elle düzenlenmeyen kimlikler özgün okumaya döndü."); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "Liste kaldırılamadı."); }
    finally { setBusy(false); }
  }
  const columnCount = sheet ? Math.max(...sheet.rows.slice(0, 30).map(row => row.length)) : 0;
  const label = (i: number) => `${i + 1}. sütun${columns.headerRow >= 0 && sheet?.rows[columns.headerRow]?.[i] ? ` · ${sheet.rows[columns.headerRow][i]}` : ""}`;
  const selectClass = "w-full rounded-lg border border-input bg-muted px-2 py-2 text-sm";
  return <div className="space-y-3 rounded-xl border border-input p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="flex items-center gap-2 text-sm font-medium"><FileSpreadsheet className="size-4" />Öğrenci listesi <span className="font-normal text-muted-foreground">(isteğe bağlı)</span></p>
        <p className="mt-1 text-xs text-muted-foreground">{roster ? `${roster.fileName} · ${roster.students.length} öğrenci · etkin` : "Excel listesi yüklerseniz isim ve numaralar listedeki öğrencilerle eşleştirilir."}</p></div>
      <div className="flex flex-wrap gap-2">
        <input ref={input} type="file" accept=".xlsx,.xls,.csv" className="hidden" aria-label="Excel öğrenci listesi seç" onChange={e => void open(e.target.files?.[0])} />
        <Button variant="outline" disabled={disabled || busy} onClick={() => input.current?.click()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}{roster ? "Listeyi değiştir" : "Excel öğrenci listesi yükle"}</Button>
        {roster && <Button variant="ghost" disabled={disabled || busy} onClick={() => void remove()}><Trash2 className="size-4" />Listeyi kaldır</Button>}
      </div>
    </div>
    {roster && <p className="text-xs text-muted-foreground">Liste telefon ve bilgisayarda ortaktır. Mevcut ve yeni okumalar karşılaştırılır; elle düzenlenen veya onaylanan kimlikler korunur.</p>}
    <Dialog open={sheets.length > 0} onOpenChange={open => { if (!open && !busy) setSheets([]); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Öğrenci listesini önizle</DialogTitle><DialogDescription>Numara ve isim sütunlarını kontrol edin. Ayrı ad/soyad sütunlarını da birleştirebilirsiniz.</DialogDescription></DialogHeader>
        {sheet && <div className="space-y-4">
          {sheets.length > 1 && <label className="block space-y-1 text-sm"><span>Excel sayfası</span><select className={selectClass} value={sheetIndex} disabled={busy} onChange={e => { const i = Number(e.target.value); setSheetIndex(i); setColumns(sheets[i].columns); setError(""); }}>{sheets.map((value, i) => <option key={i} value={i}>{value.name}</option>)}</select></label>}
          <label className="block space-y-1 text-sm"><span>Başlık satırı</span><select className={selectClass} value={columns.headerRow} disabled={busy} onChange={e => setColumns({ ...columns, headerRow: Number(e.target.value) })}><option value={-1}>Başlık yok, ilk satırdan oku</option>{sheet.rows.slice(0, 25).map((row, i) => <option key={i} value={i}>{i + 1}. satır · {row.filter(Boolean).slice(0, 3).join(" / ").slice(0, 100)}</option>)}</select></label>
          <div className="grid gap-3 sm:grid-cols-3">{([['numberColumn','Öğrenci numarası'],['nameColumn','Ad soyad / Ad'],['surnameColumn','Ayrı soyad (varsa)']] as const).map(([key,title]) => <label key={key} className="block space-y-1 text-sm"><span>{title}</span><select className={selectClass} value={columns[key]} disabled={busy} onChange={e => setColumns({ ...columns, [key]: Number(e.target.value) })}><option value={-1}>{key === 'surnameColumn' ? 'Ayrı soyad yok' : 'Sütun seçin'}</option>{Array.from({ length: columnCount }, (_, i) => <option key={i} value={i}>{label(i)}</option>)}</select></label>)}</div>
          <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">Öğrenci numarası</th><th className="p-2">Ad soyad</th></tr></thead><tbody>{sheet.rows.slice(columns.headerRow + 1, columns.headerRow + 6).map((row, i) => <tr key={i} className="border-b last:border-0"><td className="p-2">{row[columns.numberColumn] || "—"}</td><td className="p-2">{[row[columns.nameColumn], columns.surnameColumn >= 0 ? row[columns.surnameColumn] : ""].filter(Boolean).join(" ") || "—"}</td></tr>)}</tbody></table></div>
          <p className="text-xs text-muted-foreground">Excel’de görünen numaralar ve baştaki sıfırlar korunur. Yakın iki adayda otomatik seçim yapılmaz; puanlar değişmez.</p>
          {error && <p role="alert" className="text-sm text-danger-text">{error}</p>}
          <Button disabled={disabled || busy || columns.numberColumn < 0 || columns.nameColumn < 0} onClick={() => void saveList()}>{busy && <LoaderCircle className="size-4 animate-spin" />}Listeyi kullan</Button>
        </div>}
      </DialogContent>
    </Dialog>
  </div>;
}
