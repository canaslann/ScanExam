const text = (value) => typeof value === "string" ? value.normalize("NFC").trim().replace(/\s+/g, " ") : "";
const folded = (value) => text(value).toLocaleLowerCase("tr-TR");
const number = (value) => /^\d{1,3}(?:[.,]\d{1,2})?$/.test(text(value)) ? Number(text(value).replace(",", ".")) : null;

export function compareFields(expected, actual = {}, excluded = []) {
  const fields = ["fullName", "studentNumber", "writtenTotal", "courseCode", "courseName",
    ...Array.from({ length: 5 }, (_, i) => `s${i + 1}`), ...Array.from({ length: 5 }, (_, i) => `pc${i + 1}`)];
  const get = (object, key) => /^s\d$/.test(key) ? object.scores?.[Number(key[1]) - 1]
    : /^pc\d$/.test(key) ? object.pcMap?.[Number(key[2]) - 1] : object[key];
  const normalize = (value, key) => {
    if (key === "studentNumber") return text(value).replace(/\s/g, ""); // Leading zeros remain meaningful.
    if (key === "courseCode") return text(value).toLocaleUpperCase("tr-TR").replaceAll("İ", "I").replace(/\s/g, "");
    if (/^s\d$/.test(key) || key === "writtenTotal") return number(value) === null ? `invalid:${text(value)}` : String(number(value));
    return folded(value);
  };
  return fields.filter((key) => !excluded.includes(key)).map((key) => ({
    field: key, expected: get(expected, key) ?? "", actual: get(actual, key) ?? "",
    correct: normalize(get(expected, key), key) === normalize(get(actual, key), key),
    category: /^pc\d$/.test(key) || key.startsWith("course") ? "printed"
      : /^s\d$/.test(key) ? "scores" : key === "writtenTotal" ? "total" : "identity",
  }));
}

export function plainLines(raw) {
  return raw.replace(/<nl>/gi, "\n").replace(/<(?:fcel|ecel|lcel|ucel|xcel)>/gi, " | ")
    .replace(/<\/tr\s*>/gi, "\n").replace(/<\/t[dh]\s*>/gi, " | ")
    .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:p|div)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function parseNativeStudent(raw) {
  const lines = plainLines(raw).map((line) => line.replace(/^\s*\|\s*|\s*\|\s*$/g, ""));
  const result = { fullName: "", studentNumber: "" };
  for (const line of lines) {
    const withoutLabel = line.replace(/^(?:Ad[ıi]\s*Soyad[ıi]|Numaras[ıi]|Öğrenci\s*Numaras[ıi])\s*[:|]?\s*/iu, "");
    const candidate = withoutLabel.replace(/[\s|]/g, "");
    if (/^\d{5,20}$/.test(candidate)) result.studentNumber = candidate;
    else if (!result.fullName && /^[\p{L}\s'’-]+$/u.test(withoutLabel) && withoutLabel.includes(" ")) result.fullName = text(withoutLabel);
  }
  return result;
}

export function parseNativeCourse(raw) {
  const joined = plainLines(raw).join(" ").replace(/\|/g, " ");
  const match = joined.match(/([A-ZİÇĞÖŞÜ]{2,10}\s*\d{2,6}(?:\s*-\s*\d{2,4})?)\s*[-:]?\s*(.+)/iu);
  return { courseCode: match ? match[1].replace(/\s/g, "") : "", courseName: match ? text(match[2]) : "" };
}

export function parseNativeScores(raw) {
  const lines = plainLines(raw);
  const scores = Array(5).fill("");
  const pcMap = Array(5).fill("");
  const header = raw.replace(/<[^>]+>/g, " ");
  for (const match of header.matchAll(/\(?\s*S([1-5])\s*\)?\s*[-–]?\s*P\s*[ÇC]\s*([1-5])/giu)) pcMap[Number(match[1]) - 1] = `PÇ${match[2]}`;
  let writtenTotal = "";
  for (const line of lines) {
    if (/\bS[1-5]\b|P[ÇC][1-5]|^-+|^\|?[\s:|-]+\|?$/iu.test(line)) continue;
    const isTotal = /^(?:\|\s*)?Not\s*[:|]/iu.test(line);
    const clean = line.replace(/^(?:\|\s*)?(?:Puan|Not)\s*[:|]?\s*/iu, "").replace(/^\|\s*|\s*\|$/g, "");
    const cells = clean.includes("|") ? clean.split("|").map(text) : clean.split(/\s+/).filter(Boolean);
    if (isTotal) {
      // The cell immediately after Not is the total. Never choose by arithmetic,
      // swap to another cell, or combine separate cells/erased old marks.
      writtenTotal = cells[0] || "";
    } else if (cells.length === 5 && cells.every((value) => value === "" || number(value) !== null)) {
      cells.forEach((value, i) => { scores[i] = value; });
    } else if (cells.length === 1 && number(cells[0]) !== null && scores.every(Boolean)) writtenTotal = cells[0];
  }
  return { scores, writtenTotal, pcMap };
}

export function parseStructured(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(cleaned);
  if (!value || typeof value !== "object" || !Array.isArray(value.scores) || value.scores.length !== 5) throw new Error("Invalid five-score JSON output");
  return value;
}

export function summarize(records) {
  const categories = {};
  for (const row of records) {
    for (const field of row.fields) {
      categories[field.category] ??= { correct: 0, total: 0 };
      categories[field.category].total++;
      if (field.correct) categories[field.category].correct++;
    }
  }
  const critical = Object.entries(categories).filter(([key]) => key !== "printed")
    .reduce((sum, [, value]) => ({ correct: sum.correct + value.correct, total: sum.total + value.total }), { correct: 0, total: 0 });
  const times = records.filter((row) => !row.error && !row.cold).map((row) => row.elapsedMs).sort((a, b) => a - b);
  return { categories, critical, perfectPapers: records.filter((row) => !row.error && row.fields.every((f) => f.correct)).length,
    completed: records.filter((row) => !row.error).length, attempts: records.length,
    within120s: records.filter((row) => !row.error && row.elapsedMs <= 120000).length,
    medianWarmMs: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.ceil((times.length - 1) / 2)]) / 2 : null,
    minWarmMs: times[0] ?? null, maxWarmMs: times.at(-1) ?? null,
  };
}
