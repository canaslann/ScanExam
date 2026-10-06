import type { ScanRow } from "./scan-session.ts";

/** Only one local request in flight, selecting the oldest queued row, not a copy of its cells. */
export class QueueGate {
  private current: string | null = null;
  claim(rows: ScanRow[], blocked: boolean) {
    if (blocked || this.current) return undefined;
    const next = rows.find((row) => row.status === "queued");
    if (next) this.current = next.id;
    return next;
  }
  release(id: string) {
    if (this.current === id) this.current = null;
  }
}
export function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("İptal", "AbortError"));
      return;
    }
    const cancel = () => {
      clearTimeout(timer);
      reject(new DOMException("İptal", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
export async function readWithBusyRetry<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
  onBusy: () => void,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = abortableDelay,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new DOMException("İptal", "AbortError");
    try {
      return await read();
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("status" in error) ||
        error.status !== 409 ||
        attempt >= 5 ||
        signal.aborted
      )
        throw error;
      onBusy();
      await wait(Math.min(30_000, 2000 * 2 ** attempt), signal);
    }
  }
}
