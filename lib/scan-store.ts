import type { ScanSession } from "./scan-session.ts";

const DB = "scanexam-live-v2";
const MAX_PHOTO_BYTES = 120 * 1024 * 1024;
let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("session");
      request.result.createObjectStore("photos");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      database = undefined;
      reject(new Error("Diğer ScanExam sekmesini kapatın."));
    };
  }));
}
function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function complete(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(tx.error || new Error("Yerel kayıt tamamlanamadı."));
  });
}
export async function loadSession(): Promise<unknown> {
  const db = await openDatabase();
  return result(db.transaction("session").objectStore("session").get("active"));
}
export async function loadPhoto(id: string): Promise<Blob | undefined> {
  const db = await openDatabase();
  return result(db.transaction("photos").objectStore("photos").get(id));
}
// Atomic capture: a green check is allowed only after both row and source photo commit.
export async function saveSession(
  session: ScanSession,
  photo?: { id: string; blob: Blob },
  remove?: string[],
  reset = false,
) {
  const db = await openDatabase();
  const tx = db.transaction(["session", "photos"], "readwrite"),
    done = complete(tx);
  const photos = tx.objectStore("photos"),
    meta = tx.objectStore("session");
  const bytesRequest = meta.get("photoBytes");
  let limitExceeded = false;
  bytesRequest.onsuccess = () => {
    let bytes = reset ? 0 : Number(bytesRequest.result || 0);
    if (reset) photos.clear();
    for (const id of remove || []) {
      const request = photos.get(id);
      request.onsuccess = () => {
        bytes -= request.result?.size || 0;
        photos.delete(id);
        meta.put(Math.max(0, bytes), "photoBytes");
      };
    }
    if (photo) {
      const existing = photos.get(photo.id);
      existing.onsuccess = () => {
        bytes =
          Math.max(0, bytes - (existing.result?.size || 0)) + photo.blob.size;
        if (bytes > MAX_PHOTO_BYTES) {
          limitExceeded = true;
          tx.abort();
          return;
        }
        photos.put(photo.blob, photo.id);
        meta.put(bytes, "photoBytes");
      };
    }
    meta.put(bytes, "photoBytes");
    meta.put(session, "active");
  };
  try {
    await done;
  } catch (error) {
    if (limitExceeded)
      throw new Error(
        "120 MB fotoğraf sınırı doldu. Excel’i alın; gereksiz satırları silip yerel kaydı yeniden deneyin.",
      );
    throw error;
  }
}
