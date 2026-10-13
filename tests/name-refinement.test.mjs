import assert from "node:assert/strict";
import test from "node:test";
import { identityText } from "../lib/glm-ocr.ts";
import { needsNameRefinement, refineNameReadings } from "../lib/name-refinement.ts";
import { readLocalPaper, warmLocalReader } from "../lib/local-reader.ts";

const draft = (name, count = 5) => ({ fullName: name, studentNumber: "00001234567",
  scores: Array(count).fill("10"), writtenTotal: "78", confidence: {}, reviewFields: ["fullName"] });

test("Turkish diacritics survive name normalization; suspect letters trigger evidence, never a replacement map", () => {
  assert.equal(identityText("Adı Soyadı Nisa Koc\u0327", "fullName"), "Nisa Koç");
  const name = "Çağrı Şen İpek Öztürk";
  assert.equal(identityText(name.normalize("NFD"), "fullName"), name);
  assert.equal(needsNameRefinement(draft(name)), false);
  assert.equal(needsNameRefinement(draft("Nisa koq")), true);
  assert.equal(needsNameRefinement({ ...draft("Nisa kog"), alternatives: { fullName: ["Nisa koq"] } }), true);
  assert.equal(needsNameRefinement(draft("")), true);
  const foreign = draft("Qi Wang");
  assert.equal(refineNameReadings(foreign, ["Qi Wang", "Qi Wang"]).fullName, "Qi Wang");
});

test("a supported literal ç reading preserves the original first name and every dynamic numeric field", () => {
  for (const count of [1, 3, 7, 12, 30]) {
    const original = { ...draft("Nisa koq", count), alternatives: { fullName: ["Nisa koq", "Nisa kog"] } };
    const before = structuredClone(original);
    const result = refineNameReadings(original, ["Nisa Koç", "Nişan Koç"]);
    assert.equal(result.fullName, "Nisa Koç", "select the complete literal detail read, not the changed first name");
    assert.deepEqual(result.scores, before.scores);
    assert.equal(result.studentNumber, before.studentNumber);
    assert.equal(result.writtenTotal, before.writtenTotal);
    assert.deepEqual(result.confidence, {});
    assert.deepEqual(result.alternatives.fullName, ["Nisa koq", "Nisa kog", "Nisa Koç", "Nişan Koç"]);
    assert.ok(result.reviewFields.includes("fullName"));
    assert.deepEqual(original, before, "do not mutate the first reading");
  }
});

test("unsupported letters and multi-word rewrites preserve the first name; words are never stitched together", () => {
  const source = draft("Nisa koq");
  for (const readings of [["Nisa Koç", "Nisa Koğ"], ["Nişan Koç", "Nişan Koç"], ["Nisa Koç", ""], ["Nisa K04", "Nisa K04"]]) {
    const result = refineNameReadings(source, readings);
    assert.equal(result.fullName, "Nisa koq");
    assert.ok(result.reviewFields.includes("fullName"));
    assert.ok(result.alternatives.fullName.includes("Nisa koq"));
  }
  const blank = draft("");
  assert.equal(refineNameReadings(blank, ["Nisa Koç", "Nise Koç"]).fullName, "");
  assert.equal(refineNameReadings(blank, ["Nisa Koç", "Nisa Koç"]).fullName, "Nisa Koç");
});

test("a blank name needs two matching complete visual readings, with a third crop resolving the first disagreement", () => {
  const source = { ...draft(""), alternatives: { fullName: ["Nisa K04", "Nisa KO4"] } };
  const supported = refineNameReadings(source, ["Nisa Koç", "Nişan Koç", "Nisa Koç"]);
  assert.equal(supported.fullName, "Nisa Koç");
  assert.deepEqual(supported.alternatives.fullName, ["Nisa K04", "Nisa KO4", "Nisa Koç", "Nişan Koç"]);
  assert.deepEqual(supported.scores, source.scores);
  for (const values of [["Nisa Koç", "Nişan Koç", "Nise Koç"], ["Nisa Koç", "", ""], ["Nisa K04", "Nisa K04", "Nisa Koç"]])
    assert.equal(refineNameReadings(source, values).fullName, "");
  assert.equal(refineNameReadings(source, ["Nisa Koç", "Nisa Koç", "Nişan Koç", "Nişan Koç"]).fullName, "", "two conflicting supported names remain unresolved");
});

