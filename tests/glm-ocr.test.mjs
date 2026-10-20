import assert from "node:assert/strict";
import test from "node:test";
import { identityText, parseGlmScores, parseGlmDocument, readGlmRegions } from "../lib/glm-ocr.ts";
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
test("manual capture label typos retain literal scores only under an ordered question header", () => {
  const header = "<tr><td>Soru-PÇ ilişkisi</td><td>(S1)-PÇ2</td><td>(S2)-PÇ1</td><td>(S3)-PÇ3</td><td>(S4)-PÇ2</td><td>(S5)-PÇ4</td></tr>";
  for (const [label, scores, total] of [["Pam:", ["7", "3", "2", "11", "13"], "36"], ["Poan:", ["7", "3", "2", "11", "13"], "36"], ["Punan", ["3", "2", "10", "8", "8"], "31"]]) {
    const row = `<tr><td>${label}</td>${scores.map(value => `<td>${value}</td>`).join("")}</tr>`;
    const raw = `<table>${header}${row}<tr><td>Not:</td><td colspan="5">${total}</td></tr></table>`;
    const result = parseGlmScores(raw, 5);
    assert.deepEqual(result.scores, scores); assert.equal(result.writtenTotal, total);
    assert.deepEqual(result.uncertainFields, []);
    for (const invalid of [
      raw.replace("(S2)-PÇ1", "(S1)-PÇ1"),
      raw.replace(header, ""),
      raw.replace(`${header}${row}`, `${row}${header}`),
      raw.replace(row, `${row}${row}`),
      raw.replace(label, "Plan"),
    ]) assert.deepEqual(parseGlmScores(invalid, 5).scores, Array(5).fill(""));
    assert.deepEqual(parseGlmScores(raw, 4).scores, Array(4).fill(""));
    const markdown = `| Soru-PÇ ilişkisi | (S1)-PÇ2 | (S2)-PÇ1 | (S3)-PÇ3 | (S4)-PÇ2 | (S5)-PÇ4 |\n| --- | --- | --- | --- | --- | --- |\n| ${label} | ${scores.join(" | ")} |\n| Not: | ${total} |`;
    assert.deepEqual(parseGlmScores(markdown, 5).scores, scores);
  }
  assert.deepEqual(parseGlmScores(table(5).replace("Puan:", "Poan:"), 5).scores, Array(5).fill("10"));
});

