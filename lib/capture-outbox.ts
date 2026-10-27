import type { CheckMode } from "./reader-contract.ts";
import type { ReaderChoice } from "./reader-choice.ts";
export type CaptureUpload = { id: string; opId: string; examId: string; mode: CheckMode; reader?: ReaderChoice; source?: "camera" | "gallery"; blob: Blob; created: number };
let database: Promise<IDBDatabase> | undefined;
function open() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("scanexam-capture-outbox-v1", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("jobs", { keyPath: "opId" }); };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error("Bekleyen aktarım kaydı başka sekmede açık.")); };
  });
}
export async function pendingCaptures(): Promise<CaptureUpload[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction("jobs").objectStore("jobs").getAll();
    request.onsuccess = () => resolve((request.result as CaptureUpload[]).sort((a, b) => a.created - b.created));
    request.onerror = () => reject(request.error);
  });
}
/** Green capture confirmation follows IndexedDB commit, never an in-memory promise. */
export async function saveCapture(job: CaptureUpload) {
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("jobs", "readwrite"), store = tx.objectStore("jobs"), request = store.getAll();
    let reason = "Görüntü telefona kaydedilemedi; tarama onaylanmadı.";
    request.onsuccess = () => {
      const jobs = request.result as CaptureUpload[];
      if (jobs.length >= 20 || jobs.reduce((sum, item) => sum + item.blob.size, 0) + job.blob.size > 120 * 1024 * 1024) {
        reason = "Telefonda aktarılmayı bekleyen görüntü sınırı doldu; bilgisayar bağlantısını kontrol edin."; tx.abort(); return;
      }
      store.put(job);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error(reason));
  });
}
export async function removeCapture(opId: string) {
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("jobs", "readwrite"); tx.objectStore("jobs").delete(opId);
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
