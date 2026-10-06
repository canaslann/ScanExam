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
  const savedRegions = process.env.SCANEXAM_REGION_READING;
  const savedFast = process.env.SCANEXAM_FAST_READING;
  process.env.SCANEXAM_READER_URL = "http://127.0.0.1:11435";
  process.env.SCANEXAM_MODEL = "test-local";
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.SCANEXAM_READER_URL; else process.env.SCANEXAM_READER_URL = savedUrl;
    if (savedModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = savedModel;
    if (savedRegions === undefined) delete process.env.SCANEXAM_REGION_READING; else process.env.SCANEXAM_REGION_READING = savedRegions;
    if (savedFast === undefined) delete process.env.SCANEXAM_FAST_READING; else process.env.SCANEXAM_FAST_READING = savedFast;
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
  const regionImages = { student: "student-image", course: "course-image", scores: "scores-image" };
  const regionReply = (image, data = raw) => {
    const fields = image === "student-image" ? ["fullName", "studentNumber", "uncertainFields"]
      : image === "course-image" ? ["courseCode", "courseName", "uncertainFields"] : ["scores", "writtenTotal", "pcMap", "uncertainFields"];
    return completed(Object.fromEntries(fields.map((key) => [key, data[key]])));
  };
  process.env.SCANEXAM_MODEL = "qwen3.5:4b";
  process.env.SCANEXAM_REGION_READING = "on";
  await t.test("regional single reads exactly three independent images with smaller schemas", async () => {
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      assert.equal(body.model, "qwen3.5:4b");
      assert.equal(body.think, false);
      assert.equal(body.messages.length, 1);
      assert.equal(body.messages[0].content.includes(raw.studentNumber), false);
      return regionReply(body.messages[0].images[0]);
    };
    const result = await readLocalPaper("full-image", "single", signal(), regionImages);
    assert.equal(result.readingStrategy, "regions");
    assert.deepEqual(requests.map((body) => body.messages[0].images[0]), ["scores-image", "student-image", "course-image"]);
    assert.deepEqual(requests[1].format.required, ["fullName", "studentNumber", "uncertainFields"]);
    assert.equal(result.studentNumber, raw.studentNumber);
  });
  await t.test("numeric uncertainty/mismatch stops early and uses original full-table prompt; total is never repaired", async () => {
    for (const changed of [{ ...raw, writtenTotal: "57" }, { ...raw, uncertainFields: ["s4"] }, { ...raw, uncertainFields: ["pcMap"] }, { ...raw, writtenTotal: "" }]) {
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body), image = body.messages[0].images[0]; requests.push(image);
        if (image === "full-image") {
          assert.deepEqual(body.format.required, ["fullName", "studentNumber", "courseCode", "courseName", "scores", "writtenTotal", "pcMap", "uncertainFields"]);
          assert.equal(body.messages[0].content.includes("57"), false);
          assert.equal(body.messages[0].content.includes(raw.studentNumber), false);
        }
        return image === "full-image" ? completed({ ...raw, writtenTotal: "78" }) : regionReply(image, changed);
      };
      const result = await readLocalPaper("full-image", "single", signal(), regionImages);
      assert.equal(result.readingStrategy, "full-table");
      assert.equal(result.writtenTotal, "78"); // NOT the calculated 80 or the region's 57.
      assert.deepEqual(result.scores, raw.scores);
      assert.deepEqual(requests, ["scores-image", "full-image"]);
      assert.match(result.warnings.at(-1), /aritmetik ile düzeltilmedi/);
      if (changed.writtenTotal === "57") assert.deepEqual(result.alternatives.writtenTotal, ["78", "57"]);
    }
  });
  await t.test("a failed full-table fallback is not retried inside the same reading", async () => {
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const image = JSON.parse(options.body).messages[0].images[0]; requests.push(image);
      return image === "full-image" ? reply({ error: "failed" }, 500) : regionReply(image, { ...raw, writtenTotal: "57" });
    };
    await assert.rejects(readLocalPaper("full-image", "single", signal(), regionImages), (error) => error.status === 502);
    assert.deepEqual(requests, ["scores-image", "full-image"]);
  });
  await t.test("truncated region falls back without retaining partial predictions", async () => {
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const image = JSON.parse(options.body).messages[0].images[0]; requests.push(image);
      return image === "full-image" ? completed() : reply({ done: true, done_reason: "length", message: { content: "{}" } });
    };
    const result = await readLocalPaper("full-image", "single", signal(), regionImages);
    assert.deepEqual(requests, ["scores-image", "full-image"]);
    assert.equal(result.fullName, raw.fullName);
  });
  await t.test("region disable switch uses legacy full-table path", async () => {
    process.env.SCANEXAM_REGION_READING = "off";
    globalThis.fetch = async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body).messages[0].images, ["full-image"]);
      return completed();
    };
    assert.equal((await readLocalPaper("full-image", "single", signal(), regionImages)).readingStrategy, "full-table");
    process.env.SCANEXAM_REGION_READING = "on";
  });
  await t.test("regional double has six fresh requests and preserves disagreements", async () => {
    let count = 0;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body), image = body.messages[0].images[0]; count++;
      assert.equal(body.messages[0].content.includes(raw.studentNumber), false);
      assert.equal(body.messages[0].content.startsWith("Make a fresh"), count > 3);
      return regionReply(image, count > 3 ? { ...raw, fullName: "Başka Öğrenci" } : raw);
    };
    const result = await readLocalPaper("full-image", "double", signal(), regionImages);
    assert.equal(count, 6);
    assert.equal(result.fullName, raw.fullName);
    assert.deepEqual(result.alternatives.fullName, [raw.fullName, "Başka Öğrenci"]);
    assert.equal(result.readingStrategy, "regions");
  });
  await t.test("cancellation does not trigger a fallback request and releases busy guard", async () => {
    const controller = new AbortController(); let calls = 0;
    globalThis.fetch = async () => { calls++; controller.abort(); throw new Error("aborted"); };
    await assert.rejects(readLocalPaper("full-image", "single", controller.signal, regionImages), (error) => error.status === 504);
    assert.equal(calls, 1);
    globalThis.fetch = async (_url, options) => regionReply(JSON.parse(options.body).messages[0].images[0]);
    assert.equal((await readLocalPaper("full-image", "single", signal(), regionImages)).writtenTotal, "80");
  });
  delete process.env.SCANEXAM_REGION_READING;
  delete process.env.SCANEXAM_FAST_READING;
  await t.test("automatic CPU path preserves original full schema/prompt on compact complete table", async () => {
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push(url);
      if (url.endsWith("/api/ps")) return reply({ models: [{ name: "qwen3.5:4b", size_vram: 0 }] });
      const body = JSON.parse(options.body);
      assert.deepEqual(body.messages[0].images, ["compact-image"]);
      assert.equal(body.format.required.length, 8);
      return completed();
    };
    const result = await readLocalPaper("full-image", "single", signal(), regionImages, "compact-image");
    assert.equal(result.readingStrategy, "compact-table");
    assert.equal(requests.length, 2);
  });
  await t.test("cold automatic GPU path loads without sending any image/answer then uses regions", async () => {
    let inspections = 0; const images = [];
    globalThis.fetch = async (url, options) => {
      if (url.endsWith("/api/ps")) return reply({ models: ++inspections === 1 ? [] : [{ name: "qwen3.5:4b", size_vram: 123456 }] });
      const body = JSON.parse(options.body);
      if (url.endsWith("/api/generate")) {
        assert.equal(body.images, undefined); assert.equal(body.prompt, undefined); assert.equal(body.model, "qwen3.5:4b");
        return reply({ done: true });
      }
      const image = body.messages[0].images[0]; images.push(image);
      return regionReply(image);
    };
    const result = await readLocalPaper("full-image", "single", signal(), regionImages, "compact-image");
    assert.equal(result.readingStrategy, "regions");
    assert.equal(inspections, 2);
    assert.deepEqual(images, ["scores-image", "student-image", "course-image"]);
  });
  await t.test("unknown offload or disabled optimization retains original image", async () => {
    for (const disabled of [false, true]) {
      if (disabled) process.env.SCANEXAM_FAST_READING = "off";
      let inspections = 0;
      globalThis.fetch = async (url, options) => {
        if (url.endsWith("/api/ps")) { inspections++; return reply({ models: [{ name: "qwen3.5:4b", size_vram: "unknown" }] }); }
        assert.deepEqual(JSON.parse(options.body).messages[0].images, ["full-image"]);
        return completed();
      };
      assert.equal((await readLocalPaper("full-image", "single", signal(), regionImages, "compact-image")).readingStrategy, "full-table");
      assert.equal(inspections, disabled ? 0 : 1);
    }
    delete process.env.SCANEXAM_FAST_READING;
  });
  await t.test("abort while detecting backend never submits an image or retries", async () => {
    const controller = new AbortController(); let requests = 0;
    globalThis.fetch = async () => { requests++; controller.abort(); throw new Error("abort"); };
    await assert.rejects(readLocalPaper("full-image", "single", controller.signal, regionImages, "compact-image"), (error) => error.status === 504);
    assert.equal(requests, 1);
  });
});
