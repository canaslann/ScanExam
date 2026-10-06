import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot, startReader } from "./runtime.mjs";
import { cloudflaredPath, installCloudflared, phoneRoot } from "./cloudflare-runtime.mjs";
import { createPhoneGateway } from "./phone-gateway.mjs";

let tunnel, application, gateway, stopTimer, ownsState = false, shuttingDown = false;
const statePath = join(phoneRoot, "session.json");
const stopSecret = randomBytes(24).toString("hex");
async function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(stopTimer);
  tunnel?.kill();
  gateway?.close();
  application?.closeAllConnections();
  application?.close();
  if (ownsState) await writeFile(statePath, JSON.stringify({ active: false }, null, 2), { mode: 0o600 }).catch(() => undefined);
  process.exitCode = code;
  // End only this launcher; the separately running local model/dev server are preserved.
  setTimeout(() => process.exit(code), 200).unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void stop(); });

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(projectRoot, "node_modules", "vinext", "dist", "cli.js"), "build"], { cwd: projectRoot, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Telefon sürümü derlenemedi; dış bağlantı açılmadı.")));
  });
}

async function startTunnel(port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { tunnel?.kill(); reject(new Error("Cloudflare bağlantısı 60 saniyede hazırlanamadı.")); }, 60_000);
    tunnel = spawn(cloudflaredPath, ["--no-autoupdate", "--config", join(projectRoot, "reader", "phone-cloudflared.yml"), "tunnel", "--protocol", "http2", "--url", `http://127.0.0.1:${port}`], {
      cwd: phoneRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "", found;
    const output = (data) => {
      buffer = (buffer + data.toString()).slice(-20_000);
      // The API hostname also appears in cloudflared error messages. Only
      // accept the explicitly announced tunnel URL, never an error endpoint.
      const match = buffer.match(/https:\/\/([a-z0-9]+(?:-[a-z0-9]+)+)\.trycloudflare\.com\b/);
      if (match && !found) {
        found = match[0];
        clearTimeout(timeout);
        resolve(found);
      }
      // Connection errors are actionable, but do not log tunnel tokens/credentials.
      if (/ERR/.test(data.toString())) console.warn(data.toString().trim());
    };
    tunnel.stdout.on("data", output);
    tunnel.stderr.on("data", output);
    tunnel.once("error", (error) => { clearTimeout(timeout); reject(error); });
    tunnel.once("exit", (code) => {
      clearTimeout(timeout);
      if (!found) reject(new Error(`Cloudflare aracı durdu (kod ${code}).`));
      if (!shuttingDown) { console.error("Telefon bağlantısı kapandı; npm run phone ile yeniden başlatın."); void stop(1); }
    });
  });
}

try {
  if (process.argv.includes("--setup-only")) {
    await installCloudflared();
    console.log("Cloudflare aracı doğrulandı. Dış bağlantı açılmadı.");
  } else {
    const previous = await readFile(statePath, "utf8").then(JSON.parse).catch(() => null);
    if (previous?.active) {
      try { process.kill(previous.pid, 0); }
      catch (error) { if (error.code === "ESRCH") previous.active = false; else throw error; }
      if (previous.active) throw new Error("Telefon bağlantısı zaten açık. Önce npm run phone:stop kullanın.");
    }
    console.log("Telefon HTTPS testi: fotoğraflar Cloudflare üzerinden bilgisayarınıza taşınır. Model yereldir.");
    await installCloudflared();
    await runBuild();
    try { await startReader(); }
    catch (error) { console.warn(`Yerel okuyucu: ${error.message}`); }
    const password = process.env.SCANEXAM_PHONE_PASSWORD || "scanexam";
    gateway = createPhoneGateway({ password });
    await new Promise((resolve, reject) => { gateway.server.once("error", reject); gateway.server.listen(0, "127.0.0.1", resolve); });
    const publicOrigin = await startTunnel(gateway.server.address().port);
    if (shuttingDown) throw new Error("Telefon bağlantısı iptal edildi.");
    // The exposed gateway remains fail-closed until the production application is ready.
    process.env.NODE_ENV = "production";
    process.env.SCANEXAM_PUBLIC_ORIGIN = publicOrigin;
    delete process.env.VINEXT_TRUST_PROXY;
    delete process.env.VINEXT_TRUSTED_HOSTS;
    const { startProdServer } = await import("vinext/server/prod-server");
    const result = await startProdServer({ port: 0, host: "127.0.0.1", outDir: join(projectRoot, "dist"), silent: true });
    application = result.server;
    const upstream = `http://127.0.0.1:${result.port}`;
    const check = await fetch(`${upstream}/api/reader`, { signal: AbortSignal.timeout(5000) });
    if (!check.ok) throw new Error("Telefon sürümünün yerel API kontrolü başarısız.");
    const sharedCheck = await fetch(`${upstream}/api/shared`, { signal: AbortSignal.timeout(5000) });
    if (!sharedCheck.ok) throw new Error("Telefon sürümünün ortak tablo kontrolü başarısız.");
    gateway.configure(publicOrigin, upstream);
    await mkdir(phoneRoot, { recursive: true });
    await writeFile(statePath, JSON.stringify({ active: true, url: publicOrigin, username: "scanexam", password, pid: process.pid, stopSecret, started: new Date().toISOString() }, null, 2), { mode: 0o600 });
    ownsState = true;
    stopTimer = setInterval(() => {
      void readFile(join(phoneRoot, "stop-request.json"), "utf8").then(JSON.parse).then((request) => {
        if (request.pid === process.pid && request.secret === stopSecret) void stop();
      }).catch(() => undefined);
    }, 1000);
    await writeFile(join(phoneRoot, "telefon-baglantisi.txt"), `Telefon bağlantısı: ${publicOrigin}\nKullanıcı adı: scanexam\nParola: ${password}\n\nBu bilgileri yalnız yetkili kişilerle paylaşın. Fotoğraflar Cloudflare üzerinden geçer; OCR modeli bilgisayarınızda çalışır.\nBağlantı geçicidir: yeniden başlatınca adres değişir. Bilgisayara aktarılmış ortak tablo/fotoğraflar work/shared altında korunur. Telefonda aktarılmayı bekleyen görüntü varsa bağlantıyı kapatmadan aktarımı tamamlayın; eski adrese ait telefon deposu yeni adrese taşınmaz.\nDurdurmak için npm run phone:stop kullanın.\n`, { mode: 0o600 });
    console.log(`\nTelefon bağlantısı hazır: ${publicOrigin}\nKullanıcı adı: scanexam\nParola: ${password}\n\nBilgiler work/phone/telefon-baglantisi.txt içinde.\nBu işlem açık kalmalı. Durdurmak için Ctrl+C veya npm run phone:stop.\nBilgisayardaki ortak tablo korunur; bağlantıyı kapatmadan telefonda bekleyen aktarımları tamamlayın.\n`);
  }
} catch (error) {
  console.error(error.message);
  await stop(1);
}
