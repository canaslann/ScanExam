import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { modelStore, downloadFile, sha256 } from "./runtime.mjs";
import { spawn } from "node:child_process";

async function registryManifest(url) {
  return new Promise((done, fail) => {
    const child = spawn("curl.exe", ["--location", "--fail", "--silent", "--show-error", "--retry", "2",
      "--connect-timeout", "15", "--max-time", "45", url], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", (part) => { output += part; });
    child.stderr.on("data", (part) => { error += part; });
    child.once("error", fail);
    child.once("exit", (code) => code === 0 ? done(output) : fail(new Error(`Registry manifest curl ${code}: ${error.slice(0, 300)}`)));
  });
}

// Same registry, manifests, SHA-256 hashes and cache layout as native `ollama pull`.
// A single resumable curl transfer avoids the failing parallel transfer connections.
for (const model of process.argv.slice(2)) {
  const match = model.match(/^([a-z0-9.-]+):([a-z0-9_.-]+)$/);
  if (!match) throw new Error("Use an official library model:tag");
  const [, name, tag] = match;
  const manifestText = await registryManifest(`https://registry.ollama.ai/v2/library/${name}/manifests/${tag}`);
  const manifest = JSON.parse(manifestText);
  for (const blob of [manifest.config, ...manifest.layers]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(blob.digest)) throw new Error("Invalid registry hash");
    const expected = blob.digest.slice(7);
    const path = join(modelStore, "blobs", `sha256-${expected}`);
    if (existsSync(path) && (await stat(path)).size === blob.size && await sha256(path) === expected) continue;
    await mkdir(dirname(path), { recursive: true });
    console.log(`${model}: ${blob.mediaType} (${Math.round(blob.size / 1e6)} MB)`);
    await downloadFile(`https://registry.ollama.ai/v2/library/${name}/blobs/${blob.digest}`, `${path}.download`, blob.size);
    if ((await stat(`${path}.download`)).size !== blob.size || await sha256(`${path}.download`) !== expected) throw new Error(`Checksum failed: ${blob.digest}`);
    await rename(`${path}.download`, path);
  }
  const path = join(modelStore, "manifests", "registry.ollama.ai", "library", name, tag);
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path) && await readFile(path, "utf8") !== manifestText) throw new Error(`Existing model manifest differs: ${model}`);
  await writeFile(path, manifestText);
  console.log(`Verified and installed: ${model}`);
}
