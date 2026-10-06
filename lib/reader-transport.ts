import { abortableDelay } from "./read-queue.ts";

export class ReaderRequestError extends Error {
  public status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Local requests stay synchronous. The protected phone gateway returns an asynchronous job. */
export async function requestReader<T>(
  body: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  wait: typeof abortableDelay = abortableDelay,
): Promise<T> {
  let jobPath: string | undefined;
  const readResponse = async (response: Response) => {
    try {
      return await response.json() as { readJob?: unknown; error?: string };
    } catch {
      throw new ReaderRequestError(`Bağlantıdan geçerli bir okuma yanıtı alınamadı (HTTP ${response.status}). Kaynak fotoğraf tablodadır; bağlantıyı kontrol edip yeniden deneyin.`, response.ok ? 502 : response.status);
    }
  };
  try {
    let response = await fetcher("/api/reader", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal,
    });
    let result = await readResponse(response);
    if (response.status === 202) {
      if (typeof result?.readJob !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.readJob))
        throw new ReaderRequestError("Okuma oturumu başlatılamadı.", 502);
      jobPath = `/api/phone-readings/${result.readJob}`;
      do {
        await wait(1000, signal);
        response = await fetcher(jobPath, { signal, cache: "no-store" });
        result = await readResponse(response);
      } while (response.status === 202);
    }
    if (!response.ok) throw new ReaderRequestError(result?.error || "Okuma tamamlanamadı.", response.status);
    return result as T;
  } finally {
    if (jobPath) {
      // A fresh short signal is necessary when the original operation was cancelled.
      void fetcher(jobPath, { method: "DELETE", signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    }
  }
}
