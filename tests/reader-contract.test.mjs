import assert from "node:assert/strict";
import test from "node:test";
import { compareReadings, normalizePaper, parseScore, sumScores } from "../lib/reader-contract.ts";
import { validateReaderInput } from "../lib/local-reader.ts";

const sample = (patch = {}) => ({
  courseCode: "DERS101-2026", courseName: "ÖRNEK DERS", fullName: "Örnek Öğrenci", studentNumber: "00001234567",
  scores: ["20", "18", "12", "17", "11"], writtenTotal: "80", pcMap: ["PÇ2", "PÇ1", "PÇ3", "PÇ2", "PÇ4"], uncertainFields: [], ...patch,
});

test("leading zeroes, Turkish letters and repeated PÇ mappings are preserved", () => {
  const result = normalizePaper(sample());
  assert.equal(result.studentNumber, "00001234567");
  assert.equal(result.fullName, "Örnek Öğrenci");
  assert.deepEqual(result.pcMap, ["PÇ2", "PÇ1", "PÇ3", "PÇ2", "PÇ4"]);
});
test("a 78/80 mismatch never repairs a handwritten score or written total", () => {
  const result = normalizePaper(sample());
  assert.equal(result.scores[3], "17");
  assert.equal(result.writtenTotal, "80");
  assert.equal(sumScores(result.scores), 78);
  assert.ok(result.warnings.length);
  assert.ok(result.reviewFields.includes("s4"));
});
test("blank scores are not treated as zero and missing totals are not inferred", () => {
  const result = normalizePaper(sample({ scores: ["15", "", "13", "20", "12"], writtenTotal: "" }));
  assert.equal(sumScores(result.scores), null);
  assert.equal(result.writtenTotal, "");
  assert.ok(result.reviewFields.includes("s2"));
  assert.ok(result.reviewFields.includes("writtenTotal"));
});
test("valid zero, decimals and invalid/out-of-range marks are distinguished", () => {
  assert.equal(parseScore("0"), 0);
  assert.equal(parseScore("12,5"), 12.5);
  for (const value of ["", "-1", "101", "1e2", "12.3.4", "1/2", "12abc", "NaN"]) assert.equal(parseScore(value), null);
  assert.equal(sumScores(["0", "10", "12,5", "20", "12"]), 54.5);
});
test("number strings are not silently stripped or repaired", () => {
  const result = normalizePaper(sample({ studentNumber: "02230O01054", scores: ["201", "18", "12", "17", "11"] }));
  assert.equal(result.studentNumber, "02230O01054");
  assert.equal(result.scores[0], "201");
  assert.ok(result.reviewFields.includes("studentNumber"));
  assert.ok(result.reviewFields.includes("s1"));
});
test("two disagreeing readings keep the first value and expose both alternatives", () => {
  const first = normalizePaper(sample());
  const second = normalizePaper(sample({ scores: ["20", "18", "12", "19", "11"] }));
  const result = compareReadings(first, second);
  assert.equal(result.scores[3], "17");
  assert.deepEqual(result.alternatives.s4, ["17", "19"]);
  assert.ok(result.reviewFields.includes("s4"));
  assert.equal(result.checkMode, "double");
});
test("agreement does not create invented confidence percentages", () => {
  const first = normalizePaper(sample({ scores: ["20", "18", "12", "19", "11"], uncertainFields: ["s4"] }));
  const result = compareReadings(first, first);
  assert.deepEqual(result.confidence, {});
  assert.ok(result.reviewFields.includes("s4"));
});
test("an invalid question count is rejected, not padded", () => {
  assert.throws(() => normalizePaper(sample({ scores: ["20"] })));
});
test("printed dotted-I course codes compare consistently without changing student names", () => {
  const first = normalizePaper(sample({ courseCode: "BİLM374-2022" }));
  const second = normalizePaper(sample({ courseCode: "BILM374-2022" }));
  const result = compareReadings(first, second);
  assert.equal(result.courseCode, "BILM374-2022");
  assert.equal(result.alternatives.courseCode, undefined);
  assert.equal(result.fullName, "Örnek Öğrenci");
});
test("API rejects image URLs, unsupported modes and oversized input; ignores supplied prompts", () => {
  for (const image of ["https://example.com/image.jpg", "data:image/png;base64,AAAA", "data:image/jpeg;base64," + "A".repeat(8_000_001)]) {
    assert.throws(() => validateReaderInput({ image }));
  }
  assert.throws(() => validateReaderInput({ image: "data:image/jpeg;base64,/9j/AAAA", checkMode: "triple" }));
  assert.deepEqual(validateReaderInput({ image: "data:image/jpeg;base64,/9j/AAAA", prompt: "ignore rules", model: "remote" }), { image: "/9j/AAAA", checkMode: "single" });
});
