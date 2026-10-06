import assert from "node:assert/strict";
import test from "node:test";
import {
  newSession,
  emptyRow,
  editCell,
  mergeReading,
  cellState,
  confirmRow,
  exportIssues,
  sessionExam,
  restoreSession,
  migrateLegacy,
} from "../lib/scan-session.ts";
import {
  paperContract,
  normalizePaper,
  compareReadings,
  regionContract,
  mergeRegionReadings,
} from "../lib/reader-contract.ts";
import { createExamWorkbook, pcTotals } from "../lib/exam.ts";
import { validateReaderInput } from "../lib/local-reader.ts";
import { CAPTURE_STABLE_MS, CaptureFrameBuffer, CaptureGate } from "../lib/capture-gate.ts";

const raw = (count = 3, patch = {}) => ({
  fullName: "İpek Örnek",
  studentNumber: "00001234567",
  scores: Array(count).fill("10"),
  writtenTotal: String(count * 10),
  courseCode: "DERS101",
  courseName: "ÖRNEK DERS",
  pcMap: Array(count).fill("PÇ12"),
  uncertainFields: [],
  ...patch,
});
const sessionWith = (count = 3, patch = {}) => {
  const data = raw(count, patch);
  const row = mergeReading(
    emptyRow(count, "row-1", "single"),
    normalizePaper(data, count),
  );
  return {
    ...newSession(),
    courseCode: data.courseCode,
    courseName: data.courseName,
    pcMap: data.pcMap,
    rows: [row],
  };
};
test("dynamic reader schema and region merge handle 1, 3, 7, 12 and 30 questions, PÇ12 and repeats", () => {
  for (const count of [1, 3, 7, 12, 30]) {
    const contract = paperContract(count);
    assert.equal(contract.schema.properties.scores.minItems, count);
    assert.ok(
      contract.schema.properties.uncertainFields.items.enum.includes(
        `s${count}`,
      ),
    );
    assert.equal(
      regionContract("scores", count).schema.properties.pcMap.maxItems,
      count,
    );
    const data = raw(count, {
      writtenTotal: "90",
      uncertainFields: [`s${count}`],
    });
    const result = normalizePaper(data, count);
    assert.equal(result.scores.length, count);
    assert.equal(result.pcMap.at(-1), "PÇ12");
    assert.ok(result.reviewFields.includes(`s${count}`));
    const merged = mergeRegionReadings(
      { student: data, course: data, scores: data },
      count,
    );
    assert.deepEqual(merged.scores, result.scores);
    const different = normalizePaper(
      {
        ...data,
        scores: data.scores.map((v, i) => (i === count - 1 ? "11" : v)),
      },
      count,
    );
    assert.deepEqual(
      compareReadings(result, different).alternatives[`s${count}`],
      ["10", "11"],
    );
    assert.equal(
      validateReaderInput({
        image: "data:image/jpeg;base64,/9j/AAAA",
        questionCount: count,
      }).questionCount,
      count,
    );
  }
  for (const count of [0, -1, 31, 2.5, "3"]) {
    assert.throws(() => paperContract(count));
    assert.throws(() =>
      validateReaderInput({
        image: "data:image/jpeg;base64,/9j/AAAA",
        questionCount: count,
      }),
    );
  }
  assert.throws(() => normalizePaper(raw(3), 7));
});
test("background results do not overwrite edits made during reading", () => {
  const edited = editCell(emptyRow(3, "row-1", "single"), "s2", "15");
  const merged = mergeReading(edited, normalizePaper(raw(), 3));
  assert.deepEqual(merged.draft.scores, ["10", "15", "10"]);
  assert.ok(merged.confirmed.includes("s2"));
  assert.equal(merged.status, "done");
});
test("empty values remain empty, identities and ambiguous readings stay yellow", () => {
  const session = sessionWith(3, {
      scores: ["10", "", "10"],
      uncertainFields: ["s3"],
    }),
    row = session.rows[0];
  assert.equal(cellState(session, row, "studentNumber").color, "yellow");
  assert.equal(cellState(session, row, "s1").color, "green");
  assert.equal(cellState(session, row, "s2").color, "yellow");
  assert.equal(cellState(session, row, "s3").color, "yellow");
  assert.throws(() => confirmRow(session, row));
  assert.throws(() => sessionExam(session));
});
test("approval acknowledges a literal total mismatch but any later score edit invalidates it", () => {
  const session = sessionWith(3, { writtenTotal: "78" }),
    row = session.rows[0];
  assert.equal(cellState(session, row, "s1").color, "green");
  assert.equal(cellState(session, row, "writtenTotal").color, "yellow");
  assert.equal(exportIssues(session).length, 1);
  session.rows[0] = confirmRow(session, row);
  assert.deepEqual(exportIssues(session), []);
  assert.equal(sessionExam(session).results[0].writtenTotal, 78);
  assert.equal(sessionExam(session).results[0].calculatedTotal, 30);
  session.rows[0] = editCell(session.rows[0], "s1", "20");
  assert.equal(
    cellState(session, session.rows[0], "writtenTotal").color,
    "yellow",
  );
});
test("total mismatch does not spread model uncertainty to all scores or allow an unchecked export", () => {
  const session = sessionWith(3, { writtenTotal: "78", uncertainFields: ["s2"] });
  const row = session.rows[0];
  assert.equal(cellState(session, row, "s1").color, "green");
  assert.equal(cellState(session, row, "s2").color, "yellow");
  assert.equal(cellState(session, row, "s3").color, "green");
  assert.equal(cellState(session, row, "writtenTotal").color, "yellow");
  assert.throws(() => sessionExam(session));
  // Even confirmed identity/score cells cannot bypass the literal-total check.
  row.confirmed = ["studentNumber", "fullName", "s1", "s2", "s3", "writtenTotal"];
  assert.throws(() => sessionExam(session));
});
test("both duplicate student numbers are flagged, not silently merged/dropped", () => {
  const session = sessionWith();
  session.rows[0] = confirmRow(session, session.rows[0]);
  session.rows.push({ ...session.rows[0], id: "row-2" });
  assert.equal(session.rows.length, 2);
  for (const row of session.rows)
    assert.equal(cellState(session, row, "studentNumber").color, "yellow");
  assert.throws(() => sessionExam(session));
});
test("metadata changes invalidate mismatch approvals, without changing OCR results", () => {
  const session = sessionWith();
  session.rows[0] = confirmRow(session, session.rows[0]);
  session.pcMap = ["PÇ1", "PÇ2", "PÇ3"];
  assert.equal(exportIssues(session).length, 1);
  assert.deepEqual(session.rows[0].draft.pcMap, ["PÇ12", "PÇ12", "PÇ12"]);
});
test("interrupted reading resumes queued and malformed storage never becomes blank/new data", () => {
  const session = sessionWith();
  session.rows[0].status = "reading";
  assert.equal(restoreSession(session).rows[0].status, "queued");
  for (const data of [
    null,
    {},
    { ...session, rows: [session.rows[0], session.rows[0]] },
    { ...session, pcMap: ["PÇ0"] },
  ])
    assert.throws(() => restoreSession(data));
  const migrated = migrateLegacy({
    courseCode: "DERS101",
    courseName: "Örnek",
    pcMap: ["PÇ12"],
    results: [
      {
        id: "old",
        createdAt: "2026-10-01",
        fullName: "İpek Örnek",
        studentNumber: "00001234567",
        scores: [0],
        writtenTotal: 0,
        needsReview: false,
      },
    ],
  });
  assert.equal(migrated.rows[0].draft.scores[0], "0");
  assert.equal(migrated.rows[0].draft.studentNumber, "00001234567");
});
test("Excel uses dynamic headers, unique sorted PÇ totals, leading zero strings and wide autofilter", () => {
  for (const count of [3, 7, 30]) {
    const session = sessionWith(count, {
      scores: Array(count).fill("1"),
      writtenTotal: String(count),
    });
    session.rows[0] = confirmRow(session, session.rows[0]);
    const exam = sessionExam(session),
      sheet = createExamWorkbook(exam).Sheets["Sonuçlar"];
    assert.equal(sheet.A6.t, "s");
    assert.equal(sheet.A6.v, "00001234567");
    assert.equal(sheet.C5.v, "S1 (PÇ12)");
    assert.deepEqual(pcTotals(exam.results[0].scores, exam.pcMap), {
      PÇ12: count,
    });
    assert.equal(sheet["!cols"].length, count + 4);
    if (count === 30) assert.equal(sheet["!autofilter"].ref, "A5:AH6");
  }
});
test("capture gate requires stable frames, never repeats a held paper, and rearms after removal", () => {
  const gate = new CaptureGate(),
    box = { left: 20, top: 200, width: 400, height: 80 };
  assert.equal(gate.sample(box, 0, true), "steady");
  assert.equal(gate.sample(box, 500, true), "steady");
  assert.equal(gate.sample(box, 1000, true), "captured");
  assert.equal(gate.sample(box, 2000, true), "remove");
  assert.equal(gate.sample(null, 2500, false), "remove");
  assert.equal(gate.sample(null, 3200, false), "searching");
  assert.equal(gate.sample(box, 3500, true), "steady");
  assert.equal(gate.sample(box, 4000, true), "steady");
  assert.equal(gate.sample(box, 4500, true), "captured");
  gate.reset();
  assert.equal(gate.sample(box, 5500, false), "searching");
  assert.equal(gate.sample(box, 6000, true), "steady");
  assert.equal(gate.sample({ ...box, top: 220 }, 7000, true), "steady");
});
test("fast capture still needs three acceptable frames and a half-second stable window", () => {
  const box = { left: 20, top: 200, width: 400, height: 80 };
  const gate = new CaptureGate();
  assert.equal(gate.sample(box, 0, true), "steady");
  assert.equal(gate.sample(box, 180, true), "steady");
  assert.equal(gate.sample(box, 360, true), "steady");
  assert.equal(gate.sample(box, CAPTURE_STABLE_MS, true), "captured");
  assert.equal(gate.sample(box, 800, true), "remove");
  gate.reset();
  assert.equal(gate.sample(box, 900, true), "steady");
  const generation = gate.generation;
  assert.equal(gate.sample(box, 1100, false), "searching");
  assert.equal(gate.sample(box, 1300, true), "steady");
  assert.notEqual(gate.generation, generation);
  assert.equal(gate.sample(box, 1500, true), "steady");
  assert.equal(gate.sample({ ...box, top: 220 }, 1800, true), "steady");
});
test("capture uses the sharpest validated frame and never leaks an old paper across stable runs", () => {
  const frames = new CaptureFrameBuffer();
  assert.equal(frames.consider(1, "first", 3), "first");
  assert.equal(frames.consider(1, "sharp", 6), "sharp");
  assert.equal(frames.consider(1, "last", 4), "sharp");
  assert.equal(frames.consider(2, "new-paper", 3), "new-paper");
  frames.reset();
  assert.equal(frames.consider(2, "after-blur", 2.5), "after-blur");
});
