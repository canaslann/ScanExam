import type { SharedSnapshot } from "./shared-session.ts";
import { restoreSession } from "./scan-session.ts";

export class SyncError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
async function responseSnapshot(response: Response): Promise<SharedSnapshot> {
  let raw: unknown;
  try { raw = await response.json(); }
  catch { throw new SyncError("Bilgisayara ulaşılamadı; bağlantıyı kontrol edin.", response.status); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SyncError("Ortak tablo yanıtı geçersiz.", 502);
  const value = raw as Record<string, unknown>;
  if (!response.ok) throw new SyncError(typeof value.error === "string" ? value.error : "Ortak tablo işlemi başarısız.", response.status);
  if (!Number.isSafeInteger(value.revision) || typeof value.examId !== "string" || typeof value.paused !== "boolean")
    throw new SyncError("Ortak tablo yanıtı geçersiz; mevcut görüntü korunuyor.", 502);
  return { revision: value.revision as number, examId: value.examId, paused: value.paused, session: restoreSession(value.session, false) };
}
export async function getSharedSnapshot(): Promise<SharedSnapshot> {
  return responseSnapshot(await fetch("/api/shared", { cache: "no-store", signal: AbortSignal.timeout(5000) }));
}
export async function sharedCommand(command: Record<string, unknown>): Promise<SharedSnapshot> {
  const body = JSON.stringify(command);
  for (let attempt = 0; ; attempt++) {
    try {
      return await responseSnapshot(await fetch(command.action === "roster" ? "/api/shared?action=roster" : "/api/shared", { method: "POST", headers: { "Content-Type": "application/json" },
        body, signal: AbortSignal.timeout(10_000) }));
    } catch (error) {
      // A lost acknowledgement is retried with the same operation ID; the server
      // receipt prevents replaying edits, approvals or a reset.
      if (attempt >= 1 || (error instanceof SyncError && error.status < 500)) throw error;
    }
  }
}
export async function uploadCapture(job: { id: string; opId: string; examId: string; mode: string; source?: "camera" | "gallery"; blob: Blob }): Promise<SharedSnapshot> {
  const params = new URLSearchParams({ action: "capture", id: job.id, opId: job.opId, examId: job.examId, mode: job.mode });
  params.set("source",job.source || "camera");
  return responseSnapshot(await fetch(`/api/shared?${params}`, { method: "POST", headers: { "Content-Type": job.blob.type || "image/jpeg" },
    body: job.blob, signal: AbortSignal.timeout(30_000) }));
}
export async function sharedPhoto(id: string): Promise<Blob> {
  const response = await fetch(`/api/shared?photo=${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new SyncError("Bilgisayardaki kaynak fotoğraf açılamadı.", response.status);
  return response.blob();
}
