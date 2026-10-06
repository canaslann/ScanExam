import { detectPaperRegions } from "./paper-regions.ts";

/** Contrast/focus heuristic, not OCR confidence. Color image is never modified. */
export function detectLivePaper(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  questionCount: number,
) {
  const boxes = detectPaperRegions(
    pixels,
    width,
    height,
    4,
    undefined,
    questionCount,
  );
  let edge = 0,
    count = 0,
    clipped = 0;
  if (boxes)
    for (const box of [boxes.student, boxes.scores]) {
      for (
        let y = Math.max(1, Math.ceil(box.top + 3));
        y < Math.min(height - 1, box.top + box.height - 3);
        y += 2
      )
        for (
          let x = Math.max(1, Math.ceil(box.left + 3));
          x < Math.min(width - 1, box.left + box.width - 3);
          x += 2
        ) {
          const i = (y * width + x) * 4,
            value = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
          const next = (pixels[i + 4] + pixels[i + 5] + pixels[i + 6]) / 3;
          edge += Math.abs(value - next);
          count++;
          if (value >= 254) clipped++;
        }
    }
  return {
    box: boxes?.scores || null,
    acceptable: count > 0 && edge / count > 2 && clipped / count < 0.85,
    quality: count > 0 ? edge / count : 0,
  };
}
