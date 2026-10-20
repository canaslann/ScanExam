import { detectPaperRegions } from "./paper-regions.ts";
import { rapidScoreGrid, type Ruling } from "./rapid-detection.ts";

/** Contrast/focus heuristic, not OCR confidence. Color image is never modified. */
export function detectLivePaper(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  questionCount: number,
  rapid = false,
) {
  let lines: Ruling[] = [], dark: Uint8Array | undefined;
  const boxes = detectPaperRegions(
    pixels,
    width,
    height,
    4,
    rapid ? (stage, value) => {
      if(stage === "lines") lines = value as Ruling[];
      if(stage === "mask") dark = (value as {dark:Uint8Array}).dark;
    } : undefined,
    questionCount,
  );
  const scoreBox = boxes?.scores || (rapid ? rapidScoreGrid(lines,dark,width,height,questionCount) : null);
  let edge = 0,
    count = 0,
    clipped = 0;
  if (scoreBox)
    for (const box of boxes ? [boxes.student, scoreBox] : [scoreBox]) {
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
    box: scoreBox,
    acceptable: count > 0 && edge / count > 2 && clipped / count < 0.85,
    quality: count > 0 ? edge / count : 0,
  };
}
