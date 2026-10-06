import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  cellKeys, cellValue, confirmRow, editCell, emptyRow, MAX_PENDING, mergeReading,
  newSession, restoreSession, rowSignature, type CellKey, type ScanRow, type ScanSession,
} from "./scan-session.ts";
import { validPcCode, validQuestionCount, type ScanOutput } from "./exam.ts";

export type SharedSnapshot = { revision: number; examId: string; paused: boolean; session: ScanSession };
export class SharedError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export class SharedSessionStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, token TEXT NOT NULL, touched INTEGER NOT NULL);`);
    this.db.prepare("INSERT OR IGNORE INTO state VALUES(1, ?)").run(JSON.stringify({ revision: 0, examId: randomUUID(), paused: false, session: newSession() }));
    this.snapshot(); // Fail closed on corrupt existing data; never replace it with a new exam.
  }
  close() { this.db.close(); }
  snapshot(): SharedSnapshot {
    const stored = this.db.prepare("SELECT payload FROM state WHERE id=1").get() as { payload: string };
    const value = JSON.parse(stored.payload) as SharedSnapshot;
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !uuid(value.examId) || typeof value.paused !== "boolean")
      throw new Error("Ortak tablo kaydı geçersiz; eski veriler korunuyor.");
    value.session = restoreSession(value.session, false);
    return value;
  }
  private save(value: SharedSnapshot) {
    value.revision++;
    this.db.prepare("UPDATE state SET payload=? WHERE id=1").run(JSON.stringify(value));
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  photo(id: string): Uint8Array | undefined {
    if (!uuid(id)) throw new SharedError("Geçersiz fotoğraf kimliği.");
    return (this.db.prepare("SELECT bytes FROM photos WHERE id=?").get(id) as { bytes: Uint8Array } | undefined)?.bytes;
  }
  mutate(input: unknown, photo?: Uint8Array): SharedSnapshot {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new SharedError("Geçersiz tablo işlemi.");
    const command = input as Record<string, unknown>;
    if (!uuid(command.opId) || !uuid(command.examId)) throw new SharedError("İşlem/sınav kimliği geçersiz.");
    return this.transaction(() => {
      const state = this.snapshot();
      if (this.db.prepare("SELECT id FROM receipts WHERE id=?").get(command.opId as string)) return state;
      if (command.examId !== state.examId) throw new SharedError("Aktif sınav değişti; eski işlem uygulanmadı. Tabloyu yenileyin.", 409);
      const session = state.session;
      const row = session.rows.find(value => value.id === command.id);
      switch (command.action) {
        case "capture": {
          if (!uuid(command.id) || !["single", "double"].includes(String(command.mode))) throw new SharedError("Tarama bilgisi geçersiz.");
          if (!photo || !photo.length || photo.length > 25 * 1024 * 1024) throw new SharedError("Görüntü boyutu geçersiz.", 413);
          if (row && row.status !== "error") {
            // Durable capture IDs make ambiguous network retries harmless.
            return state;
          }
          if (session.rows.filter(r => r.status === "queued" || r.status === "reading").length >= MAX_PENDING) throw new SharedError("Bilgisayar kuyruğu dolu; görüntü telefonda korunuyor.", 429);
          if (session.rows.length >= 2000 && !row) throw new SharedError("2000 satır sınırı doldu; Excel'i alın ve yeni sınava geçin.", 413);
          const total = this.db.prepare("SELECT COALESCE(SUM(length(bytes)),0) AS size FROM photos WHERE id<>?").get(command.id) as { size: number };
          if (total.size + photo.length > 120 * 1024 * 1024) throw new SharedError("Bilgisayardaki 120 MB fotoğraf sınırı doldu. Excel'i alın; gereksiz satırları kontrol ederek kaldırın.", 413);
          this.db.prepare("INSERT OR REPLACE INTO photos VALUES(?,?)").run(command.id, photo);
          if (row) { row.status = "queued"; row.error = undefined; row.hasPhoto = true; row.checkMode = command.mode as "single" | "double"; }
          else session.rows.push(emptyRow(session.pcMap.length, command.id, command.mode as "single" | "double"));
          break;
        }
        case "manual":
          if (!uuid(command.id) || row || session.rows.length >= 2000) throw new SharedError("Yeni satır eklenemedi.");
          session.rows.push(emptyRow(session.pcMap.length, command.id, "single", false)); break;
        case "edit": {
          if (!row || !cellKeys(session.pcMap.length).includes(command.field as CellKey) || typeof command.value !== "string" || command.value.length > 120)
            throw new SharedError("Hücre işlemi geçersiz.");
          const field = command.field as CellKey;
          if (cellValue(row, field) !== command.previous) throw new SharedError("Bu hücre diğer cihazda değişti. Yeni değer korunuyor; kontrol edip tekrar düzenleyin.", 409);
          session.rows = session.rows.map(r => r.id === row.id ? editCell(r, field, command.value as string) : r); break;
        }
        case "approve":
          if (!row || command.signature !== rowSignature(row, session)) throw new SharedError("Kontrol sırasında satır veya sınav ayarı değişti; yeniden karşılaştırın.", 409);
          session.rows = session.rows.map(r => r.id === row.id ? confirmRow(session, row) : r); break;
        case "remove":
          if (!row || row.status === "reading" || command.signature !== rowSignature(row, session)) throw new SharedError("Satır değişti veya okunuyor; silinmedi.", 409);
          session.rows = session.rows.filter(r => r.id !== row.id);
          this.db.prepare("DELETE FROM photos WHERE id=?").run(row.id); break;
        case "retry":
          if (!row || row.status !== "error" || !row.hasPhoto) throw new SharedError("Bu satır yeniden okumaya uygun değil.", 409);
          row.status = "queued"; row.error = undefined; break;
        case "manual-complete":
          if (!row || row.status !== "error" || !cellKeys(session.pcMap.length).every(key => row.edited.includes(key)))
            throw new SharedError("Önce tüm kimlik, puan ve toplam alanlarını elle doldurun.");
          row.status = "done"; row.error = undefined; break;
        case "cancel":
          if (!row || row.status !== "reading") throw new SharedError("Bu satırda aktif okuma yok.", 409);
          row.status = "error"; row.error = "Okuma iptal edildi; kaynak görüntü bilgisayarda korunuyor.";
          this.db.prepare("DELETE FROM leases WHERE id=?").run(row.id); break;
        case "pause":
          if (typeof command.paused !== "boolean") throw new SharedError("Kuyruk ayarı geçersiz.");
          state.paused = command.paused; break;
        case "meta": {
          const key = command.key as "courseCode" | "courseName" | "pcMap";
          if (!["courseCode", "courseName", "pcMap"].includes(key)) throw new SharedError("Sınav ayarı geçersiz.");
          if (JSON.stringify(session[key]) !== JSON.stringify(command.previous)) throw new SharedError("Bu sınav ayarı diğer cihazda değişti; tekrar kontrol edin.", 409);
          if (key === "pcMap") {
            if (!Array.isArray(command.value) || !validQuestionCount(command.value.length) || !command.value.every(validPcCode)
              || (session.rows.length && command.value.length !== session.pcMap.length)) throw new SharedError("Soru sayısı/PÇ eşleşmesi geçersiz.");
            session.pcMap = command.value;
          } else {
            if (typeof command.value !== "string" || command.value.length > 120) throw new SharedError("Ders bilgisi geçersiz.");
            session[key] = command.value;
          }
          break;
        }
        case "reset":
          if (command.revision !== state.revision || session.rows.some(r => r.status === "queued" || r.status === "reading"))
            throw new SharedError("Tablo değişti veya bekleyen okuma var; yeni sınav açılmadı.", 409);
          state.session = newSession(); state.examId = randomUUID(); state.paused = false;
          this.db.exec("DELETE FROM photos; DELETE FROM leases;"); break;
        default: throw new SharedError("Bilinmeyen tablo işlemi.");
      }
      this.save(state);
      this.db.prepare("INSERT INTO receipts VALUES(?,?)").run(command.opId as string, Date.now());
      this.db.prepare("DELETE FROM receipts WHERE created<?").run(Date.now() - 7 * 24 * 60 * 60 * 1000);
      return state;
    });
  }
  claim(now = Date.now()): { row: ScanRow; token: string; photo?: Uint8Array } | undefined {
    return this.transaction(() => {
      const state = this.snapshot();
      let recovered = false;
      for (const row of state.session.rows.filter(r => r.status === "reading")) {
        const lease = this.db.prepare("SELECT touched FROM leases WHERE id=?").get(row.id) as { touched: number } | undefined;
        if (!lease || lease.touched < now - 15_000) {
          row.status = "queued"; row.error = undefined; recovered = true;
          this.db.prepare("DELETE FROM leases WHERE id=?").run(row.id);
        }
      }
      if (recovered) this.save(state);
      if (state.paused || state.session.rows.some(r => r.status === "reading")) return;
      const row = state.session.rows.find(r => r.status === "queued");
      if (!row) return;
      row.status = "reading"; row.error = undefined;
      const token = randomUUID();
      this.db.prepare("INSERT OR REPLACE INTO leases VALUES(?,?,?)").run(row.id, token, now);
      this.save(state);
      return { row, token, photo: this.photo(row.id) };
    });
  }
  heartbeat(id: string, token: string, now = Date.now()) {
    return this.db.prepare("UPDATE leases SET touched=? WHERE id=? AND token=?").run(now, id, token).changes === 1;
  }
  finish(id: string, token: string, output?: ScanOutput, error?: string) {
    this.transaction(() => {
      if (!this.db.prepare("SELECT id FROM leases WHERE id=? AND token=?").get(id, token)) return;
      const state = this.snapshot(), row = state.session.rows.find(r => r.id === id);
      if (!row || row.status !== "reading") return;
      state.session.rows = state.session.rows.map(r => r.id !== id ? r : output
        ? mergeReading(r, output) : { ...r, status: "error", error: error || "Okuma başarısız." });
      this.db.prepare("DELETE FROM leases WHERE id=? AND token=?").run(id, token);
      this.save(state);
    });
  }
}
