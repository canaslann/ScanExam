import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { patchGlmEot, installGlmEot } from "../reader/glm-install.mjs";
const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
const string = value => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
function fixture(token = "<|user|>") {
  const header = Buffer.concat([Buffer.from("GGUF"), u32(3), u64(1), u64(2)]);
  const metadata = Buffer.concat([string("general.alignment"), u32(4), u32(32),
    string("tokenizer.ggml.tokens"), u32(9), u32(8), u64(2), string("zero"), string(token)]);
  const tensor = Buffer.concat([string("test.weight"), u32(1), u64(3), u32(0), u64(0)]);
  const prefix = Buffer.concat([header, metadata, tensor]);
  const data = Buffer.from([3, 1, 4, 1, 5, 9, 2, 6, 5]);
  return { bytes: Buffer.concat([prefix, Buffer.alloc(Math.ceil(prefix.length / 32) * 32 - prefix.length), data]), tensor, data };
}
test("EOT metadata-only installer keeps tensor descriptors/data and refuses overwrites or invalid sources", async t => {
  const directory = await mkdtemp(join(tmpdir(), "scanexam-glm-test-"));
  t.after(() => rm(directory, { recursive: true }));
  const source = join(directory, "source.gguf"), destination = join(directory, "eot.gguf");
  const original = fixture(); await writeFile(source, original.bytes);
  const provenance = await patchGlmEot(source, destination);
  assert.equal(provenance.tokenId, 1); assert.equal(provenance.tensorCount, 1);
  assert.equal(provenance.originalDataSha256, provenance.patchedDataSha256);
  const patched = await readFile(destination);
  assert.equal(patched.readBigUInt64LE(16), 3n);
  assert.equal(patched.includes(original.tensor), true);
  assert.deepEqual(patched.subarray(-original.data.length), original.data);
  assert.equal(patched.indexOf(original.tensor) > original.bytes.indexOf(original.tensor), true);
  assert.deepEqual(await readFile(source), original.bytes);
  await assert.rejects(patchGlmEot(source, destination), /üzerine yazılmadı/);
  await assert.rejects(patchGlmEot(destination, join(directory, "twice.gguf")), /metadata/);
  await writeFile(source, fixture("no-token").bytes);
  await assert.rejects(patchGlmEot(source, join(directory, "bad.gguf")), /metadata/);
});


test("moved registry tags use the pinned source and reject mismatched downloaded weights", async t => {
  const directory = await mkdtemp(join(tmpdir(), "scanexam-glm-pinned-"));
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await rm(directory, { recursive: true }); });
  const requests = [];
  let pulled = false;
  globalThis.fetch = async url => {
    requests.push(url);
    return url.endsWith("/api/tags") ? Response.json({ models: [] }) : new Response("incorrect weights");
  };
  await assert.rejects(installGlmEot({ projectRoot: directory, readerUrl: "http://127.0.0.1:11435", pullSource: async () => { pulled = true; } }), /SHA-256/);
  assert.equal(pulled, true);
  assert.equal(requests[1], "https://registry.ollama.ai/v2/library/glm-ocr/blobs/sha256:24ca1840804a2aa3faeb2cadf31f628ec8bd48393cf1938c414f0e6cda81914a");
  assert.deepEqual(await readdir(join(directory, "work", "reader", "models", "blobs")), []);
});