test("GLM preparation is deduplicated, image-free and waits for a completed native load", async t => {
  const originalFetch = globalThis.fetch, originalModel = process.env.SCANEXAM_MODEL;
  t.after(() => { globalThis.fetch = originalFetch; if (originalModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = originalModel; });
  process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    if (url.endsWith("/api/tags")) return Response.json({ models: [] });
    assert.ok(url.endsWith("/api/generate"));
    const input = JSON.parse(options.body);
    assert.equal(input.images, undefined); assert.equal(input.prompt, undefined); assert.deepEqual(input.options, { num_ctx: 4096, num_thread: 4 });
    assert.equal(input.keep_alive, "30m"); return Response.json({ done: true, done_reason: "load" });
  };
  await Promise.all([warmLocalReader(), warmLocalReader()]);
  assert.equal(calls.filter(url => url.endsWith("/api/generate")).length, 1);
  await warmLocalReader();
  assert.equal(calls.filter(url => url.endsWith("/api/generate")).length, 2, "a later queued paper refreshes the keep-alive without sending image/prompt");
});
test("production GLM uses native local generation with dynamic limits, preserving scores on truncated identity", async t => {
  const originalFetch = globalThis.fetch, originalModel = process.env.SCANEXAM_MODEL;
  t.after(() => { globalThis.fetch = originalFetch; if (originalModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = originalModel; });
  process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
  const paper = { image: "full", regions: { scores: "scores", student: "student", course: "course" },
    identity: { fullNameZoom: "name-zoom", fullNameLabelled: "name-labelled", studentNumberZoom: "number-zoom", studentNumberLabelled: "number-labelled" } };
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/api/tags")) return Response.json({ models: [] });
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
  assert.equal(identityText("Numarar02230201021", "studentNumber"), "02230201021");
  assert.equal(identityText("Öğrenci Numarası: 000 012 345 67", "studentNumber"), "00001234567");
  assert.equal(identityText("Numara 00001234567", "studentNumber"), "00001234567");
  assert.equal(identityText("Adi Soyadi İpek Örnek", "fullName"), "İpek Örnek");
  assert.equal(identityText("Adi Soyad İpek Örnek", "fullName"), "İpek Örnek");
  assert.equal(identityText("Numarar02230L0+064", "studentNumber"), "02230L0+064");
  assert.equal(identityText("02230L0+064", "studentNumber"), "02230L0+064");
  assert.equal(identityText("0123456789".repeat(8), "studentNumber"), "");
});

test("a literal valid isolated identity is preferred to a contaminated labelled read without repairing digits", async () => {
  const result = await readGlmRegions(retryPaper, 3, async image => {
    if (image === "scores") return table(3);
    if (image === "course") return "BILM374-2022-YAPAY ZEKA";
    if (image === "name-zoom") return "İpek Örn4k";
    if (image === "name-labelled") return "Adı Soyadı İpek Örnek";
    if (image === "number-labelled") return "Etiket00001234567";
    return "00001234567";
  });
  assert.equal(result.fullName, "İpek Örnek");
  assert.equal(result.studentNumber, "00001234567");
  assert.deepEqual(result.alternatives.studentNumber, ["Etiket00001234567", "00001234567"]);
  assert.ok(result.reviewFields.includes("studentNumber"));
  assert.ok(result.reviewFields.includes("fullName"));
});

test("isolated numeric handwriting is preferred when two valid numbers disagree, with both retained for review", async () => {
  const result = await readGlmRegions(retryPaper, 3, async image => {
    if (image === "scores") return table(3).replace(">78</td>", ">30</td>");
    if (image === "course") return "BILM374-2022-YAPAY ZEKA";
    if (image.startsWith("name")) return "İpek Örnek";
    if (image === "number-labelled") return "Numarası 00001234584";
    return "00001234554";
  });
  assert.equal(result.studentNumber, "00001234554");
  assert.deepEqual(result.alternatives.studentNumber, ["00001234584", "00001234554"]);
  assert.ok(result.reviewFields.includes("studentNumber"));
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

const retryPaper = {
  image: "full", regions: { scores: "scores", student: "student", course: "course" },
  identity: { fullNameZoom: "name-zoom", fullNameLabelled: "name-labelled", studentNumberZoom: "number-zoom", studentNumberLabelled: "number-labelled" },
  totalImage: "total-color", totalContrastImage: "total-contrast",
};
const readFixture = (count, total, calls, fallback = {}) => async image => {
  calls.push(image);
  if (image === "scores") return table(count).replace(">78</td>", `>${total}</td>`);
  if (image === "course") return "BILM374-2022-YAPAY ZEKA";
  if (image.startsWith("name")) return "İpek Örnek";
  if (image.startsWith("number")) return "00001234567";
  const value = fallback[image];
  if (value instanceof Error) throw value;
  return value || "";
};

test("invalid totals retry their own cell without deriving values from dynamic score sums", async () => {
  for (const count of [1, 3, 7, 12, 30]) {
    const calls = [];
    const result = await readGlmRegions(retryPaper, count, readFixture(count, "7070", calls,
      { "total-color": "70 70", "total-contrast": "70" }));
    assert.equal(result.writtenTotal, "70");
    assert.deepEqual(result.scores, Array(count).fill("10"));
    assert.deepEqual(result.alternatives.writtenTotal, ["7070", "70 70", "70"]);
    assert.ok(result.reviewFields.includes("writtenTotal"), "even a recovered literal value needs confirmation");
    assert.ok(calls.includes("total-color") && calls.includes("total-contrast"));
    assert.deepEqual(result.confidence, {});
  }
});

test("valid totals, including zero and inconsistent sums, are never replaced by arithmetic or retry candidates", async () => {
  for (const total of ["0", "78", "81"]) {
    const calls = [];
    const result = await readGlmRegions(retryPaper, 3, readFixture(3, total, calls,
      { "total-color": "30", "total-contrast": "30" }));
    assert.equal(result.writtenTotal, total);
    assert.ok(calls.includes("total-color"));
    assert.ok(!calls.includes("total-contrast"), "do not filter a valid cell retry");
    assert.deepEqual(result.alternatives.writtenTotal, [total, "30"]);
  }
});

test("a consistent literal total does not trigger arithmetic-based additional reads", async () => {
  const calls = [];
  const result = await readGlmRegions(retryPaper, 3, readFixture(3, "30", calls, { "total-color": "81" }));
  assert.equal(result.writtenTotal, "30");
  assert.ok(!calls.some(image => image.startsWith("total-")));
});

test("total retries retain literal ambiguous marks and completed scores on truncated output", async () => {
  for (const fallback of [
    { "total-color": "70 70", "total-contrast": "7 0" },
    { "total-color": Object.assign(new Error("length"), { status: 502 }), "total-contrast": "" },
  ]) {
    const result = await readGlmRegions(retryPaper, 3, readFixture(3, "7070", [], fallback));
    assert.equal(result.writtenTotal, "", "invalid values stay blank; never merge, deduplicate or prefix-truncate digits");
    assert.ok(result.alternatives.writtenTotal.includes("7070"));
    assert.deepEqual(result.scores, ["10", "10", "10"]);
    assert.ok(result.reviewFields.includes("writtenTotal"));
  }
  const result = await readGlmRegions(retryPaper, 3, readFixture(3, "", [], { "total-color": "Not: 0" }));
  assert.equal(result.writtenTotal, "0");
  await assert.rejects(readGlmRegions(retryPaper, 3, readFixture(3, "", [],
    { "total-color": Object.assign(new Error("cancel"), { status: 504 }) })), /cancel/);
});

test("typed field gates reject digits in names and letters in numeric fields, preserving source alternatives", async () => {
  for (const count of [1, 3, 7, 12, 30]) {
    const result = await readGlmRegions(retryPaper, count, async image => {
      if (image === "scores") return table(count).replace("<td>10</td>", "<td>1O</td>").replace(">78</td>", ">8l</td>");
      if (image === "course") return "BILM374-2022-YAPAY ZEKA";
      if (image.startsWith("name")) return "Nisa K04";
      if (image.startsWith("number")) return "02230L01064";
      return "8l";
    });
    assert.equal(result.fullName, "");
    assert.equal(result.studentNumber, "");
    assert.equal(result.scores[0], "");
    assert.deepEqual(result.scores.slice(1), Array(count - 1).fill("10"));
    assert.equal(result.writtenTotal, "");
    assert.deepEqual(result.alternatives.fullName, ["Nisa K04"]);
    assert.deepEqual(result.alternatives.studentNumber, ["02230L01064"]);
    assert.deepEqual(result.alternatives.s1, ["1O"]);
    assert.deepEqual(result.alternatives.writtenTotal, ["8l"]);
    for (const field of ["fullName", "studentNumber", "s1", "writtenTotal"]) assert.ok(result.reviewFields.includes(field));
  }
});


test("missing GLM weights report installation instructions and allow preparation after repair", async t => {
  const originalFetch = globalThis.fetch, originalModel = process.env.SCANEXAM_MODEL;
  t.after(() => { globalThis.fetch = originalFetch; if (originalModel === undefined) delete process.env.SCANEXAM_MODEL; else process.env.SCANEXAM_MODEL = originalModel; });
  process.env.SCANEXAM_MODEL = "glm-ocr-eot:q8_0";
  let installed = false;
  globalThis.fetch = async url => url.endsWith("/api/tags") ? Response.json({ models: [] })
    : installed ? Response.json({ done: true }) : Response.json({ error: "model not found" }, { status: 404 });
  await assert.rejects(warmLocalReader(), error => error.status === 503 && /reader:setup/.test(error.message) && /Fotoğraf korunuyor/.test(error.message));
  installed = true;
  await warmLocalReader();
});


const documentText = (count = 5) => `INONU UNIVERSITESI
Adı Soyadı
İpek Örnek
Numarası
00001234567
Dersin Kodu ve Adı
BILM374-2022-YAPAY ZEKA
Sınav Kuralları
${Array.from({ length: count }, (_, i) => `(S${i + 1})-PÇ${i % 2 ? 12 : 2}`).join("\n")}
Puan: ${Array(count).fill("10").join(" ")}
Not: 78
SINAV SORULARI
1. Bir sorunun cevabı 42 olarak verilmiştir.`;

test("free document reading extracts labelled fields and exact dynamic score counts without deriving totals", () => {
  for (const count of [1, 3, 5, 7, 12, 30]) {
    const result = parseGlmDocument(documentText(count), count);
    assert.equal(result.fullName, "İpek Örnek");
    assert.equal(result.studentNumber, "00001234567");
    assert.equal(result.scores.length, count);
    assert.ok(result.scores.every(value => value === "10"));
    assert.equal(result.writtenTotal, "78");
    assert.equal(result.pcMap[0], "PÇ2");
    assert.ok(result.reviewFields.includes("s1"));
    assert.equal(result.readingStrategy, "full-table");
  }
  const invalid = parseGlmDocument(documentText().replace("İpek Örnek", "İpek K04").replace("00001234567", "0000L234567").replace("10 10 10 10 10", "10 10 10 10"), 5);
  assert.equal(invalid.fullName, ""); assert.equal(invalid.studentNumber, "");
  assert.deepEqual(invalid.alternatives.fullName, ["İpek K04"]);
  assert.ok(invalid.scores.every(value => value === ""));
  assert.equal(invalid.writtenTotal, "78");
  const ambiguous = parseGlmDocument(documentText() + "\nPuan: 1 2 3 4 5\nNot: 15", 5);
  assert.ok(ambiguous.scores.every(value => value === "")); assert.equal(ambiguous.writtenTotal, "");
});

test("missing geometric cells submit the complete document with a document token budget", async () => {
  const requests = [];
  const out = await readGlmRegions({ image: "old-strip", documentImage: "complete-page" }, 5, async (image, prompt, maxTokens) => {
    requests.push({ image, prompt, maxTokens }); return documentText();
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].image, "complete-page");
  assert.equal(requests[0].prompt, "Text Recognition:");
  assert.ok(requests[0].maxTokens >= 1800);
  assert.equal(out.fullName, "İpek Örnek");
});


test("batch score-row checks accept exact numeric columns only and otherwise retain cell checks", async () => {
  for (const rowText of ["10 10 10 10 10", "10 10 10 10", "10 10 ten 10 10"]) {
    const paper = { image: "full", regions: { scores: "scores", course: "course", student: "student" },
      identity: { fullNameZoom: "name", fullNameLabelled: "name-labelled", studentNumberZoom: "number", studentNumberLabelled: "number-labelled" },
      scoreRowImage: "score-row", scoreCells: Array.from({ length: 5 }, (_, i) => ({ color: `cell-${i}`, padded: `padded-${i}` })) };
    const requests = [];
    const out = await readGlmRegions(paper, 5, async image => {
      requests.push(image);
      if (image === "scores") return table(5).replace(">78</td>", ">50</td>");
      if (image === "score-row") return rowText;
      if (image.startsWith("cell-") || image.startsWith("padded-")) return "10";
      if (image.startsWith("name")) return "İpek Örnek";
      if (image.startsWith("number")) return "00001234567";
      return "BILM374-2022-YAPAY ZEKA";
    });
    assert.deepEqual(out.scores, Array(5).fill("10"));
    assert.equal(requests.filter(image => /^(cell|padded)-/.test(image)).length, rowText === "10 10 10 10 10" ? 0 : 10);
  }
});


test("row agreement does not suppress cell checks when the independent written total is missing or inconsistent", async () => {
  for (const total of ["49", ""]) {
    let cellReads = 0;
    const p = { image: "full", regions: { scores: "scores", course: "course", student: "student" },
      identity: { fullNameZoom: "name", fullNameLabelled: "name-labelled", studentNumberZoom: "number", studentNumberLabelled: "number-labelled" },
      scoreRowImage: "score-row", scoreCells: Array.from({ length: 5 }, (_, i) => ({ color: `cell-${i}`, padded: `padded-${i}` })) };
    const out = await readGlmRegions(p, 5, async image => {
      if (image === "scores") return table(5).replace(">78</td>", `>${total}</td>`);
      if (image === "score-row") return "10 10 10 10 10";
      if (/^(cell|padded)-/.test(image)) { cellReads++; return "10"; }
      if (image.startsWith("name")) return "İpek Örnek";
      if (image.startsWith("number")) return "00001234567";
      return "BILM374-2022-YAPAY ZEKA";
    });
    assert.equal(cellReads, 10); assert.equal(out.writtenTotal, total);
    assert.deepEqual(out.scores, Array(5).fill("10"));
  }
});

test('measured cells retain Pun row values despite misread printed question indices',()=>{const raw=table(5).replace('Puan:','Pun:').replace(/\(S\d+\)/g,'(S0)');assert.deepEqual(parseGlmScores(raw,5).scores,Array(5).fill(''));const measured=parseGlmScores(raw,5,true);assert.deepEqual(measured.scores,Array(5).fill('10'));assert.ok(measured.uncertainFields.includes('pcMap'));assert.deepEqual(parseGlmScores(raw,4,true).scores,Array(4).fill(''));});

test('only identical repeated multi-digit Not literals are recovered without arithmetic',()=>{for(const [literal,expected] of [['70 70','70'],['70 78',''],['7 7',''],['70 70 70','70']]){const out=parseGlmDocument(table(3).replace('>78<',`>${literal}<`),3);assert.equal(out.writtenTotal,expected);assert.deepEqual(out.alternatives.writtenTotal,[literal]);assert.ok(out.reviewFields.includes('writtenTotal'));}});
