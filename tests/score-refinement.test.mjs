import assert from "node:assert/strict";
import test from "node:test";
import { refineConfusableScores, refineExcessScores } from "../lib/score-refinement.ts";
import { readLocalPaper } from "../lib/local-reader.ts";

const cells = count => Array.from({ length: count }, (_, i) => ({ color: `cell-${i}`, padded: `padded-${i}` }));
const original = ["20", "20", "74", "18", "9"];

test("confusable digits are checked with literal evidence even below 100 and with a matching written sum", async () => {
  const first = ["13", "1", "7", "8", "9"];
  const literal = ["17", "2", "3", "8", "9"];
  const requests = [];
  const result = await refineConfusableScores(first, cells(5), async image => {
    requests.push(image); return literal[Number(image.split("-")[1])];
  }, async image => literal[Number(image.split("-")[1])]);
  assert.deepEqual(result.scores, literal);
  assert.deepEqual(first, ["13", "1", "7", "8", "9"]);
  assert.deepEqual(result.reviewFields, ["s1", "s2", "s3"]);
  assert.deepEqual(result.alternatives.s1, ["13", "17"]);
  assert.equal(requests.length, 6, "8 and 9 do not need this digit check");
});

test("digit corrections require independent visual support; unavailable and conflicting checks preserve originals", async () => {
  for (const verification of [undefined, async () => "", async () => "13", async () => "8"]) {
    const result = await refineConfusableScores(["13"], cells(1), async () => "17", verification);
    assert.deepEqual(result.scores, ["13"]);
    assert.deepEqual(result.alternatives.s1, [...new Set(["13", "17", ...(verification ? [await verification()].filter(Boolean) : [])])]);
    assert.deepEqual(result.reviewFields, ["s1"]);
  }
  const agreed = await refineConfusableScores(["2"], cells(1), async () => "2", async () => assert.fail("agreed crops need no extra check"));
  assert.deepEqual(agreed.reviewFields, []);
  const conflicting = await refineConfusableScores(["13"], cells(1), async image => image.startsWith("cell") ? "17" : "13", async () => "17");
  assert.deepEqual(conflicting.scores, ["17"]);
  const secondModel = await refineConfusableScores(["17"], cells(1), async image => image.startsWith("cell") ? "n" : "17", async () => "12");
  assert.deepEqual(secondModel.scores, ["12"], "two independent-model crop views can resolve a native 2/7 confusion");
  let extraCalls = 0;
  const disputed = await refineConfusableScores(["17"], cells(1), async () => "17.", async () => ++extraCalls === 1 ? "12" : "17");
  assert.deepEqual(disputed.scores, ["17"]);
  const formatting = await refineConfusableScores(["13"], cells(1), async () => "13.", async () => "13");
  assert.deepEqual(formatting.reviewFields, []);
  const impossible = await refineConfusableScores(["13", "80"], cells(2), async () => "73", async () => "73");
  assert.deepEqual(impossible.scores, ["13", "80"]);
  await assert.rejects(refineConfusableScores(["2"], cells(1), async () => { throw new Error("cancelled"); }), /cancelled/);
});

test("digit checks stay bounded on large forms and skip invalid or missing geometry", async () => {
  let calls = 0;
  const result = await refineConfusableScores(Array(30).fill("1"), cells(30), async () => { calls++; return "1"; });
  assert.equal(calls, 12);
  assert.equal(result.scores.length, 30);
  await refineConfusableScores(["1"], undefined, async () => assert.fail("no geometry"));
  await refineConfusableScores(["", "1/2"], cells(2), async () => assert.fail("invalid score"));
});

test("an impossible total triggers only relevant cells and selects supported literal 14, never a calculated remainder", async () => {
  const requests = [], verify = [];
  const result = await refineExcessScores(original, cells(5), async image => {
    requests.push(image); return image.startsWith("cell") ? "14" : "74";
  }, async image => { verify.push(image); return "14"; });
  assert.deepEqual(requests, ["cell-2", "padded-2"]);
  assert.deepEqual(verify, ["padded-2"]);
  assert.deepEqual(result.scores, ["20", "20", "14", "18", "9"]);
  assert.deepEqual(result.alternatives.s3, ["74", "14"]);
  assert.deepEqual(original, ["20", "20", "74", "18", "9"]);
});

test("ordinary and exactly-100 totals, blanks and mismatched geometry never trigger speculative cell changes", async () => {
  for (const values of [["100"], ["50", "50"], ["33,33", "33,33", "33,34"], ["", "74"], ["20", "20", "14", "18", "9"]]) {
    const result = await refineExcessScores(values, cells(values.length), async () => assert.fail("unexpected retry"));
    assert.deepEqual(result.scores, values);
  }
  const result = await refineExcessScores(original, cells(3), async () => assert.fail("invalid geometry"));
  assert.deepEqual(result.scores, original);
});

