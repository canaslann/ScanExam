import { installRuntime, startReader, pullModel, readerStatus } from "./runtime.mjs";
import { QWEN_MODEL } from "../lib/reader-choice.ts";
import { NAME_READER_MODEL } from "../lib/name-refinement.ts";

try {
  await installRuntime();
  await startReader();
  // Keep the existing pinned GLM installer and its metadata checks intact.
  await pullModel("glm-ocr-eot:q8_0");
  const status = await readerStatus();
  const installed = new Set(status?.models?.map(model => model.name) || []);
  for (const model of [NAME_READER_MODEL, QWEN_MODEL]) {
    if (installed.has(model)) console.log(`${model} zaten kurulu; indirme yapılmadı.`);
    else await pullModel(model);
  }
  console.log("İki okuma modeli hazır. npm run dev ile uygulamayı açın.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
