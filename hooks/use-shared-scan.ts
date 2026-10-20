"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { cellKeys, cellValue, editCell, newSession, type CellKey, type ScanRow, type ScanSession } from "@/lib/scan-session";
import type { SharedSnapshot } from "@/lib/shared-session";
import { getSharedSnapshot, sharedCommand, uploadCapture } from "@/lib/shared-client";
import { pendingCaptures, removeCapture, saveCapture, type CaptureUpload } from "@/lib/capture-outbox";
import type { CheckMode } from "@/lib/reader-contract";

export function useSharedScan() {
  const [session, setSession] = useState<ScanSession>(newSession), sessionRef = useRef(session);
  const [lastTransferMs, setLastTransferMs] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [connectionError, setConnectionError] = useState(""), [uploadError, setUploadError] = useState(""), [commandError, setCommandError] = useState("");
  const [paused, setPaused] = useState(false), [uploads, setUploads] = useState(0), [writing, setWriting] = useState(0);
  const base = useRef<SharedSnapshot | null>(null), alive = useRef(true), writes = useRef<Promise<void>>(Promise.resolve());
  const overlays = useRef(new Map<string, Record<string, unknown>>());
  const [uploadTick, setUploadTick] = useState(0);
  const uploading = useRef(false);
  const apply = useCallback((incoming?: SharedSnapshot) => {
    if (incoming && (!base.current || incoming.revision >= base.current.revision)) base.current = incoming;
    if (!base.current || !alive.current) return;
    let view = { ...base.current.session, pcMap: [...base.current.session.pcMap], rows: [...base.current.session.rows] };
    for (const command of overlays.current.values()) {
      if (command.action === "edit") view = { ...view, rows: view.rows.map(row => row.id === command.id
        ? editCell(row, command.field as CellKey, command.value as string) : row) };
      else if (command.action === "meta") view = { ...view, [command.key as string]: command.value };
    }
    sessionRef.current = view; setSession(view); setPaused(base.current.paused); setReady(true);
  }, []);
  const command = useCallback((operation: Record<string, unknown>, optimistic = false): Promise<void> => {
    if (!base.current) return Promise.reject(new Error("Bilgisayardaki ortak tablo hazır değil."));
    const opId = crypto.randomUUID();
    const input = { ...operation, opId, examId: base.current.examId };
    setCommandError("");
    if (optimistic) { overlays.current.set(opId, input); apply(); }
    setWriting(value => value + 1);
    const task = writes.current.then(async () => {
      const snapshot = await sharedCommand(input);
      overlays.current.delete(opId); apply(snapshot);
    }).catch(cause => {
      overlays.current.delete(opId); apply();
      if (alive.current) setCommandError(cause instanceof Error ? cause.message : "Değişiklik bilgisayara gönderilemedi.");
      throw cause;
    }).finally(() => { if (alive.current) setWriting(value => value - 1); });
    writes.current = task.catch(() => undefined);
    return task;
  }, [apply]);
  useEffect(() => {
    alive.current = true;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const snapshot = await getSharedSnapshot();
        if (!disposed) { apply(snapshot); setConnectionError(""); }
      } catch (cause) {
        if (!disposed) setConnectionError(cause instanceof Error ? cause.message : "Bilgisayara bağlanılamadı.");
      } finally { if (!disposed) timer = setTimeout(poll, 1000); }
    };
    void poll();
    return () => { disposed = true; alive.current = false; clearTimeout(timer); };
  }, [apply]);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const upload = async () => {
      if (uploading.current) { if (!disposed) timer = setTimeout(upload, 1000); return; }
      uploading.current = true;
      let nextDelay = 1000;
      try {
        const jobs = await pendingCaptures();
        if (disposed) return;
        setUploads(jobs.length);
        const job = jobs[0];
        if (!job) setUploadError("");
        if (job && base.current) {
          if (job.examId !== base.current.examId) {
            setUploadError("Önceki sınavdan aktarılmamış görüntüler bu cihazda korunuyor; yeni sınava aktarılmadı. Eski sınavı/aktarımı kontrol edin.");
          } else {
            const snapshot = await uploadCapture(job);
            // Remove only after the computer's database confirms an atomic commit.
            await removeCapture(job.opId);
            const remaining = await pendingCaptures();
            if (!disposed) { apply(snapshot); setUploads(remaining.length); setLastTransferMs(Date.now() - job.created); setUploadError(""); }
            // Drain completed uploads immediately, without delaying the next paper.
            nextDelay = remaining.length ? 0 : 1000;
          }
        }
      } catch (cause) {
        if (!disposed) setUploadError(`${cause instanceof Error ? cause.message : "Görüntü aktarılamadı."} Bekleyen görüntü bu cihazda korunuyor; yeniden denenecek.`);
      } finally { uploading.current = false; if (!disposed) timer = setTimeout(upload, nextDelay); }
    };
    void upload();
    return () => { disposed = true; clearTimeout(timer); };
  }, [apply, uploadTick]);
  const capture = async (blob: Blob, mode: CheckMode, replacementId?: string, source: "camera" | "gallery" = "camera") => {
    if (!base.current || !ready) throw new Error("Bilgisayardaki ortak tablo hazır değil.");
    if (!blob.size || blob.size > 25 * 1024 * 1024) throw new Error("Görüntü boş veya 25 MB sınırını aşıyor.");
    const job: CaptureUpload = { id: replacementId || crypto.randomUUID(), opId: crypto.randomUUID(), examId: base.current.examId, mode, source, blob, created: Date.now() };
    await saveCapture(job);
    if (alive.current) { setUploads(value => value + 1); setUploadTick(value => value + 1); }
  };
  const updateRow = (id: string, update: (row: ScanRow) => ScanRow) => {
    const row = sessionRef.current.rows.find(value => value.id === id);
    if (!row) return Promise.reject(new Error("Satır bulunamadı."));
    const next = update(row);
    if (next.status === "queued" && row.status === "error") return command({ action: "retry", id });
    if (next.status === "done" && row.status === "error") return command({ action: "manual-complete", id });
    const field = cellKeys(sessionRef.current.pcMap.length).find(key => cellValue(row, key) !== cellValue(next, key));
    return field ? command({ action: "edit", id, field, value: cellValue(next, field), previous: cellValue(row, field) }, true) : Promise.resolve();
  };
  const updateMeta = (patch: Partial<ScanSession>) => {
    for (const [key, value] of Object.entries(patch))
      void command({ action: "meta", key, value, previous: sessionRef.current[key as keyof ScanSession] }, true).catch(() => undefined);
  };
  return { session, sessionRef, ready, connected: ready && !connectionError,
    error: [connectionError, uploadError, commandError].filter(Boolean).join(" "), paused, uploads, writing, lastTransferMs, command, capture, updateRow, updateMeta,
    snapshot: () => base.current };
}