test("unsupported, invalid, or still excessive rereadings keep originals with alternatives; cancellation propagates", async () => {
  for (const extra of ["", "41", "101", "1/4", "1 4"]) {
    const result = await refineExcessScores(original, cells(5), async image => image.startsWith("cell") ? "14" : "74", async () => extra);
    assert.deepEqual(result.scores, original);
    assert.ok(result.reviewFields.includes("s3"));
    assert.ok(result.alternatives.s3.includes("14"));
  }
  const same = await refineExcessScores(original, cells(5), async () => "74");
  assert.deepEqual(same.scores, original, "agreement cannot make 141 acceptable");
  await assert.rejects(refineExcessScores(original, cells(5), async () => { throw new Error("cancelled"); }), /cancelled/);
});

test("unequal scores and dynamic question counts use visual evidence without assuming 20 points per question", async () => {
  const result = await refineExcessScores(["66", "66"], cells(2), async () => "40");
  assert.deepEqual(result.scores, ["40", "40"]);
  for (const count of [3, 7, 12, 30]) {
    const values = ["90", ...Array(count - 1).fill("4")];
    const result = await refineExcessScores(values, cells(count), async image => image.endsWith("-0") ? "14" : "4");
    assert.equal(result.scores.length, count);
    assert.equal(result.scores[0], count === 3 ? "90" : count === 30 ? "90" : "14", "normal sums stay intact and unresolved excess never creates answers");
  }
});

test("production uses the installed checker only for a disagreeing excessive score and sends no expected digits", async t => {
  const originalFetch = globalThis.fetch, originalModel = process.env.SCANEXAM_MODEL;
  t.after(() => { globalThis.fetch = originalFetch; if (originalModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = originalModel; });
  process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
  const paper = { image: "full", regions: { scores: "scores", student: "student", course: "course" },
    identity: { fullNameZoom: "name", fullNameLabelled: "name", studentNumberZoom: "number", studentNumberLabelled: "number" }, scoreCells: cells(5) };
  for (const fail of [false, true]) {
    let scoreChecks = 0;
    globalThis.fetch = async (url, options) => {
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3.5:4b" }] });
      const body = JSON.parse(options.body);
      if (url.endsWith("/api/chat")) {
        const message = body.messages[0];
        if (!message.images) return Response.json({ done: true, message: { content: '{"needsVisualCheck":false}' } });
        scoreChecks++;
        assert.deepEqual(message.images, ["padded-2"]);
        assert.ok(!/14|74|141|81/.test(message.content), "no expected answers or arithmetic in the visual prompt");
        assert.equal(body.options.num_gpu, 8);
        if (fail) throw new Error("optional offline");
        return Response.json({ done: true, message: { content: '{"value":"14"}' } });
      }
      const image = body.images[0];
      const response = image === "scores" ? "|Soru-PÇ İlişkisi|(S1)-PÇ2|(S2)-PÇ1|(S3)-PÇ3|(S4)-PÇ2|(S5)-PÇ4|\n|Puan:|20|20|74|18|9|\n|Not:|87|"
        : image === "cell-2" ? "14" : image === "padded-2" ? "74" : image === "course" ? "DERS101 ÖRNEK DERS" : image === "name" ? "Örnek Öğrenci" : "00001234567";
      return Response.json({ done: true, response });
    };
    const result = await readLocalPaper("full", "double", new AbortController().signal, undefined, undefined, 5, paper);
    assert.equal(scoreChecks, 2);
    assert.deepEqual(result.scores, fail ? original : ["20", "20", "14", "18", "9"]);
    assert.equal(result.writtenTotal, "87", "scores cannot invent the handwritten total");
    assert.equal(result.studentNumber, "00001234567");
  }
});


test("a complete independent row check skips matching cell requests but disagreements retain visual verification", async () => {
  const first = ["13", "1", "7", "8", "9"];
  const agreed = await refineConfusableScores(first, cells(5), async () => assert.fail("matching row needs no per-cell request"), undefined, [...first]);
  assert.deepEqual(agreed.scores, first);
  const calls = [];
  const result = await refineConfusableScores(first, cells(5), async image => { calls.push(image); return "17"; }, async () => "17", ["17", "1", "7", "8", "9"]);
  assert.deepEqual(result.scores, ["17", "1", "7", "8", "9"]);
  assert.deepEqual(calls, ["cell-0", "padded-0"]);
  const unsupported = await refineConfusableScores(first, cells(5), async () => "17", undefined, ["17", "1", "7", "8", "9"]);
  assert.deepEqual(unsupported.scores, first, "row disagreement alone must not rewrite a grade");
});
