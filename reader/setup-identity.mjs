import { installRuntime, startReader, pullModel, readerStatus } from "./runtime.mjs";
import { NAME_READER_MODEL } from "../lib/name-refinement.ts";

try {
  await installRuntime();
  await startReader();
  const status = await readerStatus();
  if (status?.models?.some(model => model.name === NAME_READER_MODEL))
    console.log(`${NAME_READER_MODEL} zaten kurulu; indirme yapılmadı.`);
  else await pullModel(NAME_READER_MODEL);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
