import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { projectRoot } from "./runtime.mjs";

export const phoneRoot = join(projectRoot, "work", "phone");
const version = "2026.10.0";
const sha256 = "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c";
export const cloudflaredPath = join(phoneRoot, `cloudflared-${version}.exe`);

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function installCloudflared() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Telefon bağlantısının otomatik kurulumu Windows x64 içindir.");
  await mkdir(phoneRoot, { recursive: true });
  if (existsSync(cloudflaredPath)) {
    if (await digest(cloudflaredPath) !== sha256)
      throw new Error("Cloudflare aracının SHA-256 doğrulaması başarısız; çalıştırılmadı.");
    return;
  }
  console.log("Resmî cloudflared indiriliyor (~55 MB, yalnızca ilk kurulumda). Yeni OCR modeli indirilmiyor.");
  const partial = `${cloudflaredPath}.partial`;
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-windows-amd64.exe`;
  const total = 55_365_048, chunkSize = 1024 * 1024;
  const parts = Array.from({ length: Math.ceil(total / chunkSize) }, (_, index) => ({
    start: index * chunkSize, end: Math.min(total - 1, (index + 1) * chunkSize - 1), path: `${cloudflaredPath}.part-${index}`,
  }));
  let next = 0, complete = 0;
  const download = async () => {
    while (next < parts.length) {
      const part = parts[next++], expected = part.end - part.start + 1;
      const saved = await stat(part.path).catch(() => null);
      if (saved?.size !== expected) {
        const response = await fetch(url, { headers: { Range: `bytes=${part.start}-${part.end}` }, signal: AbortSignal.timeout(120_000) });
        if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${part.start}-${part.end}/${total}` || !response.body)
          throw new Error(`Cloudflare aracı parçası indirilemedi: HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(part.path));
        if ((await stat(part.path)).size !== expected) throw new Error("Cloudflare indirme parçası eksik.");
      }
      complete++;
      if (complete % 10 === 0) console.log(`Cloudflare: ${Math.round(complete * 100 / parts.length)}% indirildi`);
    }
  };
  // Bounded parallel ranges avoid a stalled single transfer on mobile hotspots.
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => download()));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  async function* assembled() { for (const part of parts) yield* createReadStream(part.path); }
  await pipeline(Readable.from(assembled()), createWriteStream(partial));
  if (await digest(partial) !== sha256) throw new Error("İndirilen Cloudflare aracının SHA-256 doğrulaması başarısız; çalıştırılmadı.");
  await rename(partial, cloudflaredPath);
  for (const part of parts) await unlink(part.path);
}
