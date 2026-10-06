import { spawn } from "node:child_process";
import { createWriteStream, createReadStream, existsSync } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const work = join(root, "work", "benchmark");
export const engine = join(root, "work", "reader", "v0.35.0");
export const modelStore = join(root, "work", "reader", "models");
export const ollamaUrl = "http://127.0.0.1:11436";
export const paddleUrl = "http://127.0.0.1:11437";
export const cpuEnv = { ...process.env, CUDA_VISIBLE_DEVICES: "-1", HIP_VISIBLE_DEVICES: "-1",
  GGML_VK_VISIBLE_DEVICES: "-1", OLLAMA_VULKAN: "0", OLLAMA_IGPU_ENABLE: "0", OLLAMA_NO_CLOUD: "true" };

export async function startService(executable, args, url, health, env = cpuEnv, name = "service") {
  await mkdir(work, { recursive: true });
  try {
    await fetch(`${url}${health}`, { signal: AbortSignal.timeout(500) });
    throw new Error(`Test portu kullanımda: ${url}. Mevcut süreç durdurulmadı.`);
  } catch (error) {
    if (error.message.startsWith("Test portu")) throw error;
  }
  const log = createWriteStream(join(work, `${name}.log`), { flags: "a" });
  const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let startupError;
  child.on("error", (error) => { startupError = error; });
  child.on("exit", () => log.end());
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((done) => child.once("exit", done));
    if (process.platform === "win32") {
      await new Promise((done) => {
        const cleanup = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        cleanup.once("error", () => { child.kill(); done(); });
        cleanup.once("exit", done);
      });
    } else child.kill();
    await exited;
  };
  for (let i = 0; i < 180; i++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`${name} çıkış kodu ${child.exitCode}; work/benchmark/${name}.log dosyasına bakın.`);
    try {
      const response = await fetch(`${url}${health}`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { child, stop };
    } catch { /* Model initialization can take longer than a health check. */ }
    await new Promise((done) => setTimeout(done, 1000));
  }
  await stop();
  throw new Error(`${name} başlatılamadı.`);
}

export function startOllama(device = "cpu") {
  return startService(join(engine, "ollama.exe"), ["serve"], ollamaUrl, "/api/version", {
    ...(device === "cpu" ? cpuEnv : process.env), OLLAMA_HOST: "127.0.0.1:11436", OLLAMA_MODELS: modelStore, OLLAMA_NUM_PARALLEL: "1", OLLAMA_NO_CLOUD: "true",
    OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_CONTEXT_LENGTH: "4096", OLLAMA_NOPRUNE: "true",
  }, `ollama-${device}`);
}

export async function pull(model) {
  console.log(`İndiriliyor: ${model}`);
  const response = await fetch(`${ollamaUrl}/api/pull`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }), signal: AbortSignal.timeout(3_600_000) });
  if (!response.ok || !response.body) throw new Error(`${model}: HTTP ${response.status}`);
  let buffer = "", lastStatus = "", lastPercent = -10;
  const handle = (line) => {
    if (!line.trim()) return;
    const value = JSON.parse(line);
    if (value.error) throw new Error(value.error);
    const percent = value.total ? Math.floor(100 * (value.completed || 0) / value.total) : null;
    if (value.status !== lastStatus || (percent !== null && percent >= lastPercent + 20)) {
      console.log(`${model}: ${value.status}${percent === null ? "" : ` ${percent}%`}`);
      if (value.status !== lastStatus) lastPercent = -10;
      lastStatus = value.status;
      if (percent !== null) lastPercent = percent;
    }
  };
  for await (const part of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += part;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) handle(line);
  }
  handle(buffer);
}

export const paddleFiles = [
  { name: "PaddleOCR-VL-1.5.gguf", bytes: 935768992, sha256: "299051d54faa065abc505cc39b8383ea338fd3020c775ea3e0ba514a7022328c" },
  { name: "PaddleOCR-VL-1.5-mmproj.gguf", bytes: 881770496, sha256: "e7f1a72400fba517046f90d964e2fa0f4dac7781ee3b1bc5d2022f5f8cecbd87" },
];

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function downloadPaddle() {
  const directory = join(work, "models", "paddle");
  await mkdir(directory, { recursive: true });
  for (const file of paddleFiles) {
    const path = join(directory, file.name);
    if (existsSync(path) && (await stat(path)).size === file.bytes && await sha256(path) === file.sha256) continue;
    console.log(`İndiriliyor: PaddlePaddle/${file.name} (${Math.round(file.bytes / 1e6)} MB)`);
    await downloadFile(`https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5-GGUF/resolve/main/${file.name}?download=true`, `${path}.partial`, file.bytes);
    if ((await stat(`${path}.partial`)).size !== file.bytes || await sha256(`${path}.partial`) !== file.sha256) {
      throw new Error(`Paddle dosyası SHA-256 kontrolünden geçmedi: ${file.name}`);
    }
    await rename(`${path}.partial`, path);
  }
}

export async function downloadFile(url, path, bytes) {
  if (process.env.BENCHMARK_RANGE_DOWNLOAD === "1" && bytes > 2 * 1024 * 1024) {
    const { downloadRanges } = await import("./range-download.mjs");
    return downloadRanges(url, path, bytes);
  }
  let lastPercent = -1;
  const timer = setInterval(async () => {
    try {
      const size = (await stat(path)).size;
      const percent = Math.floor(100 * size / bytes);
      if (percent >= lastPercent + 5) { console.log(`${Math.round(size / 1e6)} / ${Math.round(bytes / 1e6)} MB (${percent}%)`); lastPercent = percent; }
    } catch { /* No partial file yet. */ }
  }, 5000);
  try {
    for (let attempt = 1; attempt <= 12; attempt++) {
      try {
        await new Promise((done, fail) => {
      const child = spawn("curl.exe", ["--location", "--fail", "--silent", "--show-error", "--retry", "3",
        "--connect-timeout", "20", "--max-time", "300", "--continue-at", "-", "--output", path, url],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.on("data", (chunk) => { error += chunk.toString(); });
      child.once("error", fail);
      child.once("exit", (code) => code === 0 ? done() : fail(new Error(`Model download failed (${code}): ${error.slice(0, 500)}`)));
        });
        break;
      } catch (error) {
        if (attempt === 12) throw error;
        console.log(`Bağlantı yeniden kuruluyor (${attempt}/12); kısmi dosya korunuyor: ${error.message.slice(0, 200)}`);
      }
    }
  } finally { clearInterval(timer); }
}

export function startPaddle(threads, device = "cpu") {
  const directory = join(work, "models", "paddle");
  const gpuDirectory = join(engine, "lib", "ollama", "cuda_v13");
  const autoEnv = { ...process.env, GGML_BACKEND_PATH: join(gpuDirectory, "ggml-cuda.dll"),
    PATH: `${gpuDirectory};${process.env.PATH || process.env.Path || ""}` };
  return startService(join(engine, "lib", "ollama", "llama-server.exe"), [
    "-m", join(directory, paddleFiles[0].name), "--mmproj", join(directory, paddleFiles[1].name),
    "--host", "127.0.0.1", "--port", "11437", ...(device === "cpu" ? ["--device", "none", "-ngl", "0", "--no-mmproj-offload"] : ["-ngl", "all"]),
    "-t", String(threads), "-tb", String(threads), "-c", "4096", "--parallel", "1", "--cache-ram", "0", "--temp", "0",
  ], paddleUrl, "/health", device === "cpu" ? cpuEnv : autoEnv, `paddle-${device}`);
}
