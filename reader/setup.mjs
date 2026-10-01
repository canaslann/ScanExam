import { installRuntime, startReader, pullModel } from "./runtime.mjs";

try {
  await installRuntime();
  await startReader();
  await pullModel();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