test("production tries a third padded name crop only when an empty name remains unresolved", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const images = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3.5:4b" }] });
    const body = JSON.parse(options.body);
    if (url.endsWith("/api/generate")) return Response.json({ done: true,
      response: body.images[0].startsWith("name") ? "Nisa K04" : native(body) });
    const image = body.messages[0].images[0]; images.push(image);
    assert.ok(!body.messages[0].content.includes("Nisa"));
    const value = image === "name-labelled" ? "Nişan Koç" : "Nisa Koç";
    return Response.json({ done: true, message: { content: JSON.stringify({ value }) } });
  };
  const result = await readLocalPaper("full", "single", new AbortController().signal, undefined, undefined, 1,
    { ...paper, identity: { ...paper.identity, fullNamePadded: "name-padded" } });
  assert.equal(result.fullName, "Nisa Koç");
  assert.deepEqual(images, ["name-zoom", "name-labelled", "name-padded"]);
  assert.deepEqual(result.scores, ["10"]);
  assert.equal(result.studentNumber, "00001234567");
});

test("a failed third name crop retains the completed alternatives and scores", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3.5:4b" }] });
    const body = JSON.parse(options.body);
    if (url.endsWith("/api/generate")) return Response.json({ done: true,
      response: body.images[0].startsWith("name") ? "Nisa K04" : native(body) });
    const image = body.messages[0].images[0];
    if (image === "name-padded") throw new Error("optional offline");
    return Response.json({ done: true, message: { content: JSON.stringify({ value: image === "name-labelled" ? "Nişan Koç" : "Nisa Koç" }) } });
  };
  const result = await readLocalPaper("full", "single", new AbortController().signal, undefined, undefined, 1,
    { ...paper, identity: { ...paper.identity, fullNamePadded: "name-padded" } });
  assert.equal(result.fullName, "");
  assert.ok(result.alternatives.fullName.includes("Nisa Koç"));
  assert.ok(result.alternatives.fullName.includes("Nişan Koç"));
  assert.deepEqual(result.scores, ["10"]);
  assert.equal(result.writtenTotal, "10");
});

const paper = { image: "full", regions: { scores: "scores", student: "student", course: "course" },
  identity: { fullNameZoom: "name-zoom", fullNameLabelled: "name-labelled", studentNumberZoom: "number-zoom", studentNumberLabelled: "number-labelled" } };
const native = input => input.images[0] === "scores"
  ? "|Soru-PÇ İlişkisi|(S1)-PÇ2|\n|Puan:|10|\n|Not:|10|"
  : input.images[0] === "course" ? "DERS101 ÖRNEK DERS"
  : input.images[0].startsWith("name") ? "Nisa koq" : "00001234567";

