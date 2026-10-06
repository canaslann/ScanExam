import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { root, work, startOllama, ollamaUrl } from "./runtime.mjs";
import { prepareAutoRegions } from "./auto-regions.mjs";
import { compareFields, summarize } from "./core.mjs";
import { readLocalPaper, validateReaderInput } from "../../lib/local-reader.ts";

const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const device = arg("--device", "auto"), strategy = arg("--strategy", "adaptive"), checkMode = arg("--check-mode", "single");
if (!["auto", "cpu"].includes(device) || !["auto", "top", "compact", "adaptive"].includes(strategy) || !["single", "double"].includes(checkMode)) throw new Error("Invalid profile");
const output = resolve(arg("--output", join(work, `production-${strategy}-${device}-${Date.now()}.json`)));
if (existsSync(output)) throw new Error("Output already exists; choose a new path");
process.env.SCANEXAM_READER_URL = ollamaUrl;
process.env.SCANEXAM_MODEL = "qwen3.5:4b";
process.env.SCANEXAM_READER_THREADS = "4";
if (strategy === "adaptive") delete process.env.SCANEXAM_REGION_READING;
else process.env.SCANEXAM_REGION_READING = strategy === "auto" ? "on" : "off";
delete process.env.SCANEXAM_FAST_READING;
const manifest = JSON.parse(await readFile(join(work, "prepared-cases.json"), "utf8"));
const caseId = arg("--case-id", undefined);
if (caseId) {
  manifest.cases = manifest.cases.filter((item) => item.id === caseId);
  if (!manifest.cases.length) throw new Error("Unknown case id");
}
const limit = Number(arg("--limit", String(manifest.cases.length)));
if (!Number.isInteger(limit) || limit < 1 || limit > manifest.cases.length) throw new Error("Invalid case limit");
manifest.cases = manifest.cases.slice(0, limit);
const report = { startedAt: new Date().toISOString(), device, threads: 4, checkMode, runtime: "Ollama 0.35.0 / application local-reader",
  hardware: { cpu: os.cpus()[0].model, logicalCores: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryAtStartBytes: os.freemem() },
  dataset: { description: manifest.description, annotationStatus: manifest.annotationStatus,
    preprocessing: { maxWidth: 1600, automaticLayout: strategy !== "top" }, cases: manifest.cases.map(({ id, dimensions }) => ({ id, dimensions })) },
  notes: ["production-* profiles use the application's validation, normalization, region prompts, fallback and double-check logic. CLI detection/crop uses sharp on the prepared JPEG, whereas the browser uses canvas on decoded pixels; times include CLI layout/crop and service requests, not browser upload/UI or original image decoding.",
    "Automatic layout uses only pixels/grid geometry, never manual case boxes or ground-truth answers. Shared 120/240 second service deadlines remain unchanged. Four papers and a four-thread CPU test are not low-hardware certification."],
  models: [], records: [], failures: [] };
let service, monitor;
const memory = { peakResidentBytes: 0, peakPrivateBytes: 0, samples: 0 };
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n");
try {
  const started = performance.now();
  service = await startOllama(device);
  const tags = await (await fetch(`${ollamaUrl}/api/tags`)).json();
  const installed = tags.models.find((item) => item.name === "qwen3.5:4b");
  if (!installed) throw new Error("4B reference not installed");
  const modelInfo = { model: installed.name, diskBytes: installed.size, digest: installed.digest, details: installed.details,
    setupMs: performance.now() - started, inputProfile: `production-${strategy}-${checkMode}`, memory };
  report.models.push(modelInfo);
  monitor = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", join(root, "reader", "benchmark", "memory.ps1"),
    "-RootProcessId", String(service.child.pid)], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let pending = "";
  monitor.stdout.on("data", (data) => {
    pending += data.toString(); const lines = pending.split(/\r?\n/); pending = lines.pop() || "";
    for (const line of lines) try { const sample = JSON.parse(line); memory.samples++;
      memory.peakResidentBytes = Math.max(memory.peakResidentBytes, sample.residentBytes);
      memory.peakPrivateBytes = Math.max(memory.peakPrivateBytes, sample.privateBytes);
    } catch { /* Ignore non-JSON diagnostics. */ }
  });
  for (const [index, item] of manifest.cases.entries()) {
    const started = performance.now();
    let prediction = {}, error, layout;
    try {
      const buffer = await readFile(item.prepared);
      const prepared = strategy !== "top" ? await prepareAutoRegions(buffer) : {};
      layout = prepared.layout;
      const input = validateReaderInput({ image: strategy === "compact" && prepared.compact ? prepared.compact : "data:image/jpeg;base64," + buffer.toString("base64"), checkMode,
        regions: ["auto", "adaptive"].includes(strategy) ? prepared.regions : undefined, compactImage: strategy === "adaptive" ? prepared.compact : undefined });
      prediction = await readLocalPaper(input.image, input.checkMode, new AbortController().signal, input.regions, input.compactImage);
    } catch (failure) { error = failure.message; }
    const elapsedMs = performance.now() - started;
    const ps = await (await fetch(`${ollamaUrl}/api/ps`)).json();
    const row = { model: installed.name, device, caseId: item.id, cold: index === 0, inputProfile: modelInfo.inputProfile,
      elapsedMs, readyElapsedMs: elapsedMs + (index === 0 ? modelInfo.setupMs : 0), prediction, error, layout,
      vramBytes: ps.models?.[0]?.size_vram, fields: compareFields(item.expected, prediction, item.excludedFields) };
    report.records.push(row); modelInfo.summary = summarize(report.records); await save();
    console.log(`${item.id}: ${(elapsedMs / 1000).toFixed(1)}s; ${prediction.readingStrategy || "failed"}; critical ${row.fields.filter((f) => f.category !== "printed" && f.correct).length}/8${error ? `; ${error}` : ""}`);
  }
} finally {
  monitor?.kill(); if (service) await service.stop(); report.finishedAt = new Date().toISOString(); await save();
}
console.log(output);
