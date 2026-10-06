import sharp from "sharp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compactPaperHeight, detectPaperRegions, REGION_KEYS } from "../../lib/paper-regions.ts";
import { work } from "./runtime.mjs";

export async function prepareAutoRegions(buffer) {
  const started = performance.now();
  const { data, info } = await sharp(buffer).resize({ width: 800, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
  const boxes = detectPaperRegions(data, info.width, info.height, info.channels);
  const regions = {};
  let compact;
  if (boxes) {
    const metadata = await sharp(buffer).metadata();
    const scale = metadata.width / info.width;
    // Keep the complete upper table at its original width; remove only blank
    // space below the detected final Not row. No fields/labels are isolated.
    const bottom = compactPaperHeight(boxes.scores, scale, metadata.height);
    compact = "data:image/jpeg;base64," + (await sharp(buffer).extract({ left: 0, top: 0, width: metadata.width, height: bottom }).jpeg({ quality: 94 }).toBuffer()).toString("base64");
    for (const name of REGION_KEYS) {
      const box = boxes[name];
      const crop = { left: Math.round(box.left * scale), top: Math.round(box.top * scale),
        width: Math.round(box.width * scale), height: Math.round(box.height * scale) };
      regions[name] = "data:image/jpeg;base64," + (await sharp(buffer).extract(crop).jpeg({ quality: 94 }).toBuffer()).toString("base64");
    }
  }
  return { regions: boxes ? regions : undefined, compact, layout: { boxes, elapsedMs: performance.now() - started } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const manifest = JSON.parse(await readFile(join(work, "prepared-cases.json"), "utf8"));
const directory = join(work, "images", "auto");
await mkdir(directory, { recursive: true });
for (const item of manifest.cases) {
  const { regions, layout } = await prepareAutoRegions(await readFile(item.prepared));
  item.regionImages = {};
  delete item.regions; // Manual annotations must never drive automatic selection.
  item.automaticLayout = layout;
  console.log(item.id, JSON.stringify(item.automaticLayout));
  if (!regions) continue;
  for (const name of REGION_KEYS) {
    const path = join(directory, `${item.id}-${name}.jpg`);
    await writeFile(path, Buffer.from(regions[name].split(",")[1], "base64"));
    item.regionImages[name] = path;
  }
}
manifest.preprocessing = { ...manifest.preprocessing, automaticLayout: true };
await writeFile(join(work, "prepared-cases-auto.json"), JSON.stringify(manifest, null, 2) + "\n");
}
