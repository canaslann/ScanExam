import vinext from "vinext";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const cert = process.env.SCANEXAM_HTTPS_CERT,
  key = process.env.SCANEXAM_HTTPS_KEY;
if (Boolean(cert) !== Boolean(key))
  throw new Error(
    "HTTPS için SCANEXAM_HTTPS_CERT ve SCANEXAM_HTTPS_KEY birlikte ayarlanmalı.",
  );

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
    ...(cert && key
      ? { https: { cert: readFileSync(cert), key: readFileSync(key) } }
      : {}),
  },
  plugins: [vinext()],
});
