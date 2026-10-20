"use client";
/* eslint-disable @next/next/no-img-element -- Source photos are fetched from the local computer, never an image optimizer. */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUpRight, CheckCircle2, CircleDot, FileSpreadsheet, Layers3, LoaderCircle, PencilLine, Plus, ScanLine, ShieldCheck, Trash2, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { useTheme } from "next-themes";
import { ThemeControls } from "@/components/theme-controls";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { prepareCaptureImage } from "@/lib/capture-image";
import { LiveCamera } from "@/components/live-camera";
import { RapidCamera } from "@/components/rapid-camera";
import { exportExamWorkbook, MAX_QUESTIONS, validPcCode, validQuestionCount, type PcCode } from "@/lib/exam";
import { sumScores, type CheckMode } from "@/lib/reader-contract";
import { approvalIssue, cellKeys, cellState, cellValue, editCell, exportIssues, MAX_PENDING, metadataSignature, metadataWarnings, rowSignature, sessionExam, type CellKey, type ScanRow, type ScanSession } from "@/lib/scan-session";
import { sharedPhoto } from "@/lib/shared-client";
import { useSharedScan } from "@/hooks/use-shared-scan";
import { StudentRosterUpload } from "@/components/student-roster-upload";

type ReaderStatus = { ready: boolean; model: string; message: string };
async function readerStatus(): Promise<ReaderStatus> {
  try {
    const response = await fetch("/api/reader", { signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!response.ok) throw new Error();
    return await response.json();
  } catch {
    return { ready: false, model: "", message: "Yerel okuyucuya ulaşılamıyor. Bilgisayardaki motoru kontrol edin; görüntüler korunuyor." };
  }
}
export function ExamApp() {
  const { resolvedTheme } = useTheme();
  const sync = useSharedScan();
  const { session, sessionRef, ready, error: storageError, paused, uploads, writing, updateRow, updateMeta } = sync;
  const [captureMethod, setCaptureMethod] = useState<"stable" | "manual" | "rapid" | "gallery">("stable");
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const importLock = useRef(false);
  const [mode, setMode] = useState<CheckMode>("single"), [status, setStatus] = useState<ReaderStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [photo, setPhoto] = useState<{ id: string; url: string } | null>(null);
  const [zoomedPhoto, setZoomedPhoto] = useState<string | null>(null);
  const photoZoom = selected !== null && zoomedPhoto === selected;
  const photoUrl = photo?.id === selected ? photo.url : null;
  const gallery = useRef<HTMLInputElement>(null), replacement = useRef<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => void readerStatus().then(value => { if (!disposed) setStatus(value); });
    refresh(); const timer = setInterval(refresh, 10_000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  useEffect(() => {
    let disposed = false, url: string | undefined;
    if (selected) void sharedPhoto(selected).then(blob => {
      if (disposed) return; url = URL.createObjectURL(blob); setPhoto({ id: selected, url });
    }).catch(() => { if (!disposed) toast.error("Bilgisayardaki kaynak görüntü açılamadı."); });
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [selected]);
  const serverPending = session.rows.filter(row => row.status === "queued" || row.status === "reading").length;
  const pending = serverPending + uploads;
  const progress = uploads > 0 ? `${uploads} görüntü aktarım bekliyor · bu cihazda kayıtlı`
    : session.rows.some(row => row.status === "reading") ? "Okuma sürüyor · taramaya devam edebilirsiniz."
    : serverPending > 0 ? "Okuma sırası bekleniyor · taramaya devam edebilirsiniz." : "";
  const issues = exportIssues(session), selectedRow = session.rows.find(row => row.id === selected);
  const editable = sync.connected, usable = editable;
  const completed = session.rows.filter(row => row.status === "done").length;
  const excessiveRows = session.rows.flatMap((row, i) => (sumScores(row.draft.scores) ?? 0) > 100 ? [i + 1] : []);
  const approvalProblem = selectedRow ? approvalIssue(session, selectedRow) : undefined;
  const metadataReview = selectedRow && selectedRow.metadataApproval !== metadataSignature(session, selectedRow)
    ? metadataWarnings(session, selectedRow) : [];
  const readingDetails = [...new Set(selectedRow?.draft.warnings || [])];
  const rosterMatch = selectedRow?.draft.rosterMatch?.rosterId === session.roster?.id ? selectedRow?.draft.rosterMatch : undefined;
  const scoreSum = selectedRow ? sumScores(selectedRow.draft.scores) : null;
  const totalMismatch = selectedRow && scoreSum !== null && !approvalProblem &&
    cellState(session, selectedRow, "writtenTotal").color === "yellow" &&
    Number(selectedRow.draft.writtenTotal.replace(",", ".")) !== scoreSum;
  function reviewField(key: CellKey) {
    if (!selectedRow) return null;
    const question = /^s\d+$/.test(key);
    return (
      <div key={key} className="min-w-0 space-y-1.5">
        <Label htmlFor={`review-${selectedRow.id}-${key}`} className="text-xs text-muted-foreground">
          {key === "fullName" ? "Ad soyad" : key === "studentNumber" ? "Öğrenci no" : key === "writtenTotal" ? "Kâğıtta yazan toplam" : key.toUpperCase()}
          {question && <span className="ml-1 text-[10px] text-muted-foreground">{session.pcMap[Number(key.slice(1)) - 1]}</span>}
        </Label>
        <EditableCell compact session={session} row={selectedRow} field={key} disabled={!editable}
          onEdit={value => void updateRow(selectedRow.id, row => editCell(row, key, value)).catch(() => undefined)} />
        {!!selectedRow.draft.alternatives?.[key]?.length && (
          <details className="text-xs text-warning-text">
            <summary className="cursor-pointer">Alternatifler</summary>
            <p className="mt-1 break-words">{selectedRow.draft.alternatives[key].join(" / ")}</p>
          </details>
        )}
      </div>
    );
  }
  async function capture(blob: Blob, replacementId?: string, source: "camera" | "gallery" = "camera") {
    if (!usable) throw new Error("Bilgisayar bağlantısı hazır değil; görüntü korunmalı.");
    if (uploads >= MAX_PENDING) throw new Error("Cihazdaki aktarım kuyruğu dolu; aktarımın tamamlanmasını bekleyin.");
    await sync.capture(blob, mode, replacementId, source);
  }
  function approve(row: ScanRow) {
    void sync.command({ action: "approve", id: row.id, signature: rowSignature(row, sessionRef.current) })
      .then(() => {
        setSelected(current => current === row.id ? null : current);
        toast.success("Satır kontrol edildi; puan/toplam değiştirilmedi.");
      })
      .catch(cause => toast.error(cause instanceof Error ? cause.message : "Kontrol tamamlanamadı."));
  }
  async function remove(row: ScanRow) {
    if (row.status === "reading") return;
    await sync.command({ action: "remove", id: row.id, signature: rowSignature(row, sessionRef.current) })
      .then(() => setSelected(current => current === row.id ? null : current))
      .catch(() => undefined);
  }
  function manual() {
    void sync.command({ action: "manual", id: crypto.randomUUID() }).catch(() => undefined);
  }
  return (
    <main className="exam-app min-h-screen pb-10 text-foreground">
      <Toaster theme={resolvedTheme === "dark" ? "dark" : "light"} richColors position="top-center" />
      <header className="app-header">
        <div className="workspace-width flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="brand-mark"><ScanLine className="size-6" /></div>
            <div>
              <h1 className="brand-title">Scan Exam</h1>
            </div>
          </div>
          <nav className="header-nav" aria-label="Çalışma alanı">
            <a href="#exam-setup">Sınav düzeni</a>
            <a href="#live-scan">Canlı tarama</a>
            <a href="#results">Sonuçlar <ArrowUpRight className="size-3.5" /></a>
          </nav>
          <div className="header-actions">
          <ThemeControls />
          <Button
            variant="outline"
            className="new-exam-button"
            disabled={!usable || pending > 0 || writing > 0}
            onClick={() => {
              if (
                window.confirm(
                  "Yeni sınav telefon ve bilgisayardaki ortak tabloyu ve bilgisayarda saklanan fotoğrafları kaldırır. Önce Excel’inizi indirdiniz mi?",
                )
              )
                void sync.command({ action: "reset", revision: sync.snapshot()?.revision })
                  .then(() => setSelected(null))
                  .catch(() => undefined);
            }}
          >
            <Plus className="size-4" /> Yeni sınav
          </Button>
          </div>
        </div>
      </header>
      <div className="workspace-width workspace-body">
        <section className="workspace-intro" aria-label="Sınav çalışma alanı">
          <div>
            <p className="eyebrow"><span /> SINAV ÇALIŞMA ALANI</p>
            <h2>Kâğıttan veriye,<br /><span>bir akışta.</span></h2>
            <a className="intro-link" href="#live-scan">Taramaya geç <ArrowDown className="size-4" /></a>
          </div>
          <div className="session-overview">
            <div className="overview-heading"><span><Layers3 className="size-4" /> Bu oturum</span><span className={`connection-badge ${sync.connected ? "is-connected" : ""}`}><CircleDot className="size-3" />{sync.connected ? "Bağlı" : "Bağlanıyor"}</span></div>
            <p className="overview-course">{session.courseName || "Yeni bir sınava hazır"}</p>
            {session.courseCode && <p className="overview-caption">{session.courseCode}</p>}
            <div className="overview-stats">
              <div><strong>{session.rows.length.toString().padStart(2, "0")}</strong><span>Öğrenci kaydı</span></div>
              <div><strong>{session.pcMap.length.toString().padStart(2, "0")}</strong><span>Soru</span></div>
              <div><strong>{completed.toString().padStart(2, "0")}</strong><span>Okunan kâğıt</span></div>
            </div>
            <div className="overview-footer"><ShieldCheck className="size-4" /> Yerel kayıt</div>
          </div>
        </section>
        {storageError && (
          <div
            role="alert"
            className="rounded-xl border border-danger-border bg-danger-soft p-4 text-sm text-danger-text"
          >
            <p>{storageError}</p>
            {editable && (
              <Button
                variant="outline"
                className="mt-2"
                onClick={() =>
                  void sync.command({ action: "pause", paused })
                    .then(() => toast.success("Bilgisayar bağlantısı hazır."))
                    .catch(() => undefined)
                }
              >
                Bilgisayar bağlantısını yeniden dene
              </Button>
            )}
          </div>
        )}
        {!ready && !storageError && (
          <p role="status">Bilgisayardaki ortak tabloya bağlanılıyor…</p>
        )}
        <Card id="exam-setup" className="setup-card">
          <CardHeader>
            <CardTitle className="section-title"><span className="step-number">01</span><span>Sınavı hazırla</span></CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <StudentRosterUpload roster={session.roster} disabled={!usable || writing > 0} command={sync.command} />
            <div className="grid gap-4 sm:grid-cols-[1fr_2fr_1fr]">
              <div>
                <Label htmlFor="course-code">Ders kodu</Label>
                <Input
                  id="course-code"
                  disabled={!usable}
                  value={session.courseCode}
                  onChange={(e) => updateMeta({ courseCode: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="course-name">Ders adı</Label>
                <Input
                  id="course-name"
                  disabled={!usable}
                  value={session.courseName}
                  onChange={(e) => updateMeta({ courseName: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="question-count">
                  Soru sayısı (1–{MAX_QUESTIONS})
                </Label>
                <Input
                  key={session.pcMap.length}
                  id="question-count"
                  type="number"
                  min={1}
                  max={MAX_QUESTIONS}
                  disabled={!usable || session.rows.length > 0}
                  defaultValue={session.pcMap.length}
                  onBlur={(e) => {
                    const count = Number(e.target.value);
                    if (validQuestionCount(count))
                      updateMeta({
                        pcMap: Array.from(
                          { length: count },
                          (_, i) => sessionRef.current.pcMap[i] || "PÇ1",
                        ),
                      });
                    else {
                      e.target.value = String(sessionRef.current.pcMap.length);
                      toast.error("Soru sayısı 1–30 arasında olmalı.");
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground" title="Soru sayısı ilk kayıttan sonra korunur. Farklı soru sayısı için yeni sınav başlatın.">
              Soru / PÇ eşleşmesi <span className="text-muted-foreground">(PÇ1–PÇ99)</span>
            </p>
            <div className="flex flex-wrap gap-3">
              {session.pcMap.map((pc, i) => (
                <div key={i} className="w-24">
                  <Label htmlFor={`pc-${i}`}>S{i + 1}</Label>
                  <div className="flex items-center gap-1">
                    <span className="text-sm">PÇ</span>
                    <Input
                      key={pc}
                      id={`pc-${i}`}
                      aria-label={`S${i + 1} PÇ türü`}
                      type="number"
                      min={1}
                      max={99}
                      disabled={!editable}
                      defaultValue={pc.slice(2)}
                      onBlur={(e) => {
                        const value = `PÇ${e.target.value}`;
                        if (validPcCode(value)) {
                          const map = [...sessionRef.current.pcMap];
                          map[i] = value as PcCode;
                          updateMeta({ pcMap: map });
                        } else {
                          e.target.value = sessionRef.current.pcMap[i].slice(2);
                          toast.error("PÇ türü 1–99 arasında olmalı.");
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
          <Card id="live-scan" className="scan-card">
            <CardHeader>
              <CardTitle className="section-title"><span className="step-number">02</span><span>Görüntü ekleme yöntemi</span><span className="camera-badge"><span /> CANLI TARAMA</span></CardTitle>
            </CardHeader>
            <CardContent>
              <div className="mb-4 grid grid-cols-2 gap-2" role="group" aria-label="Görüntü ekleme yöntemi">
                {([
                  ["stable", "Mevcut otomatik tarama"],
                  ["manual", "Seri fotoğraf çekimi"],
                  ["rapid", "Hızlı otomatik yakalama"],
                  ["gallery", "Galeriden toplu yükle"],
                ] as const).map(([value, label]) => (
                  <Button key={value} variant={captureMethod === value ? "default" : "outline"}
                    className="h-auto whitespace-normal py-3" aria-pressed={captureMethod === value}
                    disabled={importing} onClick={() => setCaptureMethod(value)}>{label}</Button>
                ))}
              </div>
              {captureMethod === "rapid" ? (
                <RapidCamera questionCount={session.pcMap.length}
                  enabled={usable && uploads < MAX_PENDING && !importing} onCapture={capture}/>
              ) : captureMethod !== "gallery" ? (
                <LiveCamera key={captureMethod} captureMode={captureMethod}
                  questionCount={session.pcMap.length}
                  enabled={usable && uploads < MAX_PENDING && !importing}
                  onCapture={capture} />
              ) : (
                <div className="rounded-xl border p-4 space-y-3">
                  <p className="text-sm text-muted-foreground">Tam sayfa veya üst form fotoğraflarını galeriden birlikte seçin. Tablo görüntünün içinden okunur; hizalama gerekmez. Fotoğraflar sırayla kaydedilip aktarılır; bilgisayar mevcut kuyruğu sırayla okumaya devam eder.</p>
                  <Button disabled={!usable || importing || uploads >= MAX_PENDING}
                    onClick={() => { replacement.current = null; gallery.current?.click(); }}>
                    <Upload className="size-4" />Fotoğrafları seç
                  </Button>
                </div>
              )}
              <p className="mt-3 text-xs text-muted-foreground">{captureMethod === "rapid"
                ? "Uygun form ilk net algılamada yakalanır. Aynı kâğıt yeniden çekilmez; sıradakini koymadan önce kâğıdı çerçeveden çıkarın. Netlik için mevcut otomatik taramayı da seçebilirsiniz."
                : "Fotoğrafı ekledikten sonra OCR sonucunu beklemeden devam edin. Hedef görüntü başına 3–5 saniyede aktarım; süre bağlantı ve cihaza bağlıdır."}</p>
              {sync.lastTransferMs !== null && <p className="mt-2 text-sm text-success-text" role="status">Son fotoğraf bilgisayara aktarıldı · kayıt sonrası {(sync.lastTransferMs / 1000).toFixed(1)} sn · OCR sırayla devam ediyor.</p>}
              {importProgress && <p role="status" aria-live="polite" className="mt-2 text-sm">{importProgress}</p>}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  disabled={!usable || importing || uploads >= MAX_PENDING}
                  onClick={() => {
                    replacement.current = null;
                    gallery.current?.click();
                  }}
                >
                  <Upload className="size-4" />
                  Galeriden fotoğraf seç
                </Button>
                <Button
                  variant="ghost"
                  disabled={!usable}
                  onClick={manual}
                >
                  <PencilLine className="size-4" />
                  Elle satır ekle
                </Button>
                <label className="text-sm">
                  Okuma:{" "}
                  <select
                    aria-label="Okuma kontrolü"
                    value={mode}
                    onChange={(e) => setMode(e.target.value as CheckMode)}
                    className="rounded-lg border border-input bg-muted p-2 text-foreground"
                  >
                    <option value="single">Tek · hızlı</option>
                    <option value="double">Çift · karşılaştırmalı</option>
                  </select>
                </label>
              </div>
              <input
                ref={gallery}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={async (e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = "";
                  const replacementId = replacement.current;
                  replacement.current = null;
                  const selectedFiles = replacementId
                    ? files.slice(0, 1)
                    : files;
                  if (!selectedFiles.length || importLock.current) return;
                  importLock.current = true;
                  setImporting(true);
                  let saved = 0;
                  try {
                    for (const file of selectedFiles) {
                      setImportProgress(`${saved + 1}/${selectedFiles.length} fotoğraf hazırlanıyor…`);
                      await capture(await prepareCaptureImage(file), replacementId || undefined, "gallery");
                      saved++;
                      setImportProgress(`${saved}/${selectedFiles.length} fotoğraf bu cihazda kaydedildi · bilgisayara aktarılıyor.`);
                    }
                    toast.success(`${saved} fotoğraf kaydedildi; aktarım ve okuma arka planda sürüyor.`);
                  } catch (error) {
                    setImportProgress(`${saved}/${selectedFiles.length} fotoğraf kaydedildi. Kalan ${selectedFiles.length - saved} fotoğraf eklenmedi; tekrar seçebilirsiniz.`);
                    toast.error(error instanceof Error ? error.message : "Görüntü eklenemedi.");
                  } finally { importLock.current = false; setImporting(false); }
                }}
              />
            </CardContent>
          </Card>
          <Card className="queue-card">
            <CardHeader>
              <CardTitle className="section-title queue-title"><span className="queue-heading-icon"><Layers3 className="size-5" /></span><span>Okuma kuyruğu</span></CardTitle>
            </CardHeader>
            <CardContent className="queue-content">
              <div className="queue-stats">
                {[
                  ["Bekleyen", pending],
                  ["Okunan", completed],
                  [
                    "Hatalı",
                    session.rows.filter((row) => row.status === "error").length,
                  ],
                ].map(([label, count]) => (
                  <div key={label} className="queue-stat">
                    <p>{label}</p>
                    <p>{count}</p>
                  </div>
                ))}
              </div>
              <p
                className={`queue-status rounded-xl border p-3 text-sm ${status?.ready ? "border-success-border bg-success-soft" : "border-warning-border bg-warning-soft"}`}
                role="status"
              >
                {status?.message || "Yerel okuyucu kontrol ediliyor…"}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="queue-check"
                onClick={() => void readerStatus().then(setStatus)}
              >
                Okuyucuyu kontrol et
              </Button>
              {progress && (
                <p
                  className="queue-progress flex items-start gap-2 rounded-xl bg-info-soft p-3 text-sm text-info-text"
                  role="status"
                >
                  <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" />
                  {progress}
                </p>
              )}
              <div className="queue-actions">
                <Button
                  variant="outline"
                  disabled={!usable}
                  onClick={() => void sync.command({ action: "pause", paused: !paused }).catch(() => undefined)}
                >
                  {paused ? "Kuyruğu sürdür" : "Yeni okumaları beklet"}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    !session.rows.some((row) => row.status === "reading")
                  }
                  onClick={() => { const row = session.rows.find(value => value.status === "reading"); if (row) void sync.command({ action: "cancel", id: row.id }).catch(() => undefined); }}
                >
                  Aktif okumayı iptal et
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
        <Card id="results" className="results-card overflow-hidden">
          <CardHeader className="flex flex-wrap flex-row items-center justify-between gap-3">
            <div>
              <CardTitle className="section-title"><span className="step-number">03</span><span>Öğrenci sonuçları<small>{session.rows.length} kayıt</small></span></CardTitle>
              <div className="results-legend" title="Hücreler doğrudan düzenlenebilir. Renkler doğruluk garantisi değildir.">
                <span><i aria-hidden="true" />Kontrol önerilir</span>
                <span><i aria-hidden="true" />Şüphe yok / kontrol edildi</span>
              </div>
            </div>
            <Button
              onClick={() => {
                try {
                  exportExamWorkbook(sessionExam(sessionRef.current));
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : "Excel oluşturulamadı.",
                  );
                }
              }}
            >
              <FileSpreadsheet className="size-4" />
              Excel’i indir
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {excessiveRows.length > 0 && <div role="alert" className="border-b border-danger-border bg-danger-soft px-4 py-3 text-sm text-danger-text">
              {excessiveRows.join(", ")}. satırda puan toplamı 100’ü aşıyor. Bu sonuç onaylanamaz; şüpheli puanları kaynak kâğıtla kontrol edin. Puanlar 100’e kırpılmaz veya toplamdan türetilmez.
            </div>}
            <Table>
              <TableHeader>
                <TableRow className="bg-muted">
                  <TableHead>Durum</TableHead>
                  <TableHead>Öğrenci no</TableHead>
                  <TableHead>Ad soyad</TableHead>
                  {session.pcMap.map((pc, i) => (
                    <TableHead key={i}>
                      S{i + 1}
                      <span className="block text-xs text-muted-foreground">{pc}</span>
                    </TableHead>
                  ))}
                  <TableHead>Yazılı toplam</TableHead>
                  <TableHead>Hesaplanan</TableHead>
                  <TableHead>İşlem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!session.rows.length && (
                  <TableRow>
                    <TableCell
                      colSpan={session.pcMap.length + 6}
                      className="empty-results text-center text-muted-foreground"
                    >
                      <div className="empty-results-icon"><FileSpreadsheet className="size-6" /></div>
                      <p className="font-semibold text-foreground">İlk kâğıtla başlayın</p>
                      <a href="#live-scan" className="empty-results-link">Tarama alanına geç <ArrowUpRight className="size-3.5" /></a>
                    </TableCell>
                  </TableRow>
                )}
                {session.rows.map((row, index) => (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-40 whitespace-normal text-xs">
                      <p className="font-medium">
                        {index + 1}.{" "}
                        {row.status === "queued"
                          ? "Sırada"
                          : row.status === "reading"
                            ? "Okunuyor…"
                            : row.status === "error"
                              ? "Hata"
                              : "Okundu"}
                      </p>
                      {row.status === "done" &&
                        metadataWarnings(session, row).length > 0 &&
                        row.metadataApproval !==
                          metadataSignature(session, row) && (
                          <p className="mt-1 text-warning-text">
                            Ders / PÇ kontrolü
                          </p>
                        )}
                      {row.error && (
                        <p className="mt-1 text-danger-text">{row.error}</p>
                      )}
                      {row.draft.elapsedMs && (
                        <p>{(row.draft.elapsedMs / 1000).toFixed(1)} sn</p>
                      )}
                    </TableCell>
                    {cellKeys(session.pcMap.length).map((key) => (
                      <TableCell key={key} className="p-1">
                        <EditableCell
                          session={session}
                          row={row}
                          field={key}
                          disabled={!editable}
                          onEdit={(value) =>
                            void updateRow(row.id, (current) =>
                              editCell(current, key, value),
                            ).catch(() => undefined)
                          }
                        />
                      </TableCell>
                    ))}
                    <TableCell className="text-center tabular-nums">
                      {sumScores(row.draft.scores) ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => { setPhoto(null); setSelected(row.id); }}
                        >
                          Kontrol
                        </Button>
                        {row.status === "error" && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!usable || importing || uploads >= MAX_PENDING}
                              onClick={() =>
                                void updateRow(row.id, (current) => ({
                                  ...current,
                                  status: "queued",
                                  error: undefined,
                                })).catch(() => undefined)
                              }
                            >
                              Tekrar
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`${index + 1}. satır görüntüsünü yenile`}
                              disabled={!usable || importing || uploads >= MAX_PENDING}
                              onClick={() => {
                                replacement.current = row.id;
                                gallery.current?.click();
                              }}
                            >
                              Görüntüyü yenile
                            </Button>
                          </>
                        )}
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={!editable || row.status === "reading"}
                          aria-label={`${index + 1}. satırı sil`}
                          onClick={() => void remove(row)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
          {issues.length > 0 && (
            <p
              className="border-t bg-warning-soft p-3 text-sm text-warning-text"
              role="status"
            >
              {issues.length} satır/ayar için kontrol önerilir. {issues[0]}
            </p>
          )}
        </Card>
        <details className="workspace-footnote text-xs leading-5 text-muted-foreground">
          <summary>Oturum ve veri saklama</summary>
          <p>
          Ortak tablo ve aktarılan kaynak fotoğraflar bilgisayarda saklanır.
          Telefon ve bilgisayar değişiklikleri yaklaşık bir saniyede görür.
          Excel’i almadan “Yeni sınav”ı kullanmayın; bu işlem tüm cihazlardaki
          ortak tabloyu temizler. Kamera için telefonda HTTPS gerekir.
          </p>
        </details>
      </div>
      <Dialog
        open={Boolean(selectedRow)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="flex max-h-[94dvh] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl [&>*]:min-w-0">
          <DialogHeader className="shrink-0 border-b px-4 py-4 pr-10 text-left">
            <DialogTitle>Satırı fotoğrafla kontrol edin</DialogTitle>
            <DialogDescription>
              Fotoğraftaki alanlarla karşılaştırın; gerekirse okunan değerleri düzenleyin.
            </DialogDescription>
          </DialogHeader>
          {selectedRow && (
            <>
              <div className="flex min-h-0 flex-col overflow-hidden lg:grid lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                <section aria-label="Kaynak fotoğraf" className="shrink-0 border-b bg-muted p-3 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">Kaynak fotoğraf</h3>
                    {photoUrl && <Button variant="outline" size="sm" className="h-8 bg-card" aria-pressed={photoZoom}
                      onClick={() => setZoomedPhoto(photoZoom ? null : selected)}>
                      {photoZoom ? <ZoomOut className="size-4" /> : <ZoomIn className="size-4" />}
                      {photoZoom ? "Sığdır" : "Büyüt"}
                    </Button>}
                  </div>
                  {photoUrl ? (
                    <div className="max-h-[30dvh] overflow-auto rounded-lg border bg-card lg:max-h-[65dvh]" tabIndex={0} aria-label="Fotoğraf görünümü; büyütüldüğünde kaydırabilirsiniz">
                      <img src={photoUrl} alt="Bu satırın kaynak sınav kâğıdı"
                        className={photoZoom ? "block w-[180%] max-w-none" : "mx-auto block max-h-[30dvh] w-full object-contain lg:max-h-none"} />
                    </div>
                  ) : (
                    <p className="py-6 text-sm text-muted-foreground">
                      {selectedRow.hasPhoto ? "Kaynak görüntü yükleniyor / bulunamadı." : "Elle girilen satır; kaynak fotoğraf yok."}
                    </p>
                  )}
                </section>
                <section aria-label="Okunan veriler" className="min-h-0 space-y-4 overflow-y-auto p-4">
                  <h3 className="text-sm font-semibold">Okunan veriler</h3>
                  <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
                    {reviewField("fullName")}
                    {reviewField("studentNumber")}
                  </div>
                  <div className="border-t pt-3">
                    <h4 className="mb-3 text-xs font-semibold text-muted-foreground">Puanlar · kâğıttaki sırayla</h4>
                    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(session.pcMap.length, 5)}, minmax(0, 1fr))` }}>
                      {cellKeys(session.pcMap.length).filter(key => /^s\d+$/.test(key)).map(reviewField)}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted p-3">
                    {reviewField("writtenTotal")}
                    <div className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">Hesaplanan toplam</p>
                      <p className="flex h-10 items-center px-3 text-lg font-semibold tabular-nums">{sumScores(selectedRow.draft.scores) ?? "—"}</p>
                    </div>
                  </div>
                  {approvalProblem && <p role="alert" className="rounded-lg bg-warning-soft p-3 text-xs leading-5 text-warning-text">{approvalProblem}</p>}
                  {totalMismatch && <p className="rounded-lg bg-warning-soft p-3 text-xs leading-5 text-warning-text">Yazılı toplam ({selectedRow.draft.writtenTotal}) ve puan toplamı ({scoreSum}) farklı. Puanları ve toplamı fotoğrafla karşılaştırın.</p>}
                  {!!metadataReview.length && (
                    <div className="rounded-lg bg-warning-soft p-3 text-xs leading-5 text-warning-text">
                      <p className="font-medium">Ders / PÇ bilgilerini fotoğrafla karşılaştırın.</p>
                      <ul className="mt-1 space-y-1">{metadataReview.map(warning => <li key={warning}>{warning}</li>)}</ul>
                    </div>
                  )}
                  {rosterMatch && <div className="rounded-lg border border-input p-3 text-sm">
                    <p className="font-medium">{rosterMatch.status === "matched" ? "Excel öğrenci listesiyle eşleşti" : rosterMatch.status === "ambiguous" ? "Excel eşleşmesi için kontrol gerekiyor" : "Excel listesinde uygun eşleşme bulunamadı"}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Kâğıttan okunan: {rosterMatch.original.studentNumber || "Numara okunamadı"} · {rosterMatch.original.fullName || "İsim okunamadı"}</p>
                    {rosterMatch.reason === "number-name-conflict" && <p className="mt-1 text-xs text-warning-text">Okunan numara Excel listesinde farklı bir isme ait. Kâğıttaki isim korundu; listeyi ve numarayı karşılaştırın.</p>}
                    {rosterMatch.reason === "number-not-listed" && <p className="mt-1 text-xs text-warning-text">Okunan numaranın Excel listesinde birebir karşılığı yok. Başka bir öğrenciye atanmadı; kâğıttaki isim ve numarayı kontrol edin.</p>}
                    {rosterMatch.status === "matched" && <p className="mt-1 text-xs">Listeden alınan: {rosterMatch.student?.studentNumber} · {rosterMatch.student?.fullName}</p>}
                    {rosterMatch.status === "ambiguous" && <p className="mt-1 text-xs">Yakın adaylar: {rosterMatch.candidates.map(student => `${student.studentNumber} · ${student.fullName}`).join(" / ")}. Özgün okuma korundu.</p>}
                  </div>}
                  {!!readingDetails.length && (
                    <details className="text-xs leading-5 text-muted-foreground">
                      <summary className="cursor-pointer">Okuma ayrıntıları</summary>
                      <ul className="mt-2 space-y-2">{readingDetails.map(detail => <li key={detail}>{detail}</li>)}</ul>
                    </details>
                  )}
                </section>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t bg-card px-4 py-3">
              {selectedRow.status === "done" && selectedRow.hasPhoto && <div className="mr-auto space-y-1">
                <Button variant="outline" disabled={!usable || writing > 0} onClick={() =>
                  void sync.command({ action: "reread", id: selectedRow.id, signature: rowSignature(selectedRow, sessionRef.current) })
                    .then(() => { setSelected(null); toast.success("Kaynak fotoğraf yeniden okuma sırasına alındı."); }).catch(() => undefined)}>
                  <ScanLine className="size-4" />Yeniden oku
                </Button>
                <p className="text-xs text-muted-foreground">Elle düzenlediğiniz dolu hücreler korunur; boş hücreler yeniden okunur.</p>
              </div>}
              {selectedRow.status === "error" && (
                <Button
                  variant="outline"
                  disabled={!usable}
                  onClick={() =>
                    void updateRow(selectedRow.id, (row) => ({
                      ...row,
                      status: "done",
                    })).catch(() => undefined)
                  }
                >
                  Okuma yerine elle tamamla
                </Button>
              )}
              <Button
                className="h-auto w-full whitespace-normal py-2 sm:w-auto"
                disabled={!editable || writing > 0 || Boolean(approvalProblem)}
                onClick={() => approve(selectedRow)}
              >
                <CheckCircle2 className="size-4" />
                Karşılaştırdım, satırı onayla
              </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
function EditableCell({
  session,
  row,
  field,
  disabled,
  onEdit,
  compact = false,
}: {
  session: ScanSession;
  row: ScanRow;
  field: CellKey;
  disabled: boolean;
  onEdit: (value: string) => void;
  compact?: boolean;
}) {
  const state = cellState(session, row, field);
  const compactNumber = compact && field !== "fullName" && field !== "studentNumber";
  return (
    <div className="relative">
      <Input
        data-review-color={state.color}
        id={compact ? `review-${row.id}-${field}` : undefined}
        aria-label={`${row.id} ${field}`}
        title={state.reason}
        disabled={disabled}
        value={cellValue(row, field)}
        inputMode={
          field === "fullName"
            ? "text"
            : field === "studentNumber"
              ? "numeric"
              : "decimal"
        }
        onChange={(e) => onEdit(e.target.value)}
        className={`review-cell ${compact ? "min-w-0" : field === "fullName" ? "min-w-48" : field === "studentNumber" ? "min-w-36" : "min-w-20"} ${field === "studentNumber" ? "font-mono" : ""} ${compactNumber ? "px-1 text-center text-base font-semibold tabular-nums" : "pr-6"} ${state.color === "yellow" ? "border-warning-border bg-warning-soft" : state.color === "green" ? "border-success-border bg-success-soft" : "bg-muted"}`}
      />
      {state.color === "yellow" && !compactNumber ? (
        <AlertTriangle
          aria-label={state.reason}
          className="pointer-events-none absolute right-2 top-3 size-3 text-warning-text"
        />
      ) : state.color === "green" && !compactNumber ? (
        <CheckCircle2
          aria-label={state.reason}
          className="pointer-events-none absolute right-2 top-3 size-3 text-success-text"
        />
      ) : null}
    </div>
  );
}
