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
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child.kill(signal); });
