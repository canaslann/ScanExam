"use client";
/* eslint-disable @next/next/no-img-element -- Source photos are fetched from the local computer, never an image optimizer. */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, LoaderCircle, PencilLine, ScanLine, Trash2, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LiveCamera } from "@/components/live-camera";
import { exportExamWorkbook, MAX_QUESTIONS, validPcCode, validQuestionCount, type PcCode } from "@/lib/exam";
import { sumScores, type CheckMode } from "@/lib/reader-contract";
import { approvalIssue, cellKeys, cellState, cellValue, editCell, exportIssues, MAX_PENDING, metadataSignature, metadataWarnings, rowSignature, sessionExam, type CellKey, type ScanRow, type ScanSession } from "@/lib/scan-session";
import { sharedPhoto } from "@/lib/shared-client";
import { useSharedScan } from "@/hooks/use-shared-scan";

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
  const sync = useSharedScan();
  const { session, sessionRef, ready, error: storageError, paused, uploads, writing, updateRow, updateMeta } = sync;
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
  const progress = uploads > 0 ? `${uploads} görüntü bilgisayara aktarılmayı bekliyor · bu cihazda kayıtlı`
    : session.rows.some(row => row.status === "reading") ? "Bilgisayar arka planda okuyor · sonraki kâğıdı tarayabilirsiniz."
    : serverPending > 0 ? "Kâğıtlar bilgisayarda sırada · model hazırlanıyor veya sıra bekliyor; taramaya devam edebilirsiniz."
    : ready ? "Telefon / bilgisayar ortak tabloya bağlı · değişiklikler otomatik güncellenir." : "";
  const issues = exportIssues(session), selectedRow = session.rows.find(row => row.id === selected);
  const editable = sync.connected, usable = editable;
  const completed = session.rows.filter(row => row.status === "done").length;
  const approvalProblem = selectedRow ? approvalIssue(session, selectedRow) : undefined;
  const metadataReview = selectedRow && selectedRow.metadataApproval !== metadataSignature(session, selectedRow)
    ? metadataWarnings(session, selectedRow) : [];
  const readingDetails = [...new Set(selectedRow?.draft.warnings || [])];
  const scoreSum = selectedRow ? sumScores(selectedRow.draft.scores) : null;
  const totalMismatch = selectedRow && scoreSum !== null && !approvalProblem &&
    cellState(session, selectedRow, "writtenTotal").color === "yellow" &&
    Number(selectedRow.draft.writtenTotal.replace(",", ".")) !== scoreSum;
  function reviewField(key: CellKey) {
    if (!selectedRow) return null;
    const question = /^s\d+$/.test(key);
    return (
      <div key={key} className="min-w-0 space-y-1.5">
        <Label htmlFor={`review-${selectedRow.id}-${key}`} className="text-xs text-slate-600">
          {key === "fullName" ? "Ad soyad" : key === "studentNumber" ? "Öğrenci no" : key === "writtenTotal" ? "Kâğıtta yazan toplam" : key.toUpperCase()}
          {question && <span className="ml-1 text-[10px] text-slate-400">{session.pcMap[Number(key.slice(1)) - 1]}</span>}
        </Label>
        <EditableCell compact session={session} row={selectedRow} field={key} disabled={!editable}
          onEdit={value => void updateRow(selectedRow.id, row => editCell(row, key, value)).catch(() => undefined)} />
        {!!selectedRow.draft.alternatives?.[key]?.length && (
          <details className="text-xs text-amber-800">
            <summary className="cursor-pointer">Alternatifler</summary>
            <p className="mt-1 break-words">{selectedRow.draft.alternatives[key].join(" / ")}</p>
          </details>
        )}
      </div>
    );
  }
  async function capture(blob: Blob, replacementId?: string) {
    if (!usable) throw new Error("Bilgisayar bağlantısı hazır değil; görüntü korunmalı.");
    if (pending >= MAX_PENDING) throw new Error("Kuyruk dolu; aktarımların/okumaların tamamlanmasını bekleyin.");
    await sync.capture(blob, mode, replacementId);
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
    <main className="min-h-screen pb-10 text-slate-900">
      <Toaster richColors position="top-center" />
      <header className="border-b border-slate-200 bg-white px-4 py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <ScanLine className="size-7 text-primary" />
            <div>
              <h1 className="text-xl font-bold">Sınav Tarayıcı</h1>
              <p className="text-xs text-slate-500">
                Canlı tarama · yerel okuyucu · düzenlenebilir tablo
              </p>
            </div>
          </div>
          <Button
            variant="outline"
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
            Yeni sınav
          </Button>
        </div>
      </header>
      <div className="mx-auto max-w-7xl space-y-5 px-4 pt-5">
        {storageError && (
          <div
            role="alert"
            className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900"
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
        <Card>
          <CardHeader>
            <CardTitle>Sınav ve soru düzeni</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
            <p className="text-sm text-slate-600">
              Her sorunun PÇ türünü belirleyin (PÇ1–PÇ99). Soru sayısı ilk
              kayıttan sonra korunur; farklı sınav için “Yeni sınav”.
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
          <Card className="scan-card border-0 text-white">
            <CardHeader>
              <CardTitle>Kâğıdı kameraya tutun</CardTitle>
            </CardHeader>
            <CardContent>
              <LiveCamera
                questionCount={session.pcMap.length}
                enabled={usable && pending < MAX_PENDING}
                onCapture={capture}
              />
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  disabled={!usable || pending >= MAX_PENDING}
                  className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white"
                  onClick={() => {
                    replacement.current = null;
                    gallery.current?.click();
                  }}
                >
                  <Upload className="size-4" />
                  Fotoğraf seç
                </Button>
                <Button
                  variant="ghost"
                  disabled={!usable}
                  className="text-white hover:bg-white/10 hover:text-white"
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
                    className="rounded border border-white/20 bg-slate-900 p-2"
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
                  for (const file of selectedFiles) {
                    try {
                      await capture(file, replacementId || undefined);
                    } catch (error) {
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : "Görüntü eklenemedi.",
                      );
                      break;
                    }
                  }
                }}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Okuma kuyruğu</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["Bekleyen", pending],
                  ["Okunan", completed],
                  [
                    "Hatalı",
                    session.rows.filter((row) => row.status === "error").length,
                  ],
                ].map(([label, count]) => (
                  <div key={label} className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">{label}</p>
                    <p className="text-2xl font-bold">{count}</p>
                  </div>
                ))}
              </div>
              <p
                className={`rounded-xl border p-3 text-sm ${status?.ready ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}
                role="status"
              >
                {status?.message || "Yerel okuyucu kontrol ediliyor…"}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void readerStatus().then(setStatus)}
              >
                Okuyucuyu kontrol et
              </Button>
              {progress && (
                <p
                  className="flex items-start gap-2 rounded-xl bg-cyan-50 p-3 text-sm text-cyan-900"
                  role="status"
                >
                  <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" />
                  {progress}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
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
              <p className="text-xs leading-5 text-slate-600">
                Kamera açıkken model sırayla okur; aynı anda en fazla bir okuma
                yapılır. Yeşil tikten sonra sonraki kâğıda geçebilirsiniz.
                Görüntü önce bu cihaza kaydedilir, sonra bilgisayara aktarılır.
                Aktarılan görüntülerin okunması telefon kapansa da sürer;
                aktarılmamış görüntüler için bu sekmeyi açık tutun.
              </p>
              <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm leading-6 text-blue-950">
                1. Soru sayısı ve PÇ’leri ayarla.
                <br />
                2. Yeşil tikten sonra yeni kâğıda geç.
                <br />
                3. İstersen sarı hücreleri fotoğrafla karşılaştır; tabloda düzenle
                veya satırı kontrol et.
                <br />
                4. Excel’i indir.
              </div>
            </CardContent>
          </Card>
        </div>
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-wrap flex-row items-center justify-between gap-3">
            <div>
              <CardTitle>
                Öğrenci sonuçları · {session.rows.length} satır
              </CardTitle>
              <p className="mt-2 text-xs text-slate-600">
                Hücreler doğrudan düzenlenebilir.{" "}
                <span className="rounded bg-amber-100 px-1 text-amber-900">
                  Sarı: kontrol önerilir
                </span>{" "}
                ·{" "}
                <span className="rounded bg-emerald-100 px-1 text-emerald-900">
                  Yeşil: şüphe bildirilmedi / kontrol edildi
                </span>
                . Renkler doğruluk garantisi değildir.
              </p>
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
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead>Durum</TableHead>
                  <TableHead>Öğrenci no</TableHead>
                  <TableHead>Ad soyad</TableHead>
                  {session.pcMap.map((pc, i) => (
                    <TableHead key={i}>
                      S{i + 1}
                      <span className="block text-xs text-slate-500">{pc}</span>
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
                      className="h-24 text-center text-slate-500"
                    >
                      Tablo hazır. Kâğıtlar tarandıkça satırlar burada
                      görünecek.
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
                          <p className="mt-1 text-amber-700">
                            Ders / PÇ kontrolü
                          </p>
                        )}
                      {row.error && (
                        <p className="mt-1 text-red-700">{row.error}</p>
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
                              disabled={!usable || pending >= MAX_PENDING}
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
                              disabled={!usable || pending >= MAX_PENDING}
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
              className="border-t bg-amber-50 p-3 text-sm text-amber-900"
              role="status"
            >
              {issues.length} satır/ayar için kontrol önerilir.{" "}
              {issues[0]} Kontrol isteğe bağlıdır; Excel’i istediğiniz zaman
              mevcut tabloyla indirebilirsiniz.
            </p>
          )}
        </Card>
        <p className="text-xs leading-5 text-slate-500">
          Ortak tablo ve aktarılan kaynak fotoğraflar bilgisayarda saklanır.
          Telefon ve bilgisayar değişiklikleri yaklaşık bir saniyede görür.
          Excel’i almadan “Yeni sınav”ı kullanmayın; bu işlem tüm cihazlardaki
          ortak tabloyu temizler. Kamera için telefonda HTTPS gerekir.
        </p>
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
                <section aria-label="Kaynak fotoğraf" className="shrink-0 border-b bg-slate-50 p-3 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">Kaynak fotoğraf</h3>
                    {photoUrl && <Button variant="outline" size="sm" className="h-8 bg-white" aria-pressed={photoZoom}
                      onClick={() => setZoomedPhoto(photoZoom ? null : selected)}>
                      {photoZoom ? <ZoomOut className="size-4" /> : <ZoomIn className="size-4" />}
                      {photoZoom ? "Sığdır" : "Büyüt"}
                    </Button>}
                  </div>
                  {photoUrl ? (
                    <div className="max-h-[30dvh] overflow-auto rounded-lg border bg-white lg:max-h-[65dvh]" tabIndex={0} aria-label="Fotoğraf görünümü; büyütüldüğünde kaydırabilirsiniz">
                      <img src={photoUrl} alt="Bu satırın kaynak sınav kâğıdı"
                        className={photoZoom ? "block w-[180%] max-w-none" : "mx-auto block max-h-[30dvh] w-full object-contain lg:max-h-none"} />
                    </div>
                  ) : (
                    <p className="py-6 text-sm text-slate-500">
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
                    <h4 className="mb-3 text-xs font-semibold text-slate-500">Puanlar · kâğıttaki sırayla</h4>
                    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(session.pcMap.length, 5)}, minmax(0, 1fr))` }}>
                      {cellKeys(session.pcMap.length).filter(key => /^s\d+$/.test(key)).map(reviewField)}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 rounded-lg border bg-slate-50 p-3">
                    {reviewField("writtenTotal")}
                    <div className="space-y-1.5">
                      <p className="text-xs font-medium text-slate-600">Hesaplanan toplam</p>
                      <p className="flex h-10 items-center px-3 text-lg font-semibold tabular-nums">{sumScores(selectedRow.draft.scores) ?? "—"}</p>
                    </div>
                  </div>
                  {approvalProblem && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">{approvalProblem}</p>}
                  {totalMismatch && <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">Yazılı toplam ({selectedRow.draft.writtenTotal}) ve puan toplamı ({scoreSum}) farklı. Puanları ve toplamı fotoğrafla karşılaştırın.</p>}
                  {!!metadataReview.length && (
                    <div className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                      <p className="font-medium">Ders / PÇ bilgilerini fotoğrafla karşılaştırın.</p>
                      <ul className="mt-1 space-y-1">{metadataReview.map(warning => <li key={warning}>{warning}</li>)}</ul>
                    </div>
                  )}
                  {!!readingDetails.length && (
                    <details className="text-xs leading-5 text-slate-500">
                      <summary className="cursor-pointer">Okuma ayrıntıları</summary>
                      <ul className="mt-2 space-y-2">{readingDetails.map(detail => <li key={detail}>{detail}</li>)}</ul>
                    </details>
                  )}
                </section>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t bg-white px-4 py-3">
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
        className={`${compact ? "min-w-0" : field === "fullName" ? "min-w-48" : field === "studentNumber" ? "min-w-36" : "min-w-20"} ${field === "studentNumber" ? "font-mono" : ""} ${compactNumber ? "px-1 text-center text-base font-semibold tabular-nums" : "pr-6"} ${state.color === "yellow" ? "border-amber-300 bg-amber-50" : state.color === "green" ? "border-emerald-200 bg-emerald-50" : "bg-slate-50"}`}
      />
      {state.color === "yellow" && !compactNumber ? (
        <AlertTriangle
          aria-label={state.reason}
          className="pointer-events-none absolute right-2 top-3 size-3 text-amber-600"
        />
      ) : state.color === "green" && !compactNumber ? (
        <CheckCircle2
          aria-label={state.reason}
          className="pointer-events-none absolute right-2 top-3 size-3 text-emerald-600"
        />
      ) : null}
    </div>
  );
}
