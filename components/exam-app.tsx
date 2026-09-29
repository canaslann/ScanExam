"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Camera, CheckCircle2, FileSpreadsheet, LoaderCircle,
  PencilLine, RotateCcw, ScanLine, ShieldCheck, Trash2, Upload,
} from "lucide-react";
import { Toaster, toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DEFAULT_EXAM, EMPTY_DRAFT, exportExamWorkbook, toNumber,
  type ExamState, type PcCode, type ScanDraft, type StudentResult,
} from "@/lib/exam";
import { readExamPaper } from "@/lib/ocr";

const STORAGE_KEY = "sinav-tarayici-v1";
const PC_OPTIONS: PcCode[] = ["PÇ1", "PÇ2", "PÇ3", "PÇ4", "PÇ5"];

type ModelContext = {
  registerTool: (tool: {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
    execute: (input: unknown) => unknown | Promise<unknown>;
  }, options?: { signal?: AbortSignal }) => void | Promise<void>;
};

export function ExamApp() {
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const examRef = useRef<ExamState>(DEFAULT_EXAM);
  const [exam, setExam] = useState<ExamState>(DEFAULT_EXAM);
  const [hydrated, setHydrated] = useState(false);
  const [draft, setDraft] = useState<ScanDraft>(EMPTY_DRAFT);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("Model hazırlanıyor");
  const [reviewing, setReviewing] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setExam(JSON.parse(saved) as ExamState);
    } catch {
      toast.warning("Önceki cihaz kaydı açılamadı; yeni bir sınavla devam ediliyor.");
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    examRef.current = exam;
    if (hydrated) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(exam));
  }, [exam, hydrated]);

  useEffect(() => {
    if (!cameraOpen) return;
    let active = true;
    navigator.mediaDevices?.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    }).then((stream) => {
      if (!active) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    }).catch(() => {
      setCameraOpen(false);
      toast.error("Kamera açılamadı. Fotoğraf seçerek devam edebilirsiniz.");
    });
    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [cameraOpen]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = async () => {
      await context.registerTool({
        name: "get_exam_summary",
        title: "Sınav özetini getir",
        description: "Aktif sınavın ders bilgisini, öğrenci sayısını ve not ortalamasını döndürür.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: () => {
          const current = examRef.current;
          const average = current.results.length
            ? current.results.reduce((sum, item) => sum + item.writtenTotal, 0) / current.results.length
            : null;
          return { courseCode: current.courseCode, courseName: current.courseName, studentCount: current.results.length, average };
        },
      }, { signal: lifecycle.signal });
    };
    void register().catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  const summary = useMemo(() => {
    if (!exam.results.length) return { average: "—", highest: "—", review: 0 };
    const average = exam.results.reduce((sum, result) => sum + result.writtenTotal, 0) / exam.results.length;
    return {
      average: average.toFixed(2).replace(".", ","),
      highest: Math.max(...exam.results.map((result) => result.writtenTotal)).toString().replace(".", ","),
      review: exam.results.filter((result) => result.needsReview).length,
    };
  }, [exam.results]);

  const calculatedTotal = draft.scores.reduce((sum, value) => sum + toNumber(value), 0);
  const totalMismatch = draft.writtenTotal !== "" && Math.abs(calculatedTotal - toNumber(draft.writtenTotal)) > 0.001;

  function updateExam(patch: Partial<ExamState>) {
    setExam((current) => ({ ...current, ...patch }));
  }

  function updateDraft<K extends keyof ScanDraft>(key: K, value: ScanDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function handleFile(file?: File) {
    if (!file) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const nextUrl = URL.createObjectURL(file);
    setPreviewUrl(nextUrl);
    setDraft(EMPTY_DRAFT);
    setReviewing(true);
    setProcessing(true);
    setProgress(4);
    setProgressLabel("Görüntü hazırlanıyor");
    try {
      const result = await readExamPaper(file, (nextProgress, label) => {
        setProgress(Math.round(nextProgress * 100));
        setProgressLabel(label);
      });
      setDraft(result);
      if (examRef.current.results.length === 0) {
        setExam((current) => ({
          ...current,
          courseCode: result.courseCode || current.courseCode,
          courseName: result.courseName || current.courseName,
          pcMap: result.pcMap || current.pcMap,
        }));
      }
      setProgress(100);
      toast.success("Okuma tamamlandı. Sarı alanları kontrol edin.");
    } catch (error) {
      console.error(error);
      setDraft(EMPTY_DRAFT);
      toast.warning("Otomatik okuma tamamlanamadı. Alanları elle doğrulayarak devam edebilirsiniz.");
    } finally {
      setProcessing(false);
    }
  }

  function openCamera() {
    const canUseLiveCamera = window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);
    if (canUseLiveCamera) {
      setCameraOpen(true);
      return;
    }
    cameraInputRef.current?.click();
  }

  function captureCamera() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      setCameraOpen(false);
      void handleFile(new File([blob], `sinav-${Date.now()}.jpg`, { type: "image/jpeg" }));
    }, "image/jpeg", 0.94);
  }

  function startManualEntry() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setDraft(EMPTY_DRAFT);
    setReviewing(true);
    setProcessing(false);
  }

  function saveResult() {
    const missingScores = draft.scores.some((score) => score.trim() === "");
    if (!draft.fullName.trim() || !draft.studentNumber.trim() || missingScores || draft.writtenTotal.trim() === "") {
      toast.error("Ad soyad, öğrenci numarası, tüm puanlar ve toplam not doldurulmalı.");
      return;
    }
    if (exam.results.some((result) => result.studentNumber === draft.studentNumber.trim())) {
      toast.error("Bu öğrenci numarası aktif sınava daha önce eklenmiş.");
      return;
    }
    const scores = draft.scores.map(toNumber) as StudentResult["scores"];
    const lowConfidence = Object.values(draft.confidence).some((value) => value < 60);
    const result: StudentResult = {
      id: crypto.randomUUID(),
      studentNumber: draft.studentNumber.trim(),
      fullName: draft.fullName.trim(),
      scores,
      writtenTotal: toNumber(draft.writtenTotal),
      calculatedTotal: scores.reduce((sum, score) => sum + score, 0),
      needsReview: lowConfidence || totalMismatch,
      createdAt: new Date().toISOString(),
    };
    setExam((current) => ({ ...current, results: [...current.results, result] }));
    resetScan();
    toast.success(`${result.fullName} Excel listesine eklendi.`);
  }

  function resetScan() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setDraft(EMPTY_DRAFT);
    setReviewing(false);
    setProcessing(false);
    setProgress(0);
    if (galleryInputRef.current) galleryInputRef.current.value = "";
    if (cameraInputRef.current) cameraInputRef.current.value = "";
  }

  function removeResult(id: string) {
    setExam((current) => ({ ...current, results: current.results.filter((result) => result.id !== id) }));
    toast.info("Öğrenci kaydı kaldırıldı.");
  }

  function downloadExcel() {
    if (!exam.results.length) return;
    exportExamWorkbook(exam);
    toast.success("Ortalamaları içeren Excel dosyası hazırlandı.");
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <Toaster position="top-center" richColors />
      <header className="sticky top-0 z-30 border-b border-border/80 bg-white/92 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm"><ScanLine className="size-5" aria-hidden="true" /></div>
            <div><p className="text-base font-bold tracking-tight">Sınav Tarayıcı</p><p className="text-xs text-muted-foreground">Kâğıttan tabloya, kontrollü ve hızlı</p></div>
          </div>
          <Badge variant="outline" className="gap-1.5 border-emerald-200 bg-emerald-50 text-emerald-700"><ShieldCheck className="size-3.5" aria-hidden="true" />Bu cihazda saklanır</Badge>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,.75fr)] lg:py-8">
        <section className="space-y-5">
          <Card className="overflow-hidden border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-100 bg-slate-50/70 pb-4">
              <div className="flex items-center justify-between gap-3">
                <div><p className="text-xs font-bold uppercase tracking-[0.15em] text-primary">Aktif sınav</p><CardTitle className="mt-1 text-xl">Sınav bilgileri</CardTitle></div>
                <Badge className="bg-slate-900 text-white">{exam.results.length} öğrenci</Badge>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 pt-5 sm:grid-cols-[.8fr_1.2fr]">
              <Field label="Ders kodu" id="course-code"><Input id="course-code" value={exam.courseCode} onChange={(event) => updateExam({ courseCode: event.target.value })} /></Field>
              <Field label="Ders adı" id="course-name"><Input id="course-name" value={exam.courseName} onChange={(event) => updateExam({ courseName: event.target.value })} /></Field>
              <div className="sm:col-span-2">
                <div className="mb-2 flex items-center justify-between"><Label>Soru–PÇ ilişkisi</Label><span className="text-xs text-muted-foreground">Sınav boyunca sabit</span></div>
                <div className="grid grid-cols-5 gap-2">
                  {exam.pcMap.map((pc, index) => (
                    <div key={index} className="rounded-xl border border-slate-200 bg-white p-2 text-center">
                      <p className="mb-1 text-xs font-semibold text-muted-foreground">S{index + 1}</p>
                      <Select value={pc} onValueChange={(value) => {
                        const next = [...exam.pcMap] as ExamState["pcMap"];
                        next[index] = value as PcCode;
                        updateExam({ pcMap: next });
                      }}>
                        <SelectTrigger className="h-8 w-full justify-center border-0 bg-slate-50 px-2 font-bold shadow-none"><SelectValue /></SelectTrigger>
                        <SelectContent>{PC_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {!reviewing ? (
            <ScanCard onCamera={openCamera} onFile={() => galleryInputRef.current?.click()} onManual={startManualEntry} />
          ) : (
            <ReviewCard draft={draft} setDraft={setDraft} previewUrl={previewUrl} processing={processing} progress={progress} progressLabel={progressLabel} calculatedTotal={calculatedTotal} totalMismatch={totalMismatch} onSave={saveResult} onCancel={resetScan} />
          )}
          <input ref={galleryInputRef} className="hidden" type="file" accept="image/*" onChange={(event) => void handleFile(event.target.files?.[0])} />
          <input ref={cameraInputRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={(event) => void handleFile(event.target.files?.[0])} />
        </section>

        <aside className="space-y-5">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><FileSpreadsheet className="size-5 text-emerald-600" aria-hidden="true" />Sınav özeti</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3"><Stat label="Kayıt" value={String(exam.results.length)} /><Stat label="Not ort." value={summary.average} /><Stat label="En yüksek" value={summary.highest} /><Stat label="Kontrol" value={String(summary.review)} /></div>
              {exam.results.length ? (
                <div className="mt-5 space-y-2">
                  {exam.results.slice(-3).reverse().map((result) => <div key={result.id} className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2.5"><div className="min-w-0"><p className="truncate text-sm font-semibold">{result.fullName}</p><p className="text-xs text-muted-foreground">{result.studentNumber}</p></div><Badge variant="outline" className="ml-3 tabular-nums">{result.writtenTotal}</Badge></div>)}
                </div>
              ) : (
                <div className="mt-5 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center"><p className="text-sm font-semibold text-slate-700">Henüz öğrenci eklenmedi</p><p className="mt-1 text-xs leading-5 text-muted-foreground">İlk kâğıdı taradığınızda kayıtlar burada görünecek.</p></div>
              )}
              <Button variant="outline" className="mt-4 w-full" disabled={!exam.results.length} onClick={downloadExcel}><FileSpreadsheet className="size-4" aria-hidden="true" />Excel’i indir</Button>
            </CardContent>
          </Card>
          <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-950"><p className="font-bold">Hızlı kullanım</p><ol className="mt-2 space-y-2 text-blue-900/80"><li><strong>1.</strong> Üst tabloyu kameraya hizalayın.</li><li><strong>2.</strong> Sarı işaretli alanları kontrol edin.</li><li><strong>3.</strong> Onaylayıp sonraki kâğıda geçin.</li></ol></div>
        </aside>

        <ResultsTable exam={exam} onRemove={removeResult} />
      </div>

      <Dialog open={cameraOpen} onOpenChange={setCameraOpen}>
        <DialogContent className="max-w-3xl overflow-hidden bg-slate-950 p-0 text-white">
          <DialogHeader className="px-5 pt-5"><DialogTitle>Üst şablonu hizalayın</DialogTitle><DialogDescription className="text-slate-300">Tablonun dört kenarı da turkuaz çerçeve içinde görünmeli.</DialogDescription></DialogHeader>
          <div className="relative mx-4 aspect-[4/3] overflow-hidden rounded-2xl bg-black">
            <video ref={videoRef} autoPlay playsInline muted className="size-full object-cover" />
            <div className="pointer-events-none absolute inset-x-[4%] top-[12%] aspect-[2.35/1] rounded-xl border-2 border-cyan-300 shadow-[0_0_0_999px_rgba(2,6,23,.42)]" />
          </div>
          <DialogFooter className="px-5 pb-5"><Button variant="outline" className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={() => setCameraOpen(false)}>Vazgeç</Button><Button className="bg-cyan-300 font-bold text-slate-950 hover:bg-cyan-200" onClick={captureCamera}><Camera className="size-4" />Fotoğrafı çek</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function ScanCard({ onCamera, onFile, onManual }: { onCamera: () => void; onFile: () => void; onManual: () => void }) {
  return <Card className="scan-card overflow-hidden border-0 text-white shadow-xl shadow-slate-900/10"><CardContent className="relative p-5 sm:p-7"><div className="pointer-events-none absolute inset-0 opacity-35" aria-hidden="true"><div className="scan-grid absolute inset-0" /><div className="absolute -right-12 -top-20 size-64 rounded-full bg-cyan-300/20 blur-3xl" /></div><div className="relative"><div className="mb-5 flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-200">Yeni kâğıt</p><h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">Üst bölümü çerçeveye yerleştirin</h1><p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">Ad soyad, öğrenci numarası, soru puanları ve toplam not cihazda okunacak.</p></div><div className="hidden size-14 place-items-center rounded-2xl border border-white/15 bg-white/10 sm:grid"><Camera className="size-7 text-cyan-200" aria-hidden="true" /></div></div><div className="paper-frame relative mb-5 aspect-[2.35/1] overflow-hidden rounded-2xl border border-dashed border-cyan-200/60 bg-slate-950/30"><span className="corner corner-tl" /><span className="corner corner-tr" /><span className="corner corner-bl" /><span className="corner corner-br" /><div className="absolute inset-0 grid place-items-center px-8 text-center"><div><ScanLine className="mx-auto mb-2 size-8 text-cyan-200" aria-hidden="true" /><p className="text-sm font-semibold">Sınav kâğıdının üst tablosu</p><p className="mt-1 text-xs text-slate-400">Kenarların tamamı çerçevede görünmeli</p></div></div></div><div className="grid gap-3 sm:grid-cols-2"><Button size="lg" className="h-12 bg-cyan-300 font-bold text-slate-950 hover:bg-cyan-200" onClick={onCamera}><Camera className="size-5" />Kamerayı aç</Button><Button size="lg" variant="outline" className="h-12 border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={onFile}><Upload className="size-5" />Fotoğraf seç</Button></div><button type="button" className="mx-auto mt-4 flex items-center gap-2 text-sm text-slate-300 underline-offset-4 hover:text-white hover:underline" onClick={onManual}><PencilLine className="size-4" />Kâğıt olmadan elle giriş yap</button></div></CardContent></Card>;
}

function ReviewCard({ draft, setDraft, previewUrl, processing, progress, progressLabel, calculatedTotal, totalMismatch, onSave, onCancel }: { draft: ScanDraft; setDraft: React.Dispatch<React.SetStateAction<ScanDraft>>; previewUrl: string | null; processing: boolean; progress: number; progressLabel: string; calculatedTotal: number; totalMismatch: boolean; onSave: () => void; onCancel: () => void }) {
  const setScore = (index: number, value: string) => setDraft((current) => { const scores = [...current.scores] as ScanDraft["scores"]; scores[index] = value; return { ...current, scores }; });
  const confidence = (key: string) => draft.confidence[key];
  return <Card className="overflow-hidden border-slate-200 shadow-sm"><CardHeader className="border-b border-slate-100 bg-slate-50/70"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.15em] text-primary">Kontrol</p><CardTitle className="mt-1 text-xl">Okunan bilgileri doğrulayın</CardTitle></div><Button size="sm" variant="ghost" onClick={onCancel}><RotateCcw className="size-4" />Baştan al</Button></div></CardHeader><CardContent className="pt-5">{previewUrl ? <div className="mb-5 overflow-hidden rounded-xl border bg-slate-100"><img src={previewUrl} alt="Taranan sınav kâğıdı" className="max-h-52 w-full object-cover object-top" /></div> : null}{processing ? <div className="rounded-2xl border border-cyan-100 bg-cyan-50 p-5"><div className="mb-3 flex items-center gap-3"><LoaderCircle className="size-5 animate-spin text-cyan-700" /><div><p className="font-semibold text-cyan-950">El yazısı okunuyor</p><p className="text-sm text-cyan-800">{progressLabel}</p></div></div><Progress value={progress} className="bg-cyan-100 [&_[data-slot=progress-indicator]]:bg-cyan-600" /><p className="mt-2 text-right text-xs font-semibold text-cyan-800">%{progress}</p></div> : <><div className="grid gap-4 sm:grid-cols-2"><ReviewField label="Ad soyad" id="full-name" confidence={confidence("fullName")}><Input id="full-name" value={draft.fullName} onChange={(event) => setDraft((current) => ({ ...current, fullName: event.target.value }))} /></ReviewField><ReviewField label="Öğrenci numarası" id="student-number" confidence={confidence("studentNumber")}><Input id="student-number" inputMode="numeric" value={draft.studentNumber} onChange={(event) => setDraft((current) => ({ ...current, studentNumber: event.target.value.replace(/\D/g, "") }))} /></ReviewField></div><div className="mt-5"><Label>Soru puanları</Label><div className="mt-2 grid grid-cols-5 gap-2">{draft.scores.map((score, index) => <ReviewField key={index} label={`S${index + 1}`} id={`score-${index}`} confidence={confidence(`s${index + 1}`)} compact><Input id={`score-${index}`} inputMode="decimal" className="px-2 text-center font-bold" value={score} onChange={(event) => setScore(index, event.target.value.replace(/[^0-9,.-]/g, ""))} /></ReviewField>)}</div></div><div className={`mt-5 grid gap-3 rounded-2xl border p-4 sm:grid-cols-[1fr_auto] ${totalMismatch ? "border-amber-300 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}><ReviewField label="Kâğıtta yazan toplam" id="written-total" confidence={confidence("writtenTotal")}><Input id="written-total" inputMode="decimal" className="bg-white text-lg font-bold" value={draft.writtenTotal} onChange={(event) => setDraft((current) => ({ ...current, writtenTotal: event.target.value.replace(/[^0-9,.-]/g, "") }))} /></ReviewField><div className="flex min-w-36 items-center gap-3 rounded-xl bg-white px-4 py-2"><div>{totalMismatch ? <AlertTriangle className="size-5 text-amber-600" /> : <CheckCircle2 className="size-5 text-emerald-600" />}</div><div><p className="text-xs text-muted-foreground">Hesaplanan</p><p className="text-xl font-bold tabular-nums">{calculatedTotal}</p></div></div>{totalMismatch ? <p className="text-sm font-medium text-amber-800 sm:col-span-2">Yazılan toplam ile soru puanlarının toplamı uyuşmuyor.</p> : null}</div><div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><Button variant="outline" onClick={onCancel}>İptal</Button><Button className="bg-emerald-600 hover:bg-emerald-700" onClick={onSave}><CheckCircle2 className="size-4" />Onayla ve sonraki kâğıt</Button></div></>}</CardContent></Card>;
}

function ResultsTable({ exam, onRemove }: { exam: ExamState; onRemove: (id: string) => void }) {
  if (!exam.results.length) return null;
  const averages = Array.from({ length: 6 }, (_, column) => {
    const values = exam.results.map((result) => column < 5 ? result.scores[column] : result.writtenTotal);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  });
  return <Card className="overflow-hidden border-slate-200 shadow-sm lg:col-span-2"><CardHeader className="flex-row items-center justify-between border-b bg-white"><div><p className="text-xs font-bold uppercase tracking-[0.15em] text-primary">Kayıtlar</p><CardTitle className="mt-1 text-xl">Öğrenci sonuçları</CardTitle></div><Badge variant="outline">{exam.results.length} kayıt</Badge></CardHeader><CardContent className="p-0"><Table><TableHeader><TableRow className="bg-slate-50"><TableHead>Öğrenci No</TableHead><TableHead>Ad Soyad</TableHead>{exam.pcMap.map((pc, index) => <TableHead key={index} className="text-center">S{index + 1}<span className="block text-[11px] text-muted-foreground">{pc}</span></TableHead>)}<TableHead className="text-center">Toplam</TableHead><TableHead className="w-12"><span className="sr-only">İşlem</span></TableHead></TableRow></TableHeader><TableBody>{exam.results.map((result) => <TableRow key={result.id}><TableCell className="font-mono text-xs">{result.studentNumber}</TableCell><TableCell className="font-medium">{result.fullName}{result.needsReview ? <Badge variant="outline" className="ml-2 border-amber-200 bg-amber-50 text-amber-700">kontrol</Badge> : null}</TableCell>{result.scores.map((score, index) => <TableCell key={index} className="text-center tabular-nums">{score}</TableCell>)}<TableCell className="text-center font-bold tabular-nums">{result.writtenTotal}</TableCell><TableCell><Button size="icon-sm" variant="ghost" aria-label={`${result.fullName} kaydını sil`} onClick={() => onRemove(result.id)}><Trash2 className="size-4 text-slate-400" /></Button></TableCell></TableRow>)}</TableBody><TableFooter><TableRow><TableCell /><TableCell>ORTALAMA</TableCell>{averages.map((value, index) => <TableCell key={index} className="text-center font-bold tabular-nums">{value.toFixed(2).replace(".", ",")}</TableCell>)}<TableCell /></TableRow></TableFooter></Table></CardContent></Card>;
}

function ReviewField({ label, id, confidence, compact, children }: { label: string; id: string; confidence?: number; compact?: boolean; children: React.ReactNode }) {
  const low = confidence !== undefined && confidence < 60;
  return <div className="space-y-1.5"><div className="flex min-h-5 items-center justify-between gap-1"><Label htmlFor={id} className={compact ? "text-xs" : undefined}>{label}</Label>{confidence !== undefined ? <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${low ? "text-amber-700" : "text-emerald-700"}`}>{low ? <AlertTriangle className="size-3" /> : <CheckCircle2 className="size-3" />}%{Math.round(confidence)}</span> : null}</div>{children}</div>;
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) { return <div className="space-y-2"><Label htmlFor={id}>{label}</Label>{children}</div>; }
function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-1 text-xl font-bold tracking-tight text-slate-900">{value}</p></div>; }
