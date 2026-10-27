import { getReaderStatus, readLocalPaper, ReaderError } from "./local-reader.ts";
import { getQwenStatus, readQwenPaper, warmQwenReader } from "./qwen-reader.ts";
import { readerChoice, type ReaderChoice } from "./reader-choice.ts";

export function validateReaderChoice(value: unknown): ReaderChoice {
  try { return readerChoice(value); }
  catch (error) { throw new ReaderError((error as Error).message, 400); }
}
export function selectedReaderStatus(choice: ReaderChoice) {
  return choice === "qwen" ? getQwenStatus() : getReaderStatus();
}

let busy = false;
/** Shared gate prevents the two selectable readers from competing for the GPU. */
export async function readSelectedPaper(choice: ReaderChoice, ...args: Parameters<typeof readLocalPaper>) {
  if (busy) throw new ReaderError("Başka bir kâğıt okunuyor. Tamamlanınca yeniden deneyin.", 409);
  busy = true;
  try {
    if (choice === "glm") return await readLocalPaper(...args);
    const [image, , signal, , , count = 5] = args;
    await warmQwenReader(signal);
    return await readQwenPaper(Buffer.from(image, "base64"), count, signal);
  } finally { busy = false; }
}
