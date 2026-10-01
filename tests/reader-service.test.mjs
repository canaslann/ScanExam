import assert from "node:assert/strict";
import test from "node:test";
import { getReaderStatus, readLocalPaper } from "../lib/local-reader.ts";

const raw = { fullName: "Örnek Öğrenci", studentNumber: "00001234567", courseCode: "DERS101", courseName: "ÖRNEK DERS",
  scores: ["20", "18", "12", "19", "11"], writtenTotal: "80", pcMap: ["PÇ2", "PÇ1", "PÇ3", "PÇ2", "PÇ4"], uncertainFields: [] };
const reply = (body, status = 200) => Response.json(body, { status });
const completed = (data = raw) => reply({ done: true, done_reason: "stop", message: { content: JSON.stringify(data) } });
const signal = () => new AbortController().signal;

test("service handles readiness, failures, double control and isolation", async (t) => {
  const savedFetch = globalThis.fetch;
  const savedUrl = process.env.SCANEXAM_READER_URL;
  const savedModel = process.env.SCANEXAM_MODEL;
  process.env.SCANEXAM_READER_URL = "http://127.0.0.1:11435";
  process.env.SCANEXAM_MODEL = "test-local";
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.SCANEXAM_READER_URL; else process.env.SCANEXAM_READER_URL = savedUrl;
    if (savedModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = savedModel;
  });

  await t.test("status does not load a model or upload images", async () => {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "http://127.0.0.1:11435/api/tags");
      assert.equal(options.body, undefined);
      return reply({ models: [{ name: "test-local" }] });
    };
    assert.equal((await getReaderStatus()).ready, true);
  });
  await t.test("missing service or model produces actionable status", async () => {
    globalThis.fetch = async () => reply({ models: [] });
    assert.equal((await getReaderStatus()).ready, false);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.match((await getReaderStatus()).message, /reader:setup/);
  });
  await t.test("single reading uses local schema and never invents confidence", async () => {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "http://127.0.0.1:11435/api/chat");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "test-local");
      assert.equal(body.think, false);
      assert.equal(body.stream, false);
      assert.equal(body.format.type, "object");
      assert.deepEqual(body.messages[0].images, ["local-image"]);
      return completed();
    };
    const result = await readLocalPaper("local-image", "single", signal());
    assert.equal(result.writtenTotal, "80");
    assert.equal(result.checkMode, "single");
    assert.deepEqual(result.confidence, {});
  });
  await t.test("double reading does not give prior answers to the second request", async () => {
    let requests = 0;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.messages.length, 1);
      assert.equal(body.messages[0].content.includes("00001234567"), false);
      return completed(++requests === 1 ? raw : { ...raw, scores: ["20", "18", "12", "17", "11"] });
    };
    const result = await readLocalPaper("local-image", "double", signal());
    assert.equal(requests, 2);
    assert.equal(result.scores[3], "19");
    assert.deepEqual(result.alternatives.s4, ["19", "17"]);
  });
  await t.test("failure of verification preserves first result without claiming double success", async () => {
    let requests = 0;
    globalThis.fetch = async () => ++requests === 1 ? completed() : reply({ error: "failed" }, 500);
    const result = await readLocalPaper("local-image", "double", signal());
    assert.equal(result.checkMode, "single");
    assert.equal(result.writtenTotal, "80");
    assert.match(result.warnings.at(-1), /İkinci okuma tamamlanamadı/);
  });
  await t.test("malformed and truncated outputs release the busy guard", async () => {
    globalThis.fetch = async () => reply({ done: true, message: { content: "not JSON" } });
    await assert.rejects(readLocalPaper("local-image", "single", signal()), (error) => error.status === 502);
    globalThis.fetch = async () => reply({ done: true, done_reason: "length", message: { content: JSON.stringify(raw) } });
    await assert.rejects(readLocalPaper("local-image", "single", signal()), (error) => error.status === 502);
    globalThis.fetch = async () => completed();
    assert.equal((await readLocalPaper("local-image", "single", signal())).fullName, raw.fullName);
  });
  await t.test("a concurrent scan is rejected and no second image is queued", async () => {
    let finish;
    globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
    const pending = readLocalPaper("first", "single", signal());
    await assert.rejects(readLocalPaper("second", "single", signal()), (error) => error.status === 409);
    finish(completed());
    await pending;
  });
  await t.test("configuration cannot send exam images to a remote address", async () => {
    let calls = 0;
    process.env.SCANEXAM_READER_URL = "https://remote.example";
    globalThis.fetch = async () => { calls += 1; return completed(); };
    await assert.rejects(readLocalPaper("local-image", "single", signal()));
    assert.equal(calls, 0);
    process.env.SCANEXAM_READER_URL = "http://127.0.0.1:11435";
  });
  await t.test("cloud labels are refused even when a local service is configured", async () => {
    process.env.SCANEXAM_MODEL = "test-cloud";
    const status = await getReaderStatus();
    assert.equal(status.ready, false);
    assert.match(status.message, /yerel modeller/);
    await assert.rejects(readLocalPaper("local-image", "single", signal()));
    process.env.SCANEXAM_MODEL = "test-local";
  });
});
