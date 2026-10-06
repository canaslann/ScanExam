import assert from "node:assert/strict";
import test from "node:test";
import { allowedReaderOrigin } from "../lib/request-origin.ts";

test("HTTP default rejects foreign, mismatched port and HTTPS origins", () => {
  assert.equal(allowedReaderOrigin("http://localhost:5173/api/reader", "http://localhost:5173"), true);
  for (const origin of ["null", "http://evil.example", "http://localhost:5174", "https://localhost:5173"]) assert.equal(allowedReaderOrigin("http://localhost:5173/api/reader", origin), false);
});
test("configured direct HTTPS accepts ONLY the same host and port; no forwarded-header trust", () => {
  const options = { directHttps: true };
  assert.equal(allowedReaderOrigin("http://scan.local:5173/api/reader", "https://scan.local:5173", options), true);
  for (const origin of ["https://evil.example:5173", "http://scan.local:5173", "https://scan.local", "null"]) assert.equal(allowedReaderOrigin("http://scan.local:5173/api/reader", origin, options), false);
});
test("public HTTPS origin requires matching authority, never accepts a path or insecure origin", () => {
  const options = { publicOrigin: "https://scan.local:8443" };
  assert.equal(allowedReaderOrigin("http://scan.local:8443/api/reader", "https://scan.local:8443", options), true);
  assert.equal(allowedReaderOrigin("http://localhost:3000/api/reader", "https://scan.local:8443", options), false);
  for (const origin of ["http://scan.local", "https://scan.local/path", "https://user:secret@scan.local"]) assert.throws(() => allowedReaderOrigin("http://scan.local/api/reader", "https://scan.local", { publicOrigin: origin }));
});
