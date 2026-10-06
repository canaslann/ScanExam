import assert from "node:assert/strict";
import test from "node:test";
import { identityText, parseGlmScores, readGlmRegions } from "../lib/glm-ocr.ts";
import { readLocalPaper, warmLocalReader } from "../lib/local-reader.ts";
const table = count => `<table><tr><td>Soru-PÇ İlişkisi</td>${Array.from({ length: count }, (_, i) => `<td>(S${i + 1})-PÇ${i % 2 ? 12 : 2}</td>`).join("")}</tr>
  <tr><td>Puan:</td>${Array(count).fill("<td>10</td>").join("")}</tr><tr><td>Not:</td><td colspan="${count}">78</td></tr></table>`;
test("GLM native tables preserve dynamic columns, repeated PÇ values, literal totals and blanks", () => {
  for (const count of [1, 3, 7, 12, 30]) {
    const result = parseGlmScores(table(count), count);
    assert.equal(result.scores.length, count); assert.equal(result.writtenTotal, "78");
    assert.equal(result.pcMap[0], "PÇ2"); if (count > 1) assert.equal(result.pcMap[1], "PÇ12");
    assert.deepEqual(result.uncertainFields, []);
    const invalid = parseGlmScores(table(count + 1), count);
    assert.ok(invalid.scores.every(value => value === "")); assert.ok(invalid.uncertainFields.includes("s1"));
  }
  assert.equal(parseGlmScores(table(3).replace("<td>10</td>", "<td></td>"), 3).scores[0], "");
});
test("GLM preparation is deduplicated, image-free and waits for a completed native load", async t => {
  const originalFetch = globalThis.fetch, originalModel = process.env.SCANEXAM_MODEL;
  t.after(() => { globalThis.fetch = originalFetch; if (originalModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = originalModel; });
  process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    assert.ok(url.endsWith("/api/generate"));
    const input = JSON.parse(options.body);
    assert.equal(input.images, undefined); assert.equal(input.prompt, undefined); assert.equal(input.options, undefined);
    assert.equal(input.keep_alive, "30m"); return Response.json({ done: true, done_reason: "load" });
  };
  await Promise.all([warmLocalReader(), warmLocalReader()]);
  assert.equal(calls.length, 1);
  await warmLocalReader();
  assert.equal(calls.length, 2, "a later queued paper refreshes the keep-alive without sending image/prompt");
});
test("production GLM uses native local generation with dynamic limits, preserving scores on truncated identity", async t => {
  const originalFetch = globalThis.fetch, originalModel = process.env.SCANEXAM_MODEL;
  t.after(() => { globalThis.fetch = originalFetch; if (originalModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = originalModel; });
  process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
  const paper = { image: "full", regions: { scores: "scores", student: "student", course: "course" },
    identity: { fullNameZoom: "name-zoom", fullNameLabelled: "name-labelled", studentNumberZoom: "number-zoom", studentNumberLabelled: "number-labelled" } };
  const requests = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:11435/api/generate");
    const input = JSON.parse(options.body); requests.push(input);
    assert.equal(input.stream, false); assert.equal(input.keep_alive, "30m"); assert.equal(input.format, undefined); assert.equal(input.options.num_gpu, undefined);
    assert.equal(input.options.temperature, 0); assert.equal(input.images.length, 1);
    const part = input.images[0];
    if (part === "number-zoom") return Response.json({ done: true, done_reason: "length", response: "1234567890".repeat(8) });
    const response = part === "scores" ? table(30) : part === "course" ? "BILM374-2022-YAPAY ZEKA" : part.startsWith("name") ? "İpek Örnek" : "00001234567";
    return Response.json({ done: true, done_reason: "stop", response });
  };
  const output = await readLocalPaper("full", "single", new AbortController().signal, undefined, undefined, 30, paper);
  assert.equal(requests.length, 6); assert.equal(requests[0].prompt, "Table Recognition:");
  assert.equal(requests[0].options.num_predict, 2340);
  assert.ok(requests.slice(1).every(input => input.prompt === "Text Recognition:" && input.options.num_predict === 128));
  assert.equal(output.scores.length, 30); assert.equal(output.studentNumber, "00001234567");
  assert.ok(output.reviewFields.includes("studentNumber")); assert.deepEqual(output.confidence, {});
});
test("GLM identity normalization preserves zeros and handwriting; repeating digits are never shortened to a valid prefix", () => {
  assert.equal(identityText("Numarasi 000 012 345 67", "studentNumber"), "00001234567");
  assert.equal(identityText("Adi Soyadi İpek Örnek", "fullName"), "İpek Örnek");
  assert.equal(identityText("02230L0+064", "studentNumber"), "02230L0+064");
  assert.equal(identityText("0123456789".repeat(8), "studentNumber"), "");
});
test("GLM identity crop disagreements and truncated fields preserve numeric output without invented confidence", async () => {
  const paper = { image: "full", regions: { scores: "scores", student: "student", course: "course" },
    identity: { fullNameZoom: "name-zoom", fullNameLabelled: "name-labelled", studentNumberZoom: "number-zoom", studentNumberLabelled: "number-labelled" } };
  const result = await readGlmRegions(paper, 3, async image => {
    if (image === "scores") return table(3);
    if (image === "course") return "BILM374-2022-YAPAY ZEKA";
    if (image === "name-zoom") return "İpek Örnek";
    if (image === "name-labelled") return "Adı Soyadı İpek Ornek";
    if (image === "number-labelled") return "Numarası 00001234567";
    throw Object.assign(new Error("truncated"), { status: 502 });
  });
  assert.equal(result.fullName, "İpek Örnek"); assert.equal(result.studentNumber, "00001234567");
  assert.deepEqual(result.scores, ["10", "10", "10"]); assert.equal(result.writtenTotal, "78");
  assert.deepEqual(result.alternatives.fullName, ["İpek Örnek", "İpek Ornek"]);
  assert.ok(result.reviewFields.includes("studentNumber")); assert.deepEqual(result.confidence, {});
  await assert.rejects(readGlmRegions(paper, 3, async () => { throw Object.assign(new Error("abort"), { status: 504 }); }));
});
