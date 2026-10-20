import sharp from "sharp";
import { rectifyExamForm, focusNumericCell } from "./document-geometry.ts";
import { detectPaperLayout, compactPaperHeight, REGION_KEYS, type PaperRegions } from "./paper-regions.ts";

export type IdentityImages = Record<"fullName" | "studentNumber" | "combined" | "fullNameZoom" | "studentNumberZoom" | "fullNamePadded" | "studentNumberPadded" | "fullNameLabelled" | "studentNumberLabelled", string>;

export type PreparedPaper = {
  image: string;
  regions?: PaperRegions;
  compactImage?: string;
  identity?: IdentityImages;
  totalImage?: string;
  totalContrastImage?: string;
  documentImage?: string;
  allowDocument?: boolean;
  scoreRowImage?: string;
  nativeImages?: Map<string, string>;
  fastScoresImage?: string;
  identityImage?: string;
  identityReaderImage?: string;
  identityTextImage?: string;
  scoreTableRead?: boolean;
  scoreTextImage?: string;
  numericCheckImage?: string;
  preparationStartedAt?: number;
  scoreCells?: { color: string; padded: string }[];
};

/** Fixed form geometry supplies identity cells; question columns remain dynamic. */
export async function prepareServerPaper(bytes: Uint8Array, questionCount: number, fast = false, allowDocument = true): Promise<PreparedPaper> {
  const preparationStartedAt=Date.now();
  const oriented = await sharp(bytes, { limitInputPixels: 24_000_000 })
    .rotate().resize({ width: 1600, withoutEnlargement: true }).removeAlpha()
    .png().toBuffer({ resolveWithObject: true });
  if (oriented.info.width < 300 || oriented.info.height < 150)
    throw new Error("Görüntü çok küçük; üst formu daha yakından tarayın.");
  let width = oriented.info.width;
  let height = Math.min(oriented.info.height, Math.round(width * 0.6));
  let buffer: Buffer = await sharp(oriented.data).extract({ left: 0, top: 0, width, height }).jpeg({ quality: 94 }).toBuffer();
  let image = buffer.toString("base64");
  const analysis = await sharp(oriented.data).extract({ left: 0, top: 0, width, height })
    .resize({ width: Math.min(800, width) }).raw().toBuffer({ resolveWithObject: true });
  let analysisWidth = analysis.info.width;
  let scoreTableRead = false;
  let layout = detectPaperLayout(analysis.data, analysis.info.width, analysis.info.height, analysis.info.channels, undefined, questionCount);
  if (!layout) {
    const recovered = await rectifyExamForm(oriented.data, questionCount);
    if (recovered) {
      buffer = recovered.buffer; layout = recovered.layout;
      scoreTableRead = recovered.contourRecovered;
      width = recovered.width; height = recovered.height; analysisWidth = 800;
      image = buffer.toString("base64");
    }
  }
  if (!layout) {
    if (!allowDocument) {
      // A camera capture is already the upper form. Never expand it to a full
      // document read or include the exam questions in recognition.
      const tableImage=(await sharp(buffer).resize({width:800,withoutEnlargement:true}).jpeg({quality:94}).toBuffer()).toString("base64");
      return {image:tableImage,compactImage:tableImage,allowDocument:false,preparationStartedAt};
    }
    // Keep all of the page. The old upper-strip crop silently removed tables
    // on portrait/offset photos before the model ever received them.
    const documentImage = (await sharp(oriented.data)
      .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 94 }).toBuffer()).toString("base64");
    return { image: documentImage, documentImage, allowDocument:true, preparationStartedAt };
  }
  const scale = width / analysisWidth;
  const crop = async (box: { left: number; top: number; width: number; height: number }, zoom = 1) => {
    const left = Math.round(box.left * scale), top = Math.round(box.top * scale);
    return (await sharp(buffer).extract({ left, top,
      width: Math.min(width - left, Math.round(box.width * scale)),
      height: Math.min(height - top, Math.round(box.height * scale)),
    }).resize({ width: Math.round(box.width * scale * zoom) }).jpeg({ quality: 94 }).toBuffer()).toString("base64");
  };
  const regions = {} as PaperRegions;
  for (const key of REGION_KEYS) regions[key] = await crop(layout.regions[key]);
  const identity = {} as NonNullable<PreparedPaper["identity"]>;
  for (const key of ["fullName", "studentNumber", "combined", "fullNameLabelled", "studentNumberLabelled"] as const) identity[key] = await crop(layout.identity[key]);
  identity.fullNameZoom = fast ? identity.fullName : await crop(layout.identity.fullName, 2);
  identity.studentNumberZoom = fast ? identity.studentNumber : await crop(layout.identity.studentNumber, 2);
  for (const key of ["fullName", "studentNumber"] as const)
    identity[`${key}Padded`] = fast ? identity[`${key}Zoom`] : (await sharp(Buffer.from(identity[`${key}Zoom`], "base64"))
      .extend({ top: 24, bottom: 24, left: 24, right: 24, background: "white" }).jpeg({ quality: 94 }).toBuffer()).toString("base64");
  const totalSource = await crop(layout.writtenTotal, 2);
  const totalImage = fast ? await focusNumericCell(totalSource) : totalSource;
  // An additional OCR view only. The color source remains available and is
  // preferred; thresholding may remove faint/color strokes and is never a
  // replacement for a valid original reading.
  const totalContrastImage = fast
    ? (await sharp(Buffer.from(totalImage,"base64")).modulate({saturation:2}).linear(1.6,-90).png().toBuffer()).toString("base64")
    : (await sharp(Buffer.from(totalImage, "base64")).normalise().threshold(140).png().toBuffer()).toString("base64");
  // Cell detail supports excess-total and confusable-digit checks while the
  // complete table supplies the primary transcription.
  const scoreCells = await Promise.all(layout.scoreCells.map(async box => {
    const color = await crop(box, fast ? 1 : 2);
    const padded = fast ? color : (await sharp(Buffer.from(color, "base64"))
      .extend({ top: 20, bottom: 20, left: 20, right: 20, background: "white" })
      .jpeg({ quality: 94 }).toBuffer()).toString("base64");
    return { color, padded };
  }));
  const firstScore = layout.scoreCells[0], lastScore = layout.scoreCells.at(-1)!;
  const rowTop = Math.min(...layout.scoreCells.map(box => box.top));
  const rowBottom = Math.max(...layout.scoreCells.map(box => box.top + box.height));
  const scoreRowImage = await crop({ left: firstScore.left, top: rowTop,
    width: lastScore.left + lastScore.width - firstScore.left, height: rowBottom - rowTop }, fast ? 1 : 2);
  const compactImage = (await sharp(buffer).extract({ left: 0, top: 0, width,
    height: compactPaperHeight(layout.regions.scores, scale, height),
  }).jpeg({ quality: 94 }).toBuffer()).toString("base64");
  const stack = async (sources: string[], targetWidth: number, partWidths?: number[]) => {
    let top = 8;
    const layers = [];
    for (const [index,source] of sources.entries()) {
      const partWidth = partWidths?.[index] ?? targetWidth;
      const part = await sharp(Buffer.from(source, "base64")).resize({ width: partWidth })
        .png().toBuffer({ resolveWithObject: true });
      layers.push({ input: part.data, left: 8 + Math.floor((targetWidth-partWidth)/2), top });
      top += part.info.height + 8;
    }
    return (await sharp({ create: { width: targetWidth + 16, height: top, channels: 3, background: "white" } })
      .composite(layers).jpeg({ quality: 95 }).toBuffer()).toString("base64");
  };
  const scoreWidth = Math.max(800, questionCount * 45);
  const courseBox = layout.regions.course;
  const courseLabelled = await crop({ left: layout.regions.student.left, top: courseBox.top,
    width: courseBox.left + courseBox.width - layout.regions.student.left, height: courseBox.height });
  const totalLabel = await crop({ left: layout.regions.scores.left, top: layout.writtenTotal.top,
    width: layout.writtenTotal.left-layout.regions.scores.left, height: layout.writtenTotal.height });
  const [labelPart,valuePart] = await Promise.all([
    sharp(Buffer.from(totalLabel,"base64")).resize({width:110,height:80,fit:"inside"}).png().toBuffer({resolveWithObject:true}),
    sharp(Buffer.from(totalContrastImage || totalImage,"base64")).resize({width:128,height:80,fit:"inside"}).png().toBuffer({resolveWithObject:true}),
  ]);
  const totalLine = (await sharp({create:{width:280,height:Math.max(labelPart.info.height,valuePart.info.height)+16,
    channels:3,background:"white"}}).composite([
      {input:labelPart.data,left:8,top:8},{input:valuePart.data,left:128,top:8},
    ]).jpeg({quality:95}).toBuffer()).toString("base64");
  const [fastScoresImage, identityImage, identityReaderImage, numericCheckImage, identityTextImage] = await Promise.all([
    scoreTableRead ? stack([regions.course, regions.scores], scoreWidth, [384,scoreWidth])
      : stack([courseLabelled, regions.scores], Math.max(640, questionCount * 40)),
    stack([identity.fullNameLabelled, identity.studentNumberLabelled], 512),
    stack([identity.fullName, identity.studentNumber], 448),
    stack([identity.studentNumberLabelled,totalLine], 448, [448,280]),
    stack([identity.fullNameLabelled,identity.studentNumberLabelled,courseLabelled],512),
  ]);
  const bandTop=Math.max(layout.regions.scores.top,Math.min(...layout.scoreCells.map(c=>c.top))-3);
  const scoreBand=await crop({left:layout.regions.scores.left,top:bandTop,width:layout.regions.scores.width,
    height:layout.writtenTotal.top+layout.writtenTotal.height-bandTop});
  const scoreTextImage=scoreBand ? await stack([identity.studentNumberLabelled,scoreBand],Math.max(640,questionCount*40),
    [512,Math.max(640,questionCount*40)]) : undefined;
  // Bound primary OCR input without discarding the color source. Missing
  // scores are retried using their own, separately enlarged cell images.
  const nativeSources = [regions.scores, regions.course, identity.fullNameZoom, identity.fullNameLabelled,
    identity.studentNumberZoom, identity.studentNumberLabelled, totalImage, totalContrastImage, scoreRowImage,
    ...scoreCells.flatMap(cell => [cell.color, cell.padded])];
  const identitySources = new Set([identity.fullNameZoom, identity.fullNameLabelled,
    identity.studentNumberZoom, identity.studentNumberLabelled]);
  const nativeImages = fast ? undefined : new Map(await Promise.all(nativeSources.filter((source): source is string => !!source).map(async source => {
    const width = identitySources.has(source) ? 960 : source === regions.scores ? Math.max(800, questionCount * 45)
      : source === scoreRowImage ? Math.max(640, questionCount * 40) : 640;
    const focused = source === totalImage ? await focusNumericCell(source) : source;
    const resized = await sharp(Buffer.from(focused, "base64")).resize({ width,
      height: identitySources.has(source) || source === regions.scores ? 256 : 160, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 94 }).toBuffer();
    return [source, resized.toString("base64")] as const;
  })));
  return { image, regions, identity, compactImage, totalImage, totalContrastImage, scoreCells, scoreRowImage, nativeImages,
    fastScoresImage, identityImage, identityReaderImage, identityTextImage, scoreTableRead, scoreTextImage, numericCheckImage, preparationStartedAt };
}
