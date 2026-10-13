import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
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
  metadataWarnings,
  approvalIssue,
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
  assert.equal(sessionExam(session).results[0].scores[1], null);
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

test("141 remains a review warning and blocks approval, while optional Excel preserves the actual marks", () => {
  const session = sessionWith(5, { scores: ["20", "20", "74", "18", "9"], writtenTotal: "87" });
  const row = session.rows[0];
  row.confirmed = ["fullName", "studentNumber", "s1", "s2", "s3", "s4", "s5", "writtenTotal"];
  row.totalApproval = JSON.stringify([row.draft.scores, row.draft.writtenTotal]);
  for (const key of ["s1", "s3", "writtenTotal"]) assert.equal(cellState(session, row, key).color, "yellow");
  assert.throws(() => confirmRow(session, row), /100/);
  assert.equal(sessionExam(session).results[0].calculatedTotal, 141);
  const sheet = createExamWorkbook(sessionExam(session)).Sheets["Sonuçlar"];
  assert.equal(sheet.E6.v, 74);
  assert.equal(sheet.I6.v, 87);
  session.rows[0] = editCell(row, "s3", "14");
  session.rows[0] = confirmRow(session, session.rows[0]);
  assert.equal(sessionExam(session).results[0].calculatedTotal, 81);
});
test("total mismatch remains a warning without spreading uncertainty to all scores or blocking export", () => {
  const session = sessionWith(3, { writtenTotal: "78", uncertainFields: ["s2"] });
  const row = session.rows[0];
  assert.equal(cellState(session, row, "s1").color, "green");
  assert.equal(cellState(session, row, "s2").color, "yellow");
  assert.equal(cellState(session, row, "s3").color, "green");
  assert.equal(cellState(session, row, "writtenTotal").color, "yellow");
  assert.equal(sessionExam(session).results[0].writtenTotal, 78);
  // Export does not create approvals or replace the literal total.
  row.confirmed = ["studentNumber", "fullName", "s1", "s2", "s3", "writtenTotal"];
  assert.equal(sessionExam(session).results[0].calculatedTotal, 30);
});
test("both duplicate student numbers are flagged and preserved in optional exports", () => {
  const session = sessionWith();
  session.rows[0] = confirmRow(session, session.rows[0]);
  session.rows.push({ ...session.rows[0], id: "row-2" });
  assert.equal(session.rows.length, 2);
  for (const row of session.rows)
    assert.equal(cellState(session, row, "studentNumber").color, "yellow");
  assert.equal(sessionExam(session).results.length, 2);
});
test("metadata changes invalidate mismatch approvals, without changing OCR results", () => {
  const session = sessionWith();
  session.rows[0] = confirmRow(session, session.rows[0]);
  session.pcMap = ["PÇ1", "PÇ2", "PÇ3"];
  assert.equal(exportIssues(session).length, 1);
  assert.deepEqual(session.rows[0].draft.pcMap, ["PÇ12", "PÇ12", "PÇ12"]);
});

test("metadata review lists each missing or uncertain field once using Turkish labels", () => {
  const session = sessionWith(3, { courseCode: "", courseName: "", uncertainFields: ["courseCode", "courseName", "pcMap"] });
  const warnings = metadataWarnings(session, session.rows[0]);
  assert.equal(warnings.filter(w => w.startsWith("Ders kodu:")).length, 1);
  assert.equal(warnings.filter(w => w.startsWith("Ders adı:")).length, 1);
  assert.equal(warnings.filter(w => w.startsWith("PÇ eşleşmesi:")).length, 1);
  assert.ok(warnings.every(w => !/courseCode|courseName|pcMap/.test(w)));
  const noPhoto = { ...session.rows[0], hasPhoto: false };
  assert.deepEqual(metadataWarnings(session, noPhoto), []);
});

test("reviewing an errored row displays its actual error instead of saying it is still reading", () => {
  const session = sessionWith();
  const row = { ...session.rows[0], status: "error", error: "Üst formun tamamı algılanamadı." };
  assert.equal(approvalIssue(session, row), row.error);
  assert.match(approvalIssue(session, { ...row, error: undefined }), /Okuma başarısız/);
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

test("Excel can download an empty or unfinished snapshot without approvals, inventing zeros, or changing the session", () => {
  assert.equal(createExamWorkbook(sessionExam(newSession())).Sheets["Sonuçlar"].B3.v, 0);
  const session = sessionWith(3, { scores: ["0", "", "1/4"], writtenTotal: "", uncertainFields: ["s3"] });
  const unfinished = emptyRow(3, "row-2", "single");
  unfinished.status = "reading";
  const failed = emptyRow(3, "row-3", "single");
  failed.status = "error";
  session.rows.push(unfinished, failed);
  const before = structuredClone(session);
  const exam = sessionExam(session);
  assert.equal(exam.results.length, 3);
  assert.deepEqual(exam.results[0].scores, [0, null, "1/4"]);
  assert.equal(exam.results[0].writtenTotal, null);
  assert.equal(exam.results[0].calculatedTotal, null);
  const workbook = createExamWorkbook(exam);
  const roundtrip = XLSX.read(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
  const sheet = roundtrip.Sheets["Sonuçlar"];
  assert.equal(sheet.A6.t, "s");
  assert.equal(sheet.A6.v, "00001234567");
  assert.equal(sheet.C6.v, 0);
  assert.equal(sheet.D6, undefined);
  assert.equal(sheet.E6.v, "1/4");
  assert.equal(sheet.F6, undefined, "partial PÇ sum is not silently treated as zero");
  assert.equal(sheet.G6, undefined);
  assert.equal(sheet.C9.v, 0, "explicit zero participates in the average");
  assert.equal(sheet.D9, undefined, "missing readings are excluded from averages");
  assert.deepEqual(session, before, "download never creates approvals or changes stored values");
});

test("unfinished rows do not dilute known score averages, and a zero PÇ subtotal survives export", () => {
  const session = sessionWith(3, { scores: ["0", "10", "20"], writtenTotal: "30", pcMap: ["PÇ1", "PÇ2", "PÇ2"] });
  session.rows.push(emptyRow(3, "pending", "single"));
  const sheet = createExamWorkbook(sessionExam(session)).Sheets["Sonuçlar"];
  assert.equal(sheet.F6.v, 0);
  assert.equal(sheet.G6.v, 30);
  assert.equal(sheet.D8.v, 10);
  assert.equal(sheet.H8.v, 30);
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
