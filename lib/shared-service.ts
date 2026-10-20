import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SharedSessionStore } from "./shared-session.ts";
import { readLocalPaper, warmLocalReader } from "./local-reader.ts";
import { prepareServerPaper } from "./paper-preparation.ts";
import { readWithBusyRetry } from "./read-queue.ts";

let store: SharedSessionStore | undefined;
let draining = false;
export function sharedStore() {
  if (!store) {
    const directory = process.env.SCANEXAM_DATA_DIR || join(process.cwd(), "work", "shared");
    mkdirSync(directory, { recursive: true });
    store = new SharedSessionStore(join(directory, "scanexam.sqlite"));
    // Prepare weights when the app starts; no student data is sent to this load.
    void warmLocalReader().catch(() => undefined);
    // Recover a dead lease even when the phone tab has been closed. A poll is
    // also needed when a different app process exits mid-read.
    setInterval(wakeSharedReader, 5000).unref();
  }
  return store;
}
/** The server owns the FIFO reader, not a phone tab. SQLite leases coordinate app processes. */
export function wakeSharedReader() {
  if (draining) return;
  draining = true;
  void (async () => {
    try {
      const db = sharedStore();
      for (;;) {
        const snapshot = db.snapshot();
        if (snapshot.paused || db.activeReading() || !snapshot.session.rows.some(row => row.status === "queued" || row.status === "reading")) return;
        // An idle model may have been unloaded. Do not charge weight loading to
        // an individual paper's 120 second recognition deadline.
        try { await warmLocalReader(); }
        catch (error) {
          const failed = db.claim();
          if (failed) db.finish(failed.row.id, failed.token, undefined,
            `Model hazırlığı başarısız: ${error instanceof Error ? error.message : "Yerel motoru kontrol edin."}`);
          return;
        }
        const job = db.claim();
        if (!job) return;
        const controller = new AbortController();
        const heartbeat = setInterval(() => {
          try { if (!db.heartbeat(job.row.id, job.token)) controller.abort(); }
          catch { controller.abort(); }
        }, 1000);
        try {
          if (!job.photo) throw new Error("Kaynak fotoğraf bulunamadı; yeniden tarayın.");
          const paper = await prepareServerPaper(job.photo, job.row.draft.scores.length, true, job.row.captureSource === "gallery");
          const result = await readWithBusyRetry(() => readLocalPaper(paper.image, job.row.checkMode, controller.signal,
            paper.regions, paper.compactImage, job.row.draft.scores.length, paper), controller.signal, () => undefined);
          db.finish(job.row.id, job.token, result);
        } catch (error) {
          db.finish(job.row.id, job.token, undefined, error instanceof Error ? error.message : "Okuma başarısız.");
        } finally { clearInterval(heartbeat); }
      }
    } catch (error) {
      // Do not include student data, blobs or credentials in application logs.
      console.error("Ortak okuma kuyruğu açılamadı:", error instanceof Error ? error.message : "bilinmeyen hata");
    } finally { draining = false; }
  })();
}
