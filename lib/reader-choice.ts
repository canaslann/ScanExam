export type ReaderChoice = "glm" | "qwen";
export const QWEN_MODEL = "qwen3.5:9b-q8_0";
export const READER_CHOICES = [
  { value: "glm", label: "GLM-OCR" },
  { value: "qwen", label: "Qwen3.5-9B" },
] as const;

/** Older captures retain their original OCR path. Never accept arbitrary models. */
export function readerChoice(value: unknown): ReaderChoice {
  if (value === undefined || value === "glm") return "glm";
  if (value === "qwen") return "qwen";
  throw new Error("Okuma modeli geçersiz; GLM-OCR veya Qwen seçin.");
}
