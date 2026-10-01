import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, createReadStream, createWriteStream, existsSync, openSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = join(projectRoot, "work", "reader");
const version = "v0.35.0";
const archiveName = "ollama-windows-amd64.zip";
const archiveDigest = "d6f7d3dd4f5d013553a78c1e78b2521fcf41d43dd2863e4596cdc046fe6036db";
export const readerModel = process.env.SCANEXAM_MODEL || "qwen3.5:4b";
if (/cloud/i.test(readerModel)) throw new Error("Yalnızca yerel modeller kullanılabilir.");
const configuredUrl = new URL(process.env.SCANEXAM_READER_URL || "http://127.0.0.1:11435");
if (configuredUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(configuredUrl.hostname) || configuredUrl.username || configuredUrl.password) {
  throw new Error("Okuyucu adresi yerel bilgisayarı göstermeli.");
}
export const readerUrl = configuredUrl.origin;
const executable = join(runtimeRoot, version, "ollama.exe");

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`${command}: çıkış kodu ${code}`)));
  });
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function installRuntime() {
  if (existsSync(executable)) return;
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Bu otomatik kurulum Windows x64 içindir. Ollama'yı kurup 11435 portunda başlatın veya SCANEXAM_READER_URL ayarlayın.");
  }
  await mkdir(runtimeRoot, { recursive: true });
  const archive = join(runtimeRoot, archiveName);
  if (!existsSync(archive) || await digest(archive) !== archiveDigest) {
    console.log("Resmî yerel motor indiriliyor (1,46 GB, yalnızca ilk kurulumda).");
    const response = await fetch(`https://github.com/ollama/ollama/releases/download/${version}/${archiveName}`);
    if (!response.ok || !response.body) throw new Error(`Motor indirilemedi: HTTP ${response.status}`);
    let downloaded = 0;
    let nextReport = 100 * 1024 * 1024;
    const input = Readable.fromWeb(response.body);
    input.on("data", (chunk) => {
      downloaded += chunk.length;
      if (downloaded >= nextReport) {
        console.log(`Motor: ${Math.round(downloaded / 1024 / 1024)} MB indirildi`);
        nextReport += 100 * 1024 * 1024;
      }
    });
    await pipeline(input, createWriteStream(`${archive}.partial`));
    if (await digest(`${archive}.partial`) !== archiveDigest) throw new Error("Motor paketinin SHA-256 doğrulaması başarısız. Kurulum durduruldu.");
    await rename(`${archive}.partial`, archive);
  }
  console.log("Doğrulanan motor paketi proje içindeki work/reader klasörüne açılıyor.");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(join(runtimeRoot, version))} -Force`]);
  if (!existsSync(executable)) throw new Error("Motor paketi açılamadı.");
}

export async function readerStatus() {
  try {
    const response = await fetch(`${readerUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

export async function startReader() {
  if (await readerStatus()) return;
  if (!existsSync(executable)) throw new Error("Yerel motor bulunamadı. Önce npm run reader:setup çalıştırın.");
  const url = new URL(readerUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Otomatik motor yalnızca 127.0.0.1 üzerinde başlatılır.");
  await mkdir(join(runtimeRoot, "models"), { recursive: true });
  const log = openSync(join(runtimeRoot, "service.log"), "a");
  const child = spawn(executable, ["serve"], {
    cwd: runtimeRoot,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, OLLAMA_HOST: url.host, OLLAMA_MODELS: join(runtimeRoot, "models"),
      OLLAMA_NO_CLOUD: "true", OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_CONTEXT_LENGTH: "4096" },
  });
  closeSync(log);
  child.unref();
  let startError;
  child.once("error", (error) => { startError = error; });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (startError) throw startError;
    if (await readerStatus()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error("Yerel motor başlamadı. work/reader/service.log dosyasını kontrol edin.");
}

export async function pullModel() {
  console.log(`${readerModel} indiriliyor. Sınav fotoğrafları hiçbir haricî servise gönderilmez.`);
  const response = await fetch(`${readerUrl}/api/pull`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: readerModel, stream: true }),
  });
  if (!response.ok || !response.body) throw new Error(`Model indirilemedi: HTTP ${response.status}`);
  let buffer = "";
  let lastStatus = "";
  let lastPercent = -10;
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const status = JSON.parse(line);
      if (status.error) throw new Error(status.error);
      const percent = status.total ? Math.floor(100 * (status.completed || 0) / status.total) : null;
      if (status.status !== lastStatus || (percent !== null && percent >= lastPercent + 10)) {
        console.log(`${status.status}${percent === null ? "" : ` %${percent}`}`);
        if (status.status !== lastStatus) lastPercent = -10;
        lastStatus = status.status;
        if (percent !== null) lastPercent = percent;
      }
    }
  }
  console.log("Yerel okuyucu hazır. npm run dev ile uygulamayı açabilirsiniz.");
}
