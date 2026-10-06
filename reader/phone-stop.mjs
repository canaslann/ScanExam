import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { phoneRoot } from "./cloudflare-runtime.mjs";

try {
  const statePath = join(phoneRoot, "session.json");
  const state = await readFile(statePath, "utf8").then(JSON.parse);
  if (!state.active) console.log("Telefon bağlantısı zaten kapalı.");
  else {
    try { process.kill(state.pid, 0); }
    catch (error) {
      if (error.code !== "ESRCH") throw error;
      await writeFile(statePath, JSON.stringify({ active: false }), { mode: 0o600 });
      console.log("Önceki telefon işlemi zaten kapanmış; eski durum kaydı düzeltildi.");
      process.exit(0);
    }
    await writeFile(join(phoneRoot, "stop-request.json"), JSON.stringify({ pid: state.pid, secret: state.stopSecret }), { mode: 0o600 });
    let closed = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const latest = await readFile(statePath, "utf8").then(JSON.parse);
      if (!latest.active) { closed = true; break; }
    }
    if (!closed) throw new Error("Telefon süreci yanıt vermedi. Açık telefon terminalinde Ctrl+C kullanın.");
    console.log("Telefon bağlantısı ve ona ait sunucu kapatıldı. Model ve mevcut geliştirme sunucusu değiştirilmedi.");
  }
} catch (error) {
  if (error.code === "ENOENT") console.log("Aktif telefon bağlantısı bulunamadı.");
  else { console.error(error.message); process.exitCode = 1; }
}
