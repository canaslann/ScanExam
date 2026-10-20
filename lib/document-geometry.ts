import sharp from "sharp";
import { createRequire } from "node:module";
import { detectPaperLayout, type PaperLayout } from "./paper-regions.ts";

type Point = { x: number; y: number };
type Cv = typeof import("@techstark/opencv-js");
type FormCandidate = { points: Point[]; area: number; ratio: number };
const nodeRequire = createRequire(import.meta.url);
let runtime: Promise<Cv> | undefined;
function openCv() {
  // Keep the native Node loader: bundling Emscripten CJS as ESM removes __dirname.
  return runtime ??= Promise.resolve(nodeRequire("@techstark/opencv-js") as Cv);
}

/** A clipped outer edge may leave every useful cell intact. Propose a frame
 * from measured long rulings; the normal full layout validator must accept it. */
function rulingCandidates(binary: InstanceType<Cv["Mat"]>, width: number, cv: Cv): FormCandidate[] {
  const found = new cv.Mat();
  type Ruling = { left: number; right: number; y: number; slope: number };
  const lines: Ruling[] = [];
  try {
    cv.HoughLinesP(binary, found, 1, Math.PI / 1800, 90, width * .65, 35);
    for (let i = 0; i < found.data32S.length; i += 4) {
      let [x1, y1, x2, y2] = found.data32S.slice(i, i + 4);
      if (x2 < x1) { [x1, x2] = [x2, x1]; [y1, y2] = [y2, y1]; }
      const slope = (y2 - y1) / (x2 - x1);
      if (x1 < width * .15 && x2 > width * .7 && Math.abs(slope) < .15)
        lines.push({ left: x1, right: x2, slope, y: y1 + (width / 2 - x1) * slope });
    }
  } finally { found.delete(); }
  const rows: Ruling[] = [];
  for (const line of lines.sort((a, b) => (b.right - b.left) - (a.right - a.left)))
    if (!rows.some(row => Math.abs(row.y - line.y) < 8)) rows.push(line);
  rows.sort((a, b) => a.y - b.y);
  const candidates: FormCandidate[] = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 4; j < rows.length; j++) {
    const group = rows.slice(i, j + 1), first = group[0], last = group.at(-1)!;
    const left = Math.min(...group.map(line => line.left)), right = Math.max(...group.map(line => line.right));
    const span = right - left, height = last.y - first.y;
    if (height < span * .25 || height > span * .45 || Math.abs(first.slope - last.slope) > .025) continue;
    const at = (line: Ruling, x: number) => line.y + (x - width / 2) * line.slope;
    candidates.push({ points: [{ x: left, y: at(first, left) }, { x: right, y: at(first, right) },
      { x: right, y: at(last, right) }, { x: left, y: at(last, left) }], area: span * height, ratio: height / span });
  }
  return candidates.sort((a, b) => b.area - a.area);
}

