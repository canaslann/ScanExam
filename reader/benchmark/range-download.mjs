import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, stat, unlink, rmdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Small, bounded range transfers survive this connection's large-file resets.
// The caller must verify the complete file's SHA-256 before installing it.
export async function downloadRanges(url, path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  let offset = existsSync(path) ? (await stat(path)).size : 0;
  if (offset > bytes) throw new Error("Partial file is larger than the expected model");
  const temporary = await mkdtemp(join(dirname(path), "range-parts-"));
  const chunkMegabytes = Number(process.env.BENCHMARK_RANGE_CHUNK_MB || "2");
  if (!Number.isInteger(chunkMegabytes) || chunkMegabytes < 1 || chunkMegabytes > 64) throw new Error("Range chunk size must be 1-64 MB");
  const chunkBytes = chunkMegabytes * 1024 * 1024;
  const tracked = new Set();
  async function chunk(start, end) {
    const file = join(temporary, String(start));
    const header = `${file}.headers`;
    tracked.add(file); tracked.add(header);
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const status = await new Promise((done, fail) => {
          const child = spawn("curl.exe", ["--location", "--fail", "--silent", "--show-error",
            "--connect-timeout", "15", "--max-time", "90", "--range", `${start}-${end}`,
            "--dump-header", header, "--output", file, "--write-out", "%{http_code}", url],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          let output = "", error = "";
          child.stdout.on("data", (data) => { output += data; });
          child.stderr.on("data", (data) => { error += data; });
          child.once("error", fail);
          child.once("exit", (code) => code === 0 ? done(output.trim()) : fail(new Error(`Range ${start}: curl ${code}: ${error.slice(0, 160)}`)));
        });
        const headers = await readFile(header, "utf8");
        const range = [...headers.matchAll(/content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+)/gi)].at(-1);
        if (status !== "206" || !range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== bytes
          || (await stat(file)).size !== end - start + 1) throw new Error(`Server did not return the requested byte range ${start}-${end}`);
        return file;
      } catch (error) { if (attempt === 4) throw error; }
    }
  }
  try {
    let previousPercent = -10;
    while (offset < bytes) {
      const ranges = Array.from({ length: 4 }, (_, i) => offset + i * chunkBytes).filter((start) => start < bytes)
        .map((start) => [start, Math.min(bytes - 1, start + chunkBytes - 1)]);
      const results = await Promise.allSettled(ranges.map(([start, end]) => chunk(start, end)));
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      for (const result of results) {
        const data = await readFile(result.value);
        await appendFile(path, data);
        offset += data.length;
        await unlink(result.value); tracked.delete(result.value);
        await unlink(`${result.value}.headers`); tracked.delete(`${result.value}.headers`);
      }
      const percent = Math.floor(100 * offset / bytes);
      if (percent >= previousPercent + 5 || offset === bytes) {
        console.log(`${Math.round(offset / 1e6)} / ${Math.round(bytes / 1e6)} MB (${percent}%)`);
        previousPercent = percent;
      }
    }
  } finally {
    for (const file of tracked) await unlink(file).catch(() => {});
    await rmdir(temporary).catch(() => {});
  }
}
