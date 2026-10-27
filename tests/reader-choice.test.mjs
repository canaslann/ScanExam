import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readerChoice, QWEN_MODEL } from "../lib/reader-choice.ts";
import { readSelectedPaper, selectedReaderStatus, validateReaderChoice } from "../lib/selected-reader.ts";
import { SharedSessionStore } from "../lib/shared-session.ts";
import { uploadCapture } from "../lib/shared-client.ts";
import { newSession, restoreSession } from "../lib/scan-session.ts";
import { readLocalPaper, warmLocalReader } from "../lib/local-reader.ts";

const raw = count => ({ fullName: "İpek Örnek", studentNumber: "00001234567", courseCode: "DERS101", courseName: "Örnek Ders",
  scores: Array(count).fill("10"), writtenTotal: "99", pcMap: Array(count).fill("PÇ2"), uncertainFields: [] });
const result = value => Response.json({ done: true, done_reason: "stop", message: { content: JSON.stringify(value) } });

test("only the two reader choices are accepted; old captures keep OCR", () => {
  assert.equal(readerChoice(undefined), "glm");
  for (const choice of ["glm", "qwen"]) assert.equal(validateReaderChoice(choice), choice);
  for (const choice of [null, "remote-cloud", "qwen3.5:27b", {}, 1])
    assert.throws(() => validateReaderChoice(choice), error => error.status === 400);
});

test("Qwen uses automatic GPU/CPU placement for both loading and direct reading, preserving literal totals/IDs", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const bytes = await sharp({ create: { width: 600, height: 900, channels: 3, background: "white" } }).jpeg().toBuffer();
  for (const count of [1, 5, 30]) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body); calls.push({ url, body });
      assert.equal(body.model, QWEN_MODEL);
      assert.equal(body.options.num_gpu, -1, "Ollama must choose how many layers fit instead of forcing full GPU placement");
      assert.equal(body.options.num_ctx, 8192);
      if (String(url).endsWith("/api/generate")) {
        assert.equal(body.images, undefined); return Response.json({ done: true });
      }
      assert.equal(body.think, false);
      assert.equal(body.format.properties.scores.minItems, count);
      assert.equal(body.messages.length, 1);
      const meta = await sharp(Buffer.from(body.messages[0].images[0], "base64")).metadata();
      assert.equal(meta.height, 900, "Qwen must receive the whole portrait page, not the OCR upper crop");
      return result(raw(count));
    };
    const output = await readSelectedPaper("qwen", bytes.toString("base64"), "double", new AbortController().signal, undefined, undefined, count);
    assert.equal(calls.length, 2, "one image-free load and exactly one visual transcription");
    assert.equal(output.checkMode, "single");
    assert.equal(output.studentNumber, "00001234567");
    assert.equal(output.writtenTotal, "99", "never calculate the handwritten total");
    assert.deepEqual(output.confidence, {});
  }
});

test("Qwen status never loads weights; missing weights never silently invoke OCR", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/api\/tags$/); assert.equal(init.body, undefined);
    return Response.json({ models: [{ name: QWEN_MODEL }] });
  };
  assert.equal((await selectedReaderStatus("qwen")).ready, true);
  let calls = 0;
  globalThis.fetch = async (_url, init) => { calls++; assert.equal(JSON.parse(init.body).model, QWEN_MODEL); return Response.json({}, { status: 404 }); };
  await assert.rejects(readSelectedPaper("qwen", "", "single", new AbortController().signal), /reader:setup:qwen/);
  assert.equal(calls, 1);
});

test("failed, partial and cancelled Qwen reads release the common busy gate", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const image = (await sharp({ create: { width: 400, height: 240, channels: 3, background: "white" } }).jpeg().toBuffer()).toString("base64");
  for (const reply of [() => Response.json({ done: true, done_reason: "length", message: { content: JSON.stringify(raw(5)) } }),
    () => Response.json({ done: true, message: { content: "not-json" } }), () => result(raw(3))]) {
    globalThis.fetch = async url => String(url).endsWith("/api/generate") ? Response.json({ done: true }) : reply();
    await assert.rejects(readSelectedPaper("qwen", image, "single", new AbortController().signal), error => error.status === 502);
  }
  const controller = new AbortController(); controller.abort();
  globalThis.fetch = async (_url, init) => { init.signal.throwIfAborted(); throw new Error("unexpected"); };
  await assert.rejects(readSelectedPaper("qwen", image, "single", controller.signal), error => error.status === 504);
  let finish;
  globalThis.fetch = async url => String(url).endsWith("/api/generate") ? new Promise(resolve => { finish = resolve; }) : result(raw(5));
  const pending = readSelectedPaper("qwen", image, "single", new AbortController().signal);
  await assert.rejects(readSelectedPaper("glm", image, "single", new AbortController().signal), error => error.status === 409);
  finish(Response.json({ done: true })); await pending;
});