/** Locate printed table borders, never text/answers; rectify only validated templates. */
export async function rectifyExamForm(bytes: Uint8Array, questionCount: number): Promise<{
  buffer: Buffer; layout: PaperLayout; width: number; height: number; contourRecovered: boolean;
} | undefined> {
  const cv = await openCv();
  const analysis = await sharp(bytes).resize({ width: 1000, height: 1600, fit: "inside", withoutEnlargement: true }).toColourspace("srgb").ensureAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const src = cv.matFromArray(analysis.info.height, analysis.info.width, cv.CV_8UC4, analysis.data);
  const gray = new cv.Mat(), binary = new cv.Mat(), contours = new cv.MatVector(), hierarchy = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 51, 6);
    cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const candidates: FormCandidate[] = [];
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i), polygon = new cv.Mat();
      try {
        const area = cv.contourArea(contour);
        if (area < src.cols * src.rows * 0.025) continue;
        cv.approxPolyDP(contour, polygon, cv.arcLength(contour, true) * 0.02, true);
        if (polygon.rows !== 4 || !cv.isContourConvex(polygon)) continue;
        const points = Array.from({ length: 4 }, (_, j) => ({ x: polygon.data32S[j * 2], y: polygon.data32S[j * 2 + 1] }))
          .sort((a, b) => a.y - b.y);
        const top = points.slice(0, 2).sort((a, b) => a.x - b.x), bottom = points.slice(2).sort((a, b) => a.x - b.x);
        const ordered = [top[0], top[1], bottom[1], bottom[0]];
        const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
        const width = (distance(ordered[0], ordered[1]) + distance(ordered[3], ordered[2])) / 2;
        const height = (distance(ordered[0], ordered[3]) + distance(ordered[1], ordered[2])) / 2;
        if (width / height > 2 && width / height < 5 && width > src.cols * 0.45)
          candidates.push({ points: ordered, area, ratio: height / width });
      } finally { contour.delete(); polygon.delete(); }
    }
    candidates.sort((a, b) => b.area - a.area);
    // Detect at 1000px, but warp the color source at its retained resolution.
    const color = await sharp(bytes).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const original = cv.matFromArray(color.info.height, color.info.width, cv.CV_8UC4, color.data);
    try {
      const scale = color.info.width / analysis.info.width;
      for (let pass = 0; pass < 2; pass++) {
      // Keep successful closed-form extraction exactly as before. Only a
      // failed pass inspects open/clipped form borders.
      const proposals = pass === 0 ? candidates : rulingCandidates(binary, src.cols, cv);
      for (const candidate of proposals.slice(0, 4)) {
        const from = cv.matFromArray(4, 1, cv.CV_32FC2, candidate.points.flatMap(p => [p.x * scale, p.y * scale]));
        const to = cv.matFromArray(4, 1, cv.CV_32FC2, [50, 40, 1550, 40, 1550, 40 + 1500 * candidate.ratio, 50, 40 + 1500 * candidate.ratio]);
        const transform = cv.getPerspectiveTransform(from, to), result = new cv.Mat();
        try {
          cv.warpPerspective(original, result, transform, new cv.Size(1600, 960), cv.INTER_LINEAR,
            cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
          const buffer = await sharp(Buffer.from(result.data), { raw: { width: 1600, height: 960, channels: 4 } })
            .removeAlpha().png().toBuffer();
          // Contrast assists geometry only. OCR receives the color pixels.
          const grid = await sharp(buffer).resize({ width: 800 }).normalise().raw().toBuffer();
          const linear = detectPaperLayout(grid, 800, 480, 3, undefined, questionCount);
          const contour = linear ? undefined : await contourLayout(buffer, questionCount, cv);
          const layout = linear ?? contour ?? detectPaperLayout(grid, 800, 480, 3, undefined, questionCount, true);
          if (layout) return { buffer, layout, width: 1600, height: 960, contourRecovered: !!contour };
        } finally { from.delete(); to.delete(); transform.delete(); result.delete(); }
      }
      }
    } finally { original.delete(); }
  } finally { src.delete(); gray.delete(); binary.delete(); contours.delete(); hierarchy.delete(); kernel.delete(); }
}

