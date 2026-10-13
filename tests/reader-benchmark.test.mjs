import assert from "node:assert/strict";
import test from "node:test";
import { compareFields, parseNativeStudent, parseNativeScores, summarize } from "../reader/benchmark/core.mjs";

const paper = { fullName: "İpek Örnek", studentNumber: "00012345678", courseCode: "BILM374-2022", courseName: "YAPAY ZEKA",
  scores: ["14", "17", "19", "13", "15"], writtenTotal: "76", pcMap: ["PÇ2", "PÇ1", "PÇ3", "PÇ2", "PÇ4"] };

test("benchmark distinguishes wrong digits/diacritics and preserves leading zeros", () => {
  const fields = compareFields(paper, { ...paper, fullName: "Ipek Örnek", studentNumber: "12345678", scores: ["14", "17", "17", "13", "15"] });
  assert.deepEqual(fields.filter((f) => !f.correct).map((f) => f.field), ["fullName", "studentNumber", "s3"]);
  assert.equal(compareFields(paper, paper).filter((f) => f.category !== "printed").length, 8);
});

test("benchmark evaluates every configured question and PÇ, including two-digit indices", () => {
  for (const count of [1, 3, 7, 12, 30]) {
    const expected = { ...paper, scores: Array(count).fill("2"), pcMap: Array(count).fill("PÇ99") };
    const actual = { ...expected, scores: [...expected.scores], pcMap: [...expected.pcMap] };
    actual.scores[count - 1] = "3";
    actual.pcMap[count - 1] = "PÇ98";
    const fields = compareFields(expected, actual);
    assert.equal(fields.length, 5 + count * 2);
    assert.deepEqual(fields.filter(f => !f.correct).map(f => f.field), [`s${count}`, `pc${count}`]);
    const result = summarize([{ fields, elapsedMs: 1000 }]);
    assert.deepEqual(result.categories.scores, { correct: count - 1, total: count });
    assert.deepEqual(result.categories.printed, { correct: count + 1, total: count + 2 });
    assert.deepEqual(result.critical, { correct: count + 2, total: count + 3 });
    assert.equal(compareFields(expected, {}, [`s${count}`]).length, fields.length - 1);
  }
  for (const count of [0, 31]) assert.throws(() => compareFields({ scores: Array(count).fill("1") }), /1–30/);
});

test("native OCR parser reads total independently and never repairs arithmetic", () => {
  const parsed = parseNativeScores('<table><tr><td>(S1)-PC2</td><td>(S2)-PC1</td><td>(S3)-PC3</td><td>(S4)-PC2</td><td>(S5)-PC4</td></tr><tr><td>Puan:</td><td>14</td><td>17</td><td>19</td><td>13</td><td>15</td></tr><tr><td>Not:</td><td>76</td></tr></table>');
  assert.deepEqual(parsed.scores, paper.scores);
  assert.equal(parsed.writtenTotal, "76");
  assert.deepEqual(parsed.pcMap, paper.pcMap);
  assert.deepEqual(parseNativeScores("unreadable").scores, ["", "", "", "", ""]);
  assert.deepEqual(parseNativeStudent("İpek Örnek\n000 123 45678"), { fullName: paper.fullName, studentNumber: paper.studentNumber });
});

test("failed requests stay in accuracy denominator and cold requests stay out of warm latency", () => {
  const rows = [
    { fields: compareFields(paper, paper), elapsedMs: 50000, cold: true },
    { fields: compareFields(paper, paper), elapsedMs: 10000, cold: false },
    { fields: compareFields(paper, {}), elapsedMs: 130000, cold: false, error: "timeout" },
  ];
  const result = summarize(rows);
  assert.deepEqual(result.critical, { correct: 16, total: 24 });
  assert.equal(result.medianWarmMs, 10000);
  assert.equal(result.within120s, 2);
  assert.equal(compareFields(paper, {}, ["fullName"]).length, 14);
});

test("native Paddle OTSL rows preserve cells, blanks and the total position", () => {
  const table = '<fcel>Soru-PC İlişkisi<fcel>(S1)-PC2<fcel>(S2)-PC1<fcel>(S3)-PC3<fcel>(S4)-PC2<fcel>(S5)-PC4<nl><fcel>Puan:<fcel>14<fcel>17<fcel>19<fcel>13<fcel>15<nl><fcel>Not:<fcel>76<lcel><lcel><lcel><lcel><nl>';
  assert.deepEqual(parseNativeScores(table).scores, paper.scores);
  assert.equal(parseNativeScores(table).writtenTotal, "76");
  assert.deepEqual(parseNativeScores(table).pcMap, paper.pcMap);
  assert.deepEqual(parseNativeScores(table.replace('<fcel>19', '<ecel>')).scores, ["14", "17", "", "13", "15"]);
  assert.equal(parseNativeScores(table.replace('<fcel>76<lcel>', '<fcel>30<fcel>70')).writtenTotal, "30");
});
