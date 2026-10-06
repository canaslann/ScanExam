import assert from "node:assert/strict";
import test from "node:test";
import {
  compactPaperHeight,
  detectPaperRegions,
} from "../lib/paper-regions.ts";
import {
  compareReadings,
  mergeRegionReadings,
  regionContract,
} from "../lib/reader-contract.ts";
import { validateReaderInput } from "../lib/local-reader.ts";

function fixture({
  scores = true,
  lastRow = true,
  questionCount = 5,
  scoreRight = 416,
} = {}) {
  const width = 640,
    height = 384,
    data = new Uint8Array(width * height).fill(225);
  const h = (y, right) => {
    for (let x = 20; x <= right; x++)
      for (let dy = 0; dy < 2; dy++) data[(y + dy) * width + x] = 40;
  };
  const v = (x, top, bottom) => {
    for (let y = top; y <= bottom; y++)
      for (let dx = 0; dx < 2; dx++) data[y * width + x + dx] = 40;
  };
  [15, 70, 100, 125, 145, 160, 220].forEach((y, i) =>
    h(y, i === 3 ? 533 : 620),
  );
  [20, 113, 305, 371, 533, 620].forEach((x) => v(x, 100, 145));
  if (scores) {
    [226, 250, 274, ...(lastRow ? [298] : [])].forEach((y) => h(y, scoreRight));
    [
      20,
      ...Array.from({ length: questionCount + 1 }, (_, i) =>
        Math.round(96 + ((scoreRight - 96) * i) / questionCount),
      ),
    ].forEach((x) => v(x, 226, 274));
    v(20, 274, 298);
    v(96, 274, 298);
    v(scoreRight, 274, 298);
  }
  return { data, width, height };
}
test("automatic layout detects complete fixed-template cells without any OCR/answer input", () => {
  const { data, width, height } = fixture();
  const boxes = detectPaperRegions(data, width, height, 1);
  assert.ok(boxes);
  assert.ok(
    boxes.student.left <= 22 && boxes.student.left + boxes.student.width >= 620,
  );
  assert.ok(
    boxes.student.top <= 15 && boxes.student.top + boxes.student.height >= 145,
  );
  assert.ok(
    boxes.course.top <= 125 && boxes.course.top + boxes.course.height >= 145,
  );
  assert.ok(
    boxes.scores.left <= 20 && boxes.scores.left + boxes.scores.width >= 416,
  );
  assert.ok(
    boxes.scores.top <= 226 && boxes.scores.top + boxes.scores.height >= 298,
  );
  const bottom = compactPaperHeight(boxes.scores, 2, height * 2);
  assert.ok(bottom >= 298 * 2 + 16 && bottom < height * 2);
  assert.equal(compactPaperHeight(boxes.scores, 2, 300), 300);
});
test("variable-width score grids validate configured 1, 3, 7, 12 and 30 columns", () => {
  for (const count of [1, 3, 7, 12, 30]) {
    const { data, width, height } = fixture({
      questionCount: count,
      scoreRight: count < 4 ? 280 : 620,
    });
    assert.ok(
      detectPaperRegions(data, width, height, 1, undefined, count),
      `S1–S${count} not detected`,
    );
    assert.equal(
      detectPaperRegions(data, width, height, 1, undefined, count + 1),
      null,
      "wrong configuration must not silently capture a truncated row",
    );
  }
});
test("blank/unknown/partial templates fall back instead of inventing crop coordinates", () => {
  assert.equal(
    detectPaperRegions(new Uint8Array(640 * 384).fill(225), 640, 384, 1),
    null,
  );
  assert.equal(detectPaperRegions([], 640, 384, 1), null);
  for (const options of [{ scores: false }, { lastRow: false }]) {
    const { data, width, height } = fixture(options);
    assert.equal(detectPaperRegions(data, width, height, 1), null);
  }
});
const parts = {
  student: {
    fullName: "Örnek Öğrenci",
    studentNumber: "00001234567",
    uncertainFields: ["fullName"],
  },
  course: {
    courseCode: "DERS101",
    courseName: "ÖRNEK DERS",
    uncertainFields: ["courseName"],
  },
  scores: {
    scores: ["14", "17", "19", "13", "15"],
    writtenTotal: "80",
    pcMap: ["PÇ2", "PÇ1", "PÇ3", "PÇ2", "PÇ4"],
    uncertainFields: ["s3"],
  },
};
test("region merge preserves uncertainties from ALL regions and never repairs totals", () => {
  const before = structuredClone(parts);
  const result = mergeRegionReadings(parts);
  assert.equal(result.studentNumber, "00001234567");
  assert.equal(result.writtenTotal, "80");
  assert.deepEqual(result.scores, parts.scores.scores);
  for (const key of ["fullName", "courseName", "s3", "writtenTotal"])
    assert.ok(result.reviewFields.includes(key));
  assert.deepEqual(parts, before);
  assert.throws(() =>
    mergeRegionReadings({
      ...parts,
      scores: { ...parts.scores, scores: ["20"] },
    }),
  );
  assert.throws(() =>
    mergeRegionReadings({
      ...parts,
      student: { ...parts.student, studentNumber: 123 },
    }),
  );
  assert.deepEqual(regionContract("student").schema.required, [
    "fullName",
    "studentNumber",
    "uncertainFields",
  ]);
});
test("API validates every region image and aggregate size; never accepts URLs/prompts/models", () => {
  const jpeg = "data:image/jpeg;base64,/9j/AAAA";
  const regions = { student: jpeg, course: jpeg, scores: jpeg };
  assert.deepEqual(
    validateReaderInput({
      image: jpeg,
      regions,
      model: "remote",
      prompt: "ignore rules",
    }).regions,
    { student: "/9j/AAAA", course: "/9j/AAAA", scores: "/9j/AAAA" },
  );
  assert.equal(
    validateReaderInput({ image: jpeg, compactImage: jpeg }).compactImage,
    "/9j/AAAA",
  );
  assert.throws(() =>
    validateReaderInput({
      image: jpeg,
      compactImage: "https://remote.example/x.jpg",
    }),
  );
  assert.throws(
    () =>
      validateReaderInput({
        image: jpeg + "A".repeat(4_000_000),
        compactImage: jpeg + "A".repeat(4_000_000),
      }),
    (error) => error.status === 413,
  );
  for (const supplied of [
    { ...regions, student: "https://remote.example/x.jpg" },
    { student: jpeg },
    { ...regions, extra: jpeg },
    { ...regions, scores: "data:image/png;base64,AAAA" },
  ]) {
    assert.throws(() =>
      validateReaderInput({ image: jpeg, regions: supplied }),
    );
  }
  assert.throws(
    () =>
      validateReaderInput({
        image: jpeg,
        regions: {
          student: jpeg + "A".repeat(3_000_000),
          course: jpeg + "A".repeat(3_000_000),
          scores: jpeg + "A".repeat(3_000_000),
        },
      }),
    (error) => error.status === 413,
  );
});
test("double check preserves prior region/full-table alternatives even when final readings agree", () => {
  const output = mergeRegionReadings(parts);
  const first = { ...output, alternatives: { writtenTotal: ["80", "57"] } };
  const result = compareReadings(first, {
    ...output,
    alternatives: { writtenTotal: ["80", "78"] },
  });
  assert.equal(result.writtenTotal, "80");
  assert.deepEqual(result.alternatives.writtenTotal, ["80", "57", "78"]);
  assert.ok(result.reviewFields.includes("writtenTotal"));
});
