import { startOllama, pull, downloadPaddle } from "./runtime.mjs";

const models = process.argv.slice(2);
const selected = (models.length ? models : ["glm-ocr:q8_0", "qwen2.5vl:3b", "qwen3.5:2b"]).filter((model) => model !== "paddle");
if (selected.length) {
  const service = await startOllama();
  try { for (const model of selected) await pull(model); }
  finally { await service.stop(); }
}
if (!models.length || models.includes("paddle")) await downloadPaddle();
