import sharp from "sharp";
import { detectPaperLayout, compactPaperHeight, REGION_KEYS, type PaperRegions } from "./paper-regions.ts";

export type IdentityImages = Record<"fullName" | "studentNumber" | "combined" | "fullNameZoom" | "studentNumberZoom" | "fullNamePadded" | "studentNumberPadded" | "fullNameLabelled" | "studentNumberLabelled", string>;

export type PreparedPaper = {
  image: string;
  regions?: PaperRegions;
  compactImage?: string;
  identity?: IdentityImages;
  totalImage?: string;
};

/** Fixed form geometry supplies identity cells; question columns remain dynamic. */
export async function prepareServerPaper(bytes: Uint8Array, questionCount: number): Promise<PreparedPaper> {
  const oriented = await sharp(bytes, { limitInputPixels: 24_000_000 })
    .rotate().resize({ width: 1600, withoutEnlargement: true }).removeAlpha()
    .png().toBuffer({ resolveWithObject: true });
  if (oriented.info.width < 300 || oriented.info.height < 150)
    throw new Error("Görüntü çok küçük; üst formu daha yakından tarayın.");
  const width = oriented.info.width;
  const height = Math.min(oriented.info.height, Math.round(width * 0.6));
  const buffer = await sharp(oriented.data).extract({ left: 0, top: 0, width, height }).jpeg({ quality: 94 }).toBuffer();
  const image = buffer.toString("base64");
  const analysis = await sharp(oriented.data).extract({ left: 0, top: 0, width, height })
    .resize({ width: Math.min(800, width) }).raw().toBuffer({ resolveWithObject: true });
  const layout = detectPaperLayout(analysis.data, analysis.info.width, analysis.info.height, analysis.info.channels, undefined, questionCount);
  if (!layout) return { image };
  const scale = width / analysis.info.width;
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
  identity.fullNameZoom = await crop(layout.identity.fullName, 2);
  identity.studentNumberZoom = await crop(layout.identity.studentNumber, 2);
  for (const key of ["fullName", "studentNumber"] as const)
    identity[`${key}Padded`] = (await sharp(Buffer.from(identity[`${key}Zoom`], "base64"))
      .extend({ top: 24, bottom: 24, left: 24, right: 24, background: "white" }).jpeg({ quality: 94 }).toBuffer()).toString("base64");
  const totalImage = await crop(layout.writtenTotal, 2);
  const compactImage = (await sharp(buffer).extract({ left: 0, top: 0, width,
    height: compactPaperHeight(layout.regions.scores, scale, height),
  }).jpeg({ quality: 94 }).toBuffer()).toString("base64");
  return { image, regions, identity, compactImage, totalImage };
}
