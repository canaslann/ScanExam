import { spawn } from "node:child_process";
import { join } from "node:path";
import { projectRoot, startReader } from "./runtime.mjs";

try { await startReader(); }
catch (error) { console.warn(`${error.message}\nUygulama açılacak; otomatik el yazısı okuma için yerel motor gerekir.`); }

const command = process.argv[2] || "dev";
if (!["dev", "start"].includes(command)) throw new Error("Sunucu komutu dev veya start olmalı.");
const child = spawn(process.execPath, [join(projectRoot, "node_modules", "vinext", "dist", "cli.js"), command, ...process.argv.slice(3)], {
  cwd: projectRoot, stdio: "inherit", windowsHide: true,
});
// Initialize the durable queue at startup, without requiring a browser tab.
let childExited = false;
child.once("exit", () => { childExited = true; });
void (async () => {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : Number(process.env.PORT || (command === "dev" ? 5173 : 3000));
  const cert = command === "dev" && process.env.SCANEXAM_HTTPS_CERT;
  // For custom development TLS, the browser's first authorized GET initializes
  // the queue; do not bypass certificate verification in the launcher.
  if (cert || !Number.isInteger(port) || port < 1 || port > 65535) return;
  for (let attempt = 0; attempt < 40 && !childExited; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/shared`, { signal: AbortSignal.timeout(2000) })).ok) return; }
    catch { /* Server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
})();
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child.kill(signal); });
