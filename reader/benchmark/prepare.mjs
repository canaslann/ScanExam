import sharp from "sharp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { work } from "./runtime.mjs";

const manifestPath = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : join(work, "cases.json"));
const widthIndex = process.argv.indexOf("--width");
const maxWidth = widthIndex < 0 ? 1600 : Number(process.argv[widthIndex + 1]);
const scaleIndex = process.argv.indexOf("--region-scale");
const regionScale = scaleIndex < 0 ? 1 : Number(process.argv[scaleIndex + 1]);
if (![1, 2, 3].includes(regionScale)) throw new Error("Region scale must be 1, 2 or 3");
if (!Number.isInteger(maxWidth) || maxWidth < 300 || maxWidth > 1600) throw new Error("Width must be between 300 and 1600");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.preprocessing = { maxWidth, sourceHeightRatio: 0.6, jpegQuality: 94, regionScale };
const scaleSuffix = regionScale === 1 ? "" : `-regions-x${regionScale}`;
const imageRoot = join(work, "images", `${maxWidth}${scaleSuffix}`);
await mkdir(imageRoot, { recursive: true });
for (const item of manifest.cases) {
  const metadata = await sharp(item.source).metadata();
  const width = metadata.width;
  const sourceHeight = Math.min(metadata.height, Math.round(width * 0.6));
  item.prepared = join(imageRoot, `${item.id}-top.jpg`);
  await sharp(item.source).extract({ left: 0, top: 0, width, height: sourceHeight })
    .resize({ width: Math.min(maxWidth, width) }).jpeg({ quality: 94 }).toFile(item.prepared);
  item.dimensions = { original: [width, metadata.height], prepared: [Math.min(maxWidth, width), Math.round(sourceHeight * Math.min(maxWidth, width) / width)] };
  for (const [name, box] of Object.entries(item.regions || {})) {
    const region = { left: Math.round(box[0] * width), top: Math.round(box[1] * metadata.height),
      width: Math.round(box[2] * width), height: Math.round(box[3] * metadata.height) };
    const path = join(imageRoot, `${item.id}-${name}.jpg`);
    await sharp(item.source).extract(region).resize({ width: Math.max(1, Math.round(region.width * Math.min(1, maxWidth / width) * regionScale)) }).jpeg({ quality: 94 }).toFile(path);
    item.regionImages ??= {};
    item.regionImages[name] = path;
  }
  console.log(`${item.id}: ${width}×${sourceHeight}`);
}
await writeFile(join(work, `prepared-cases${maxWidth === 1600 ? "" : `-${maxWidth}`}${scaleSuffix}.json`), JSON.stringify(manifest, null, 2) + "\n");