/** Curved sheets may have closed cells even when seven straight rulings fail. */
async function contourLayout(bytes: Buffer, count: number, cv: Cv): Promise<PaperLayout | undefined> {
  const image = await sharp(bytes).resize({ width: 800 }).ensureAlpha().raw().toBuffer();
  const src = cv.matFromArray(480, 800, cv.CV_8UC4, image);
  const gray = new cv.Mat(), mask = new cv.Mat(), contours = new cv.MatVector(), hierarchy = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  type Cell = { x: number; y: number; width: number; height: number; area: number };
  const right = (b: Cell) => b.x + b.width, bottom = (b: Cell) => b.y + b.height;
  const box = (l: number, t: number, r: number, b: number, padding = 2) => ({
    left: Math.max(0, Math.floor(l - padding)), top: Math.max(0, Math.floor(t - padding)),
    width: Math.min(800, Math.ceil(r + padding)) - Math.max(0, Math.floor(l - padding)),
    height: Math.min(480, Math.ceil(b + padding)) - Math.max(0, Math.floor(t - padding)),
  });
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.adaptiveThreshold(gray, mask, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 7);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
    cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const cells: Cell[] = [];
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i), polygon = new cv.Mat();
      try {
        const area = cv.contourArea(contour), b = cv.boundingRect(contour);
        if (area < 180 || b.width < Math.max(8,Math.min(35,400/(count+1))) || b.height < 10) continue;
        cv.approxPolyDP(contour, polygon, cv.arcLength(contour, true) * 0.02, true);
        if (polygon.rows === 4 && cv.isContourConvex(polygon)
          && !cells.some(c => Math.abs(c.x-b.x)<3 && Math.abs(c.y-b.y)<3
            && Math.abs(c.width-b.width)<5 && Math.abs(c.height-b.height)<5)) cells.push({ ...b, area });
      } finally { contour.delete(); polygon.delete(); }
    }
    const main = cells.filter(c => c.width > 640 && c.height > c.width * .2
      && c.height < c.width * .5 && c.x < 100 && c.y < 100).sort((a,b) => b.area-a.area)[0];
    if (!main) return;
    const labels = cells.filter(c => Math.abs((c.x-main.x)/main.width-.475)<.035
      && c.width/main.width>.075 && c.width/main.width<.14
      && c.y>main.y+main.height*.3 && bottom(c)<main.y+main.height*.7).sort((a,b)=>a.y-b.y);
    if (labels.length !== 2 || Math.abs(labels[0].x-labels[1].x)>5
      || Math.abs(right(labels[0])-right(labels[1]))>5 || labels[1].y-bottom(labels[0])>8) return;
    const valueLeft = Math.max(...labels.map(right));
    const values = cells.filter(c => Math.abs(c.x-valueLeft)<6 && c.width/main.width>.22
      && c.width/main.width<.32 && c.y<bottom(labels[1]) && bottom(c)>labels[0].y);
    if (!values.length) return;
    const valueRight = Math.round(values.reduce((sum,c)=>sum+right(c),0)/values.length);
    const courseEdges = cells.filter(c => Math.abs((c.x-main.x)/main.width-.155)<.025
      && c.width>main.width*.12 && c.y>main.y+main.height*.2 && bottom(c)<main.y+main.height*.7);
    if (!courseEdges.length) return;
    const courseLeft = Math.round(courseEdges.reduce((sum,c)=>sum+c.x,0)/courseEdges.length);
    for (const table of cells.filter(c => Math.abs(c.x-main.x)<12 && c.y>bottom(main)-12
      && c.y<bottom(main)+main.width*.2 && c.width>main.width*.25
      && c.width<main.width*.95 && c.height>=30 && c.width/c.height>2).sort((a,b)=>b.area-a.area)) {
      const inside = cells.filter(c => c!==table && c.x>=table.x-2 && right(c)<=right(table)+2
        && c.y>=table.y-2 && bottom(c)<=bottom(table)+2 && c.height>table.height*.18 && c.height<table.height*.48);
      const headers = inside.filter(c => c.y<table.y+table.height*.15).sort((a,b)=>a.x-b.x);
      if (headers.length!==count+1 || Math.abs(headers[0].x-table.x)>5
        || Math.abs(right(headers.at(-1)!)-right(table))>5
        || headers.slice(1).some((c,i)=>Math.abs(c.x-right(headers[i]))>5)) continue;
      const widths = headers.slice(1).map(c=>c.width);
      if (Math.max(...widths)/Math.min(...widths)>1.35) continue;
      const rowLabels = inside.filter(c=>Math.abs(c.x-headers[0].x)<4
        && Math.abs(right(c)-right(headers[0]))<5).sort((a,b)=>a.y-b.y);
      if (rowLabels.length!==3 || rowLabels[1].y-rowLabels[0].y<table.height*.2
        || rowLabels[2].y-rowLabels[1].y<table.height*.2) continue;
      const identityBox = (label: Cell, labelled = false) => {
        const actual = values.find(c=>Math.abs((c.y+c.height/2)-(label.y+label.height/2))<label.height*.6);
        return box(labelled ? label.x : valueLeft, actual?.y ?? label.y-5, valueRight,
          actual ? bottom(actual) : bottom(label), 2);
      };
      const fullName=identityBox(labels[0]), studentNumber=identityBox(labels[1]);
      const fullNameLabelled=identityBox(labels[0],true), studentNumberLabelled=identityBox(labels[1],true);
      return {
        regions: { scores: box(table.x,table.y,right(table),bottom(table),3),
          student: box(main.x,main.y,right(main),studentNumber.top+studentNumber.height),
          course: box(courseLeft,labels[1].y-4,labels[1].x,bottom(labels[1])+2) },
        identity: { fullName, studentNumber, fullNameLabelled, studentNumberLabelled,
          combined: box(fullName.left,fullName.top,studentNumber.left+studentNumber.width,studentNumber.top+studentNumber.height) },
        scoreCells: headers.slice(1).map(h => {
          const actual=inside.find(c=>Math.abs(c.x-h.x)<4 && Math.abs(right(c)-right(h))<5
            && c.y>h.y+h.height*.65 && c.y<rowLabels[2].y-5);
          return actual ? box(actual.x+1,actual.y,right(actual)-1,bottom(actual))
            : box(h.x+1,bottom(h)-2,right(h)-1,bottom(h)+rowLabels[1].height);
        }),
        writtenTotal: box(headers[1].x,rowLabels[2].y,right(table),bottom(table)),
      };
    }
  } finally { src.delete(); gray.delete(); mask.delete(); contours.delete(); hierarchy.delete(); kernel.delete(); }
}
/** Focus a known numeric cell using ink components, excluding ruled borders. */
export async function focusNumericCell(image: string): Promise<string> {
  const cv = await openCv();
  const decoded = await sharp(Buffer.from(image, "base64")).removeAlpha().toColourspace("srgb").toBuffer({ resolveWithObject: true });
  if (decoded.info.width < 80 || decoded.info.height < 40) return image;
  const interior = await sharp(decoded.data).extract({ left: 4, top: 0,
    width: decoded.info.width - 8, height: decoded.info.height }).raw().toBuffer({ resolveWithObject: true });
  const grayBytes = await sharp(interior.data, { raw: { width: interior.info.width, height: interior.info.height, channels: 3 } })
    .greyscale().normalise().raw().toBuffer();
  const gray = cv.matFromArray(interior.info.height, interior.info.width, cv.CV_8UC1, grayBytes);
  const mask = new cv.Mat(), rules = new cv.Mat(), contours = new cv.MatVector(), hierarchy = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(40, Math.round(interior.info.width / 4)), 1));
  try {
    cv.adaptiveThreshold(gray, mask, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 10);
    cv.morphologyEx(mask, rules, cv.MORPH_OPEN, kernel);
    cv.subtract(mask, rules, mask);
    // Faint red marks can have the paper's luminance. Use their chroma to
    // locate ink only; the OCR crop still contains the original color pixels.
    const histogram = new Uint32Array(256);
    for(let i=0;i<gray.rows*gray.cols;i++) {
      const c=interior.data, redness=Math.round(c[i*3]-(c[i*3+1]+c[i*3+2])/2);
      histogram[Math.max(0,Math.min(255,redness+128))]++;
    }
    let median=0, samples=0;
    for(let i=0;i<256;i++){samples+=histogram[i];if(samples>=gray.rows*gray.cols/2){median=i-128;break;}}
    const colorMask=new Uint8Array(gray.rows*gray.cols);
    let colorCount=0;
    for(let i=0;i<gray.rows*gray.cols;i++) {
      const c=interior.data, redness=c[i*3]-(c[i*3+1]+c[i*3+2])/2;
      if(redness>median+8 && c[i*3]>c[i*3+1] && c[i*3]>c[i*3+2]){colorMask[i]=255;colorCount++;}
    }
    if(colorCount>Math.max(20,colorMask.length*.0001)) {
      mask.data.set(colorMask);
      const join=cv.Mat.ones(3,3,cv.CV_8U);
      try { cv.morphologyEx(mask,mask,cv.MORPH_CLOSE,join); } finally { join.delete(); }
    }
    // The crop margin may contain red tails from the Puan row above. Remove
    // pixels above the measured separating rule before finding the Not ink.
    let topRule=-1, strongest=0;
    for(let y=0;y<gray.rows/2;y++) {
      let hits=0;
      for(let x=0;x<gray.cols;x++)if(rules.data[y*gray.cols+x])hits++;
      if(hits>strongest){strongest=hits;topRule=y;}
    }
    if(topRule>=0 && strongest>gray.cols*.1) mask.data.fill(0,0,Math.min(mask.data.length,(topRule+4)*gray.cols));
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let left = gray.cols, top = gray.rows, right = 0, bottom = 0;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      try {
        const box = cv.boundingRect(contour);
        if (box.height < 6 || box.width > gray.cols * 0.4 || box.width > box.height * 5
          || (box.y < 3 && box.height < gray.rows * .2)
          || box.x < 3 || box.x + box.width > gray.cols - 3
          || cv.contourArea(contour) < Math.max(8,gray.rows*.4)) continue;
        left = Math.min(left, box.x); top = Math.min(top, box.y);
        right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height);
      } finally { contour.delete(); }
    }
    if (right <= left || bottom <= top) return image;
    left = Math.max(0, left - 12); top = Math.max(0, top - 12);
    right = Math.min(gray.cols, right + 12); bottom = Math.min(gray.rows, bottom + 12);
    return (await sharp(interior.data, { raw: { width: gray.cols, height: gray.rows, channels: 3 } })
      .extract({ left, top, width: right - left, height: bottom - top })
      .extend({ top: 12, bottom: 12, left: 12, right: 12, background: "white" })
      .jpeg({ quality: 94 }).toBuffer()).toString("base64");
  } finally { gray.delete(); mask.delete(); rules.delete(); contours.delete(); hierarchy.delete(); kernel.delete(); }
}