test("model choice survives upload, SQLite restore, retries and alternating queue jobs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "scanexam-reader-choice-"));
  const path = join(directory, "test.sqlite");
  let store = new SharedSessionStore(path);
  const original = globalThis.fetch;
  t.after(async () => { globalThis.fetch = original; store.close(); await rm(directory, { recursive: true }); });
  const command = patch => ({ action: "capture", mode: "single", opId: randomUUID(), examId: store.snapshot().examId, ...patch });
  const oldId = randomUUID(), qwenId = randomUUID();
  store.mutate(command({ id: oldId }), new Uint8Array([1]));
  store.mutate(command({ id: qwenId, reader: "qwen" }), new Uint8Array([2]));
  assert.throws(() => store.mutate(command({ id: randomUUID(), reader: "external" }), new Uint8Array([3])), /modeli geçersiz/);
  store.close(); store = new SharedSessionStore(path);
  const first = store.claim(); assert.equal(first.row.reader, "glm"); store.finish(first.row.id, first.token, undefined, "test");
  const second = store.claim(); assert.equal(second.row.reader, "qwen"); store.finish(second.row.id, second.token, undefined, "test");
  store.mutate({ ...command({ id: qwenId }), action: "retry" });
  assert.equal(store.claim().row.reader, "qwen");
  const restored = store.snapshot().session;
  restored.rows[0].reader = "unexpected";
  assert.throws(() => restoreSession(restored), /Satır kaydı geçersiz/);
  globalThis.fetch = async url => {
    assert.equal(new URL(String(url), "http://localhost").searchParams.get("reader"), "qwen");
    return Response.json({ revision: 0, examId: randomUUID(), paused: false, session: newSession() });
  };
  await uploadCapture({ id: qwenId, opId: randomUUID(), examId: randomUUID(), mode: "single", reader: "qwen", blob: new Blob(["test"]) });
});

test("selecting GLM sends exactly the original requests and preserves its output", async t => {
  const original = globalThis.fetch, originalModel = process.env.SCANEXAM_MODEL;
  t.after(() => { globalThis.fetch = original; if (originalModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = originalModel; });
  process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
  const paper = { image: "full", regions: { scores: "scores", student: "student", course: "course" },
    identity: { fullNameZoom: "name", fullNameLabelled: "name-label", studentNumberZoom: "number", studentNumberLabelled: "number-label" } };
  let requests = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/api/tags")) return Response.json({ models: [] });
    const body = JSON.parse(init.body); requests.push({ url, body });
    const part = body.images[0];
    return Response.json({ done: true, done_reason: "stop", response: part === "scores"
      ? "<table><tr><td>(S1)-PÇ1</td><td>(S2)-PÇ2</td><td>(S3)-PÇ3</td></tr><tr><td>Puan</td><td>10</td><td>20</td><td>30</td></tr><tr><td>Not</td><td>60</td></tr></table>"
      : part === "course" ? "DERS101 Örnek Ders" : part.startsWith("name") ? "İpek Örnek" : "00001234567" });
  };
  const args = ["full", "single", new AbortController().signal, undefined, undefined, 3, paper];
  const before = await readLocalPaper(...args), expectedRequests = requests;
  requests = [];
  const after = await readSelectedPaper("glm", ...args);
  assert.deepEqual(requests, expectedRequests, "no added requests or changed model/options/prompts/images");
  assert.deepEqual({ ...after, elapsedMs: 0 }, { ...before, elapsedMs: 0 });
});

test("the actual server queue routes a Qwen capture without invoking the OCR reader", async t => {
  const directory = await mkdtemp(join(tmpdir(), "scanexam-qwen-queue-"));
  const original = globalThis.fetch, previousDirectory = process.env.SCANEXAM_DATA_DIR;
  process.env.SCANEXAM_DATA_DIR = directory;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/api/tags")) return Response.json({ models: [] });
    const body = JSON.parse(init.body); calls.push(body);
    return String(url).endsWith("/api/generate") ? Response.json({ done: true }) : result(raw(5));
  };
  const { sharedStore, wakeSharedReader } = await import("../lib/shared-service.ts");
  const store = sharedStore();
  t.after(async () => {
    store.close(); globalThis.fetch = original;
    if (previousDirectory === undefined) delete process.env.SCANEXAM_DATA_DIR; else process.env.SCANEXAM_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true });
  });
  await warmLocalReader(); calls.length = 0;
  const bytes = await sharp({ create: { width: 600, height: 900, channels: 3, background: "white" } }).jpeg().toBuffer();
  const id = randomUUID();
  store.mutate({ action: "capture", mode: "single", reader: "qwen", id, opId: randomUUID(), examId: store.snapshot().examId }, bytes);
  wakeSharedReader();
  for (let i = 0; i < 400; i++) {
    const row = store.snapshot().session.rows[0];
    if (row.status === "done" || row.status === "error") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const row = store.snapshot().session.rows[0];
  assert.equal(row.status, "done", row.error);
  assert.equal(row.reader, "qwen");
  assert.equal(row.draft.studentNumber, "00001234567");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(body => body.model === QWEN_MODEL));
});