test("startup prepares both installed models with the same small-memory profile and tolerates optional failure", async t => {
  const originalFetch = globalThis.fetch, originalModel = process.env.SCANEXAM_MODEL;
  t.after(() => { globalThis.fetch = originalFetch; if (originalModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = originalModel; });
  process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
  for (const fail of [false, true]) {
    const loads = [];
    globalThis.fetch = async (url, options) => {
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3.5:4b" }] });
      assert.ok(url.endsWith("/api/generate"));
      const input = JSON.parse(options.body); loads.push(input);
      assert.equal(input.images, undefined); assert.equal(input.prompt, undefined);
      if (input.model === "qwen3.5:4b") {
        assert.deepEqual(input.options, { temperature: 0, num_ctx: 2048, num_gpu: 8 });
        if (fail) throw new Error("optional load failed");
      }
      return Response.json({ done: true });
    };
    await Promise.all([warmLocalReader(), warmLocalReader()]);
    assert.deepEqual(loads.map(input => input.model), ["qwen3.5:4b", "glm-ocr-eot:q8_0"]);
  }
});

test("production uses an installed local secondary reader only for names, keeping scores and manual review", async t => {
  const originalFetch = globalThis.fetch, originalModel = process.env.SCANEXAM_MODEL;
  t.after(() => { globalThis.fetch = originalFetch; if (originalModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = originalModel; });
  process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3.5:4b" }] });
    const input = JSON.parse(options.body); requests.push({ url, input });
    if (url.endsWith("/api/generate")) return Response.json({ done: true, response: native(input) });
    assert.equal(url, "http://127.0.0.1:11435/api/chat");
    assert.equal(input.model, "qwen3.5:4b");
    assert.equal(input.options.num_ctx, 2048);
    assert.equal(input.options.num_gpu, 8);
    assert.deepEqual(input.format.required, ["value"]);
    assert.equal(input.messages.length, 1);
    assert.ok(!input.messages[0].content.includes("Nisa"), "no known names in the prompt");
    const value = input.messages[0].images[0] === "name-zoom" ? "Nisa Koç" : "Nişan Koç";
    return Response.json({ done: true, done_reason: "stop", message: { content: JSON.stringify({ value }) } });
  };
  const result = await readLocalPaper("full", "single", new AbortController().signal, undefined, undefined, 1, paper);
  assert.equal(result.fullName, "Nisa Koç");
  assert.deepEqual(result.scores, ["10"]); assert.equal(result.writtenTotal, "10");
  assert.equal(result.studentNumber, "00001234567");
  assert.equal(requests.filter(r => r.url.endsWith("/api/chat")).length, 2);
  assert.ok(result.reviewFields.includes("fullName"));
  assert.ok(result.alternatives.fullName.includes("Nisa koq"));
});

test("missing, failed or incomplete optional readers retain completed GLM results; cancellation still aborts", async t => {
  const originalFetch = globalThis.fetch, originalModel = process.env.SCANEXAM_MODEL;
  t.after(() => { globalThis.fetch = originalFetch; if (originalModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = originalModel; });
  process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
  for (const failure of ["missing", "network", "length", "malformed"]) {
    let chats = 0;
    globalThis.fetch = async (url, options) => {
      assert.ok(!url.endsWith("/api/pull"));
      if (url.endsWith("/api/tags")) return Response.json({ models: failure === "missing" ? [] : [{ name: "qwen3.5:4b" }] });
      if (url.endsWith("/api/generate")) return Response.json({ done: true, response: native(JSON.parse(options.body)) });
      chats++;
      if (failure === "network") throw new Error("offline");
      return Response.json({ done: true, done_reason: failure === "length" ? "length" : "stop", message: { content: "invalid JSON" } });
    };
    const result = await readLocalPaper("full", "single", new AbortController().signal, undefined, undefined, 1, paper);
    assert.equal(result.fullName, "Nisa koq"); assert.deepEqual(result.scores, ["10"]);
    assert.equal(result.writtenTotal, "10"); assert.equal(result.studentNumber, "00001234567");
    assert.equal(chats, failure === "missing" ? 0 : 1);
    assert.ok(result.warnings.some(warning => warning.includes("Ek isim kontrol")));
  }
  const controller = new AbortController();
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/api/generate")) return Response.json({ done: true, response: native(JSON.parse(options.body)) });
    controller.abort();
    return Response.json({ models: [{ name: "qwen3.5:4b" }] });
  };
  await assert.rejects(readLocalPaper("full", "single", controller.signal, undefined, undefined, 1, paper), error => error.status === 504);
});

test("name plausibility triggers visual Emre selection without supplying the expected correction or changing surname/scores", async t => {
  const originalFetch = globalThis.fetch, originalModel = process.env.SCANEXAM_MODEL;
  t.after(() => { globalThis.fetch = originalFetch; if (originalModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = originalModel; });
  process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
  let assessments = 0, visualReads = 0;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3.5:4b" }] });
    const input = JSON.parse(options.body);
    if (url.endsWith("/api/generate")) {
      const response = input.images[0].startsWith("name") ? "Yunus Enre Güngör" : native(input);
      return Response.json({ done: true, response });
    }
    const message = input.messages[0];
    if (!message.images) {
      assessments++;
      assert.ok(message.content.includes('"Yunus Enre Güngör"'));
      assert.ok(!message.content.includes("Emre"), "assess the actual OCR string, not a known answer");
      return Response.json({ done: true, message: { content: '{"needsVisualCheck":true}' } });
    }
    visualReads++;
    assert.ok(!message.content.includes("Yunus"));
    const value = message.images[0] === "name-zoom" ? "Yunus Emre Güngör" : "Yunus Emre Günçör";
    return Response.json({ done: true, message: { content: JSON.stringify({ value }) } });
  };
  const result = await readLocalPaper("full", "single", new AbortController().signal, undefined, undefined, 1, paper);
  assert.equal(result.fullName, "Yunus Emre Güngör");
  assert.equal(assessments, 1); assert.equal(visualReads, 2);
  assert.deepEqual(result.scores, ["10"]); assert.equal(result.writtenTotal, "10");
  assert.equal(result.studentNumber, "00001234567");
  assert.ok(result.alternatives.fullName.includes("Yunus Enre Güngör"));
});

test("a plausible common name keeps native OCR and skips additional image reads; malformed assessment never edits it", async t => {
  const originalFetch = globalThis.fetch, originalModel = process.env.SCANEXAM_MODEL;
  t.after(() => { globalThis.fetch = originalFetch; if (originalModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = originalModel; });
  process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
  for (const assessment of [{ needsVisualCheck: false }, { needsVisualCheck: "true", value: "Başka İsim" }]) {
    let chats = 0;
    globalThis.fetch = async (url, options) => {
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3.5:4b" }] });
      const input = JSON.parse(options.body);
      if (url.endsWith("/api/generate")) return Response.json({ done: true,
        response: input.images[0].startsWith("name") ? "Recep Erdoğan" : native(input) });
      chats++;
      assert.equal(input.messages[0].images, undefined);
      return Response.json({ done: true, message: { content: JSON.stringify(assessment) } });
    };
    const result = await readLocalPaper("full", "single", new AbortController().signal, undefined, undefined, 1, paper);
    assert.equal(result.fullName, "Recep Erdoğan");
    assert.deepEqual(result.scores, ["10"]); assert.equal(chats, 1);
  }
});
