import sharp from "sharp";
import { prepareServerPaper } from "./paper-preparation.ts";
import { validQuestionCount } from "./exam.ts";
import { focusNumericCell } from "./document-geometry.ts";

/** A number and individually labelled score cells, without a total to infer from. */
export async function prepareQwenNumericViews(bytes: Uint8Array, questionCount: number) {
  if (!validQuestionCount(questionCount)) throw new Error("Geçersiz soru sayısı.");
  const paper = await prepareServerPaper(bytes, questionCount, true);
  if (!paper.identity || !paper.regions || !paper.scoreCells || paper.scoreCells.length !== questionCount) return;
  const scoreCells = await Promise.all(paper.scoreCells.map(cell => focusNumericCell(cell.color)));
  const number = await focusNumericCell(paper.identity.studentNumber);
  const render = async (fields: string[]) => {
    const width = 1032, layers: { input: Buffer; left: number; top: number }[] = [];
    const label = (text: string, w: number) => Buffer.from(`<svg width="${w}" height="32"><rect width="100%" height="100%" fill="white"/><text x="10" y="23" font-family="Arial" font-size="20">${text}</text></svg>`);
    let top = 16;
    if (fields.includes("studentNumber")) {
      layers.push({ input: label("Student number", 1000), left: 16, top }); top += 32;
      const value = await sharp(Buffer.from(number, "base64")).resize({ width: 1000 }).png().toBuffer({ resolveWithObject: true });
      layers.push({ input: value.data, left: 16, top }); top += value.info.height + 24;
    }
    const questions = fields.filter(field => /^s[1-9]\d*$/.test(field));
    const columns = Math.min(5, questions.length), cellWidth = 200;
    for (const [index, field] of questions.entries()) {
      const q = Number(field.slice(1)) - 1;
      if (q < 0 || q >= questionCount) throw new Error("Geçersiz soru alanı.");
      const left = 16 + index % columns * cellWidth, y = top + Math.floor(index / columns) * 150;
      layers.push({ input: label(field.toUpperCase() + " Puan", 190), left, top: y });
      const value = await sharp(Buffer.from(scoreCells[q], "base64"))
        .resize({ width: 170, height: 100, fit: "inside" }).png().toBuffer({ resolveWithObject: true });
      layers.push({ input: value.data, left: left + 10, top: y + 36 });
    }
    top += questions.length ? Math.ceil(questions.length / columns) * 150 : 0;
    return sharp({ create: { width, height: top + 16, channels: 3, background: "white" } }).composite(layers).png().toBuffer();
  };
  const scores = async () => {
    const columns = Math.ceil(questionCount / 6), rows = Math.ceil(questionCount / columns);
    const cellWidth = Math.min(600, Math.floor(1900 / columns));
    const layers: { input: Buffer; left: number; top: number }[] = [];
    let height = 16;
    for (let i = 0; i < questionCount; i++) {
      const left = 16 + Math.floor(i / rows) * (cellWidth + 16), top = 16 + i % rows * 198;
      layers.push({ input: Buffer.from(`<svg width="${cellWidth}" height="32"><rect width="100%" height="100%" fill="white"/><text x="15" y="24" font-family="Arial" font-size="22">S${i + 1} Puan</text></svg>`), left, top });
      const value = await sharp(Buffer.from(paper.scoreCells![i].color, "base64"))
        .extend({ top: 10, bottom: 10, left: 10, right: 10, background: "white" })
        .resize({ width: cellWidth - 20, height: 150, fit: "inside" }).png().toBuffer({ resolveWithObject: true });
      layers.push({ input: value.data, left: left + 10, top: top + 32 });
      height = Math.max(height, top + 32 + value.info.height + 16);
    }
    return sharp({ create: { width: columns * (cellWidth + 16) + 16, height, channels: 3, background: "white" } }).composite(layers).png().toBuffer();
  };
  const context = async () => {
    let top = 16;
    const layers: { input: Buffer; left: number; top: number }[] = [];
    for (const source of [paper.identity!.fullNameLabelled, paper.identity!.studentNumberLabelled, paper.regions!.course]) {
      const part = await sharp(Buffer.from(source, "base64")).resize({ width: 1000 }).png().toBuffer({ resolveWithObject: true });
      layers.push({ input: part.data, left: 16, top }); top += part.info.height + 16;
    }
    return sharp({ create: { width: 1032, height: top, channels: 3, background: "white" } }).composite(layers).png().toBuffer();
  };
  const labelledNumber = () => sharp(Buffer.from(paper.identity!.studentNumberLabelled, "base64"))
    .resize({ width: 1000 }).png().toBuffer();
  return { render, scores, context, labelledNumber };
}
