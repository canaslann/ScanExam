import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root, work, modelStore, engine, startOllama, sha256 } from "./runtime.mjs";

const model = "glm-ocr-eot:q8_0";
const directory = join(work, "models", "glm-eot");
const original = join(modelStore, "blobs", "sha256-24ca1840804a2aa3faeb2cadf31f628ec8bd48393cf1938c414f0e6cda81914a");
const output = join(directory, "glm-ocr-eot-q8.gguf");
const provenance = join(directory, "provenance.json");
const aliasManifest = join(modelStore, "manifests", "registry.ollama.ai", "library", "glm-ocr-eot", "q8_0");
if (existsSync(aliasManifest)) { console.log(`Already installed: ${model}`); process.exit(0); }
await mkdir(directory, { recursive: true });
if (await sha256(original) !== "24ca1840804a2aa3faeb2cadf31f628ec8bd48393cf1938c414f0e6cda81914a") throw new Error("Official source SHA-256 mismatch");
function run(executable, args, env) {
  return new Promise((done, fail) => {
    const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: "inherit" });
    child.once("error", fail);
    child.once("exit", (code) => code === 0 ? done() : fail(new Error(`Test model setup exit ${code}`)));
  });
}
if (!existsSync(output)) {
  await run(process.env.BENCHMARK_PYTHON || "python", [join(root, "reader", "benchmark", "patch-glm-eot.py"), original, output, provenance],
    { ...process.env, PYTHONPATH: join(work, "python-deps") });
} else if (!existsSync(provenance)) throw new Error("Incomplete prior test copy; not overwritten");
const metadata = JSON.parse(await readFile(provenance, "utf8"));
metadata.patchedSha256 = await sha256(output);
metadata.sourceSha256 = await sha256(original);
await writeFile(provenance, JSON.stringify(metadata, null, 2) + "\n");
const modelfile = join(directory, "Modelfile");
await writeFile(modelfile, `FROM "${output.replaceAll("\\", "/")}"\nTEMPLATE {{ .Prompt }}\nRENDERER glm-ocr\nPARSER glm-ocr\nPARAMETER temperature 0\n`);
const service = await startOllama();
try {
  await run(join(engine, "ollama.exe"), ["create", model, "-f", modelfile], {
    ...process.env, OLLAMA_HOST: "127.0.0.1:11436", OLLAMA_MODELS: modelStore, OLLAMA_NO_CLOUD: "true",
  });
} finally { await service.stop(); }
console.log(`Installed separate test alias: ${model}; original remains unchanged.`);
