import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import os from "node:os";
import { prepareServerPaper } from "../../lib/paper-preparation.ts";
import { readLocalPaper } from "../../lib/local-reader.ts";
import { compareFields, summarize } from "./core.mjs";
import { projectRoot, readerUrl } from "../runtime.mjs";

const args = process.argv.slice(2), flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const output = resolve(flag("--output", join(projectRoot, "work/benchmark", `glm-production-${Date.now()}.json`)));
if (existsSync(output)) throw new Error("Result already exists; choose a new output.");
process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
const usePrepared = args.includes("--prepared");
const sourceDirectory = flag("--source-dir", undefined);
const manifest = JSON.parse(await readFile(join(projectRoot, "work/benchmark", usePrepared ? "prepared-cases.json" : "cases.json"), "utf8"));
const report = { model: process.env.SCANEXAM_MODEL, started: new Date().toISOString(),
  hardware: { cpu: os.cpus()[0].model, cores: os.cpus().length, ramBytes: os.totalmem() },
  notes: [usePrepared ? "Previously prepared upper-form JPEG copies (original desktop files unavailable); application's automatic geometry/native adapter." : "Original photographs; application's automatic geometry/native adapter.", "Includes decode/crop/model, not phone capture/upload.",
    "Same four previously used papers, not held-out accuracy. Answers are only used by the scorer after inference. GPU is not disabled."], records: [] };
for (const item of manifest.cases) {
  const started = performance.now();
  let prediction = {}, error;
  try {
    const path = usePrepared ? item.prepared : sourceDirectory ? join(sourceDirectory, basename(item.source)) : item.source;
    const paper = await prepareServerPaper(await readFile(path), item.expected.scores.length);
    prediction = await readLocalPaper(paper.image, "single", new AbortController().signal, paper.regions, paper.compactImage, item.expected.scores.length, paper);
  } catch (cause) { error = cause.message; }
  const ps = await (await fetch(`${readerUrl}/api/ps`)).json();
  const record = { caseId: item.id, elapsedMs: performance.now() - started, prediction, error,
    vramBytes: ps.models?.find(model => model.name === process.env.SCANEXAM_MODEL)?.size_vram,
    fields: compareFields(item.expected, prediction, item.excludedFields) };
  report.records.push(record); report.summary = summarize(report.records);
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(`${item.id}: ${(record.elapsedMs / 1000).toFixed(2)}s; ${record.fields.filter(field => field.correct).length}/${record.fields.length} fields${error ? `; ${error}` : ""}`);
}
console.log(output);
