import assert from "node:assert/strict";
import test from "node:test";
import {
  compactPaperHeight,
  detectPaperRegions,
  detectPaperLayout,
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
  scoreRows = [226, 250, 274, 298],
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
    [...scoreRows.slice(0, 3), ...(lastRow ? [scoreRows[3]] : [])].forEach((y) => h(y, scoreRight));
    [
      20,
      ...Array.from({ length: questionCount + 1 }, (_, i) =>
        Math.round(96 + ((scoreRight - 96) * i) / questionCount),
      ),
    ].forEach((x) => v(x, scoreRows[0], scoreRows[2]));
    v(20, scoreRows[2], scoreRows[3]);
    v(96, scoreRows[2], scoreRows[3]);
    v(scoreRight, scoreRows[2], scoreRows[3]);
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
    const layout = detectPaperLayout(data, width, height, 1, undefined, count);
    assert.equal(layout.scoreCells.length, count);
    for (let i = 0; i < count; i++) {
      const cell = layout.scoreCells[i];
      assert.ok(cell.width > 0 && cell.top > 240 && cell.top + cell.height < 285);
      if (i) assert.ok(cell.left > layout.scoreCells[i - 1].left);
    }
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

test("small ruling localization differences do not reject a complete table, but unequal/missing rows stay rejected", () => {
  for (const scoreRows of [[226, 251, 277, 295], [226, 250, 274, 291]]) {
    const { data, width, height } = fixture({ scoreRows });
    const layout = detectPaperLayout(data, width, height, 1);
    assert.ok(layout, `complete table with ${scoreRows} should tolerate line-localization noise`);
    assert.equal(layout.scoreCells.length, 5);
    assert.ok(layout.writtenTotal.top > 265 && layout.writtenTotal.top + layout.writtenTotal.height >= scoreRows[3]);
    assert.equal(detectPaperLayout(data, width, height, 1, undefined, 4), null);
  }
  const { data, width, height } = fixture({ scoreRows: [226, 240, 290, 306] });
  assert.equal(detectPaperLayout(data, width, height, 1), null);
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


test("portrait document preparation preserves the complete page when fixed form geometry is absent", async () => {
  const { default: sharp } = await import("sharp");
  const { prepareServerPaper } = await import("../lib/paper-preparation.ts");
  // The red marker is below the old width*0.6 crop, where a free photo's table may be.
  const source = await sharp({ create: { width: 900, height: 1600, channels: 3, background: "white" } })
    .composite([{ input: await sharp({ create: { width: 400, height: 100, channels: 3, background: "red" } }).png().toBuffer(), left: 200, top: 1200 }]).png().toBuffer();
  const paper = await prepareServerPaper(source, 5);
  assert.ok(paper.documentImage);
  const { data, info } = await sharp(Buffer.from(paper.image, "base64")).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.height, 1280); assert.equal(info.width, 720);
  const offset = (1000 * info.width + 300) * info.channels;
  assert.ok(data[offset] > 200 && data[offset + 1] < 50, "lower-page content must reach the OCR input");
});


test("free-photo rectification finds a displaced tilted table and preserves its measured cells", async () => {
  const { default: sharp } = await import("sharp");
  const { prepareServerPaper } = await import("../lib/paper-preparation.ts");
  const { data, width, height } = fixture();
  // Complete the outer printed rectangle, then put it on a photographed page.
  for (const x of [20, 620]) for (let y = 15; y <= 220; y++) {
    data[y * width + x] = 40; data[y * width + x + 1] = 40;
  }
  const photographed = await sharp(data, { raw: { width, height, channels: 1 } })
    .extend({ top: 240, bottom: 600, left: 70, right: 80, background: "white" })
    .rotate(3, { background: "white" }).png().toBuffer();
  const paper = await prepareServerPaper(photographed, 5);
  assert.ok(paper.regions, "full-page photo should use measured regions, not expensive full-document OCR");
  assert.equal(paper.scoreCells.length, 5);
  assert.ok(paper.identity.fullNameZoom);
  assert.ok(paper.scoreRowImage);
  const bounded = await sharp(Buffer.from(paper.nativeImages.get(paper.identity.fullNameZoom), "base64")).metadata();
  assert.ok(bounded.width <= 960 && bounded.height <= 256, "identity OCR preserves finer letter and digit details within bounded crops");
  const wrongCount = await prepareServerPaper(photographed, 4);
  assert.equal(wrongCount.regions, undefined, "rectification must not invent a different column count");
});

test("one spurious vertical pen stroke is ignored only when every genuine score divider exists", () => {
  const { data, width, height } = fixture();
  for (let y = 226; y <= 274; y++) data[y * width + 250] = 40;
  const layout = detectPaperLayout(data, width, height, 1);
  assert.ok(layout); assert.equal(layout.scoreCells.length, 5);
  assert.equal(detectPaperLayout(data, width, height, 1, undefined, 4), null);
});


test("numeric-cell focusing keeps literal zero ink while removing blank margins and ruled borders", async () => {
  const { default: sharp } = await import("sharp");
  const { focusNumericCell } = await import("../lib/document-geometry.ts");
  const source = await sharp(Buffer.from('<svg width="1000" height="120"><rect width="1000" height="120" fill="white"/><path d="M0 20H1000M0 100H1000" stroke="gray" stroke-width="2"/><ellipse cx="100" cy="60" rx="15" ry="22" fill="none" stroke="red" stroke-width="4"/></svg>')).jpeg().toBuffer();
  const focused = Buffer.from(await focusNumericCell(source.toString("base64")), "base64");
  const { data, info } = await sharp(focused).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.ok(info.width < 200, "empty cell margins should not become model image tokens");
  assert.ok(data.some((value, i) => i % 3 === 0 && value > 150 && data[i + 1] < 100), "zero ink must survive focusing");
});
test('a bowed closed form recovers measured cells instead of full-document OCR', async () => {
  const sharp=(await import('sharp')).default;
  const {prepareServerPaper}=await import('../lib/paper-preparation.ts');
  const {data,width,height}=fixture();
  for(let y=15;y<=220;y++)for(const x of [20,21,620,621])data[y*width+x]=40;
  const curved=new Uint8Array(width*height).fill(225);
  for(let x=0;x<width;x++){const shift=Math.round(10*Math.pow(2*x/width-1,2));for(let y=0;y<height-shift;y++)curved[(y+shift)*width+x]=data[y*width+x];}
  assert.equal(detectPaperLayout(curved,width,height,1,undefined,5),null);
  const image=await sharp(curved,{raw:{width,height,channels:1}}).png().toBuffer();
  const p=await prepareServerPaper(image,5,true);
  assert.ok(p.regions);assert.equal(p.scoreCells.length,5);assert.equal(p.documentImage,undefined);
});

test('gallery photos with a clipped outer right edge recover only a complete measured question grid', async () => {
  const sharp = (await import('sharp')).default;
  const { prepareServerPaper } = await import('../lib/paper-preparation.ts');
  const { data, width, height } = fixture();
  for (let y=15;y<=220;y++) for (const x of [20,21,620,621]) data[y*width+x]=40;
  const photo = await sharp(data,{raw:{width,height,channels:1}})
    .extract({left:0,top:0,width:600,height})
    .extend({top:240,bottom:600,left:70,right:80,background:'white'})
    .rotate(-2,{background:'white'}).png().toBuffer();
  const paper=await prepareServerPaper(photo,5,true);
  assert.ok(paper.regions,'an open outer edge must not force whole-page OCR');
  assert.equal(paper.scoreCells.length,5);assert.ok(paper.identity.studentNumber);
  const wrongCount=await prepareServerPaper(photo,4,true);
  assert.equal(wrongCount.regions,undefined,'the new candidate still requires every configured divider');
});

test('adaptive geometry finds measured grids under varying shadows without relaxing column validation',()=>{
  for(const count of [3,5,7]) {
    const {data,width,height}=fixture({questionCount:count});
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const light=Math.min(1,.25+(x+y*.6)/650);
      data[y*width+x]=Math.round(data[y*width+x]*light);
    }
    assert.equal(detectPaperLayout(data,width,height,1,undefined,count),null);
    const layout=detectPaperLayout(data,width,height,1,undefined,count,true);
    assert.ok(layout);assert.equal(layout.scoreCells.length,count);
    assert.equal(detectPaperLayout(data,width,height,1,undefined,count+1,true),null);
  }
});
