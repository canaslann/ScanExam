import { installRuntime, startReader, pullModel, readerStatus } from "./runtime.mjs";
import { QWEN_MODEL } from "../lib/reader-choice.ts";

try {
  await installRuntime();
  await startReader();
  const status = await readerStatus();
  if (status?.models?.some(model => model.name === QWEN_MODEL))
    console.log(`${QWEN_MODEL} zaten kurulu; indirme yapılmadı.`);
  else await pullModel(QWEN_MODEL);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
