// Geometry only: no names, scores, OCR results or case-specific coordinates.
// Unknown/rotated/cropped forms must fall back to the original full-table reader.
export const REGION_KEYS = ["student", "course", "scores"] as const;
export type RegionKey = (typeof REGION_KEYS)[number];
export type PaperRegions = Record<RegionKey, string>;
export type CropBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export type PaperLayout = {
  regions: Record<RegionKey, CropBox>;
  identity: Record<"fullName" | "studentNumber" | "combined" | "fullNameLabelled" | "studentNumberLabelled", CropBox>;
  writtenTotal: CropBox;
};
type Line = {
  y: number;
  slope: number;
  left: number;
  right: number;
  coverage: number;
};

/** Preserve the complete table at full width, plus a margin below the Not row. */
export function compactPaperHeight(
  scores: CropBox,
  scale: number,
  originalHeight: number,
): number {
  return Math.min(
    originalHeight,
    Math.ceil((scores.top + scores.height + 8) * scale),
  );
}

export function detectPaperRegions(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels = 4,
  debug?: (stage: string, geometry: unknown) => void,
  questionCount = 5,
): Record<RegionKey, CropBox> | null {
  return detectPaperLayout(pixels, width, height, channels, debug, questionCount)?.regions ?? null;
}

export function detectPaperLayout(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels = 4,
  debug?: (stage: string, geometry: unknown) => void,
  questionCount = 5,
): PaperLayout | null {
  if (
    !Number.isInteger(questionCount) ||
    questionCount < 1 ||
    questionCount > 30
  )
    return null;
  if (
    width < 300 ||
    width > 900 ||
    height < 150 ||
    height > 900 ||
    ![1, 3, 4].includes(channels) ||
    pixels.length !== width * height * channels
  )
    return null;
  const dark = new Uint8Array(width * height);
  const grayValues = new Uint8Array(width * height);
  const stride = width + 1;
  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let i = 0; i < dark.length; i++) {
    const p = i * channels;
    const gray =
      channels === 1
        ? pixels[p]
        : (pixels[p] * 3 + pixels[p + 1] * 6 + pixels[p + 2]) / 10;
    grayValues[i] = gray;
  }
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += grayValues[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum;
    }
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const l = Math.max(0, x - 8),
        r = Math.min(width, x + 9);
      const t = Math.max(0, y - 8),
        b = Math.min(height, y + 9);
      const mean =
        (integral[b * stride + r] -
          integral[t * stride + r] -
          integral[b * stride + l] +
          integral[t * stride + l]) /
        ((r - l) * (b - t));
      dark[y * width + x] =
        grayValues[y * width + x] < Math.max(110, Math.min(200, mean - 18))
          ? 1
          : 0;
    }
  const middle = width / 2;
  // The vote sweep uses only dark interior pixels. Collect them once instead
  // of rescanning every background pixel for each of the 41 slopes. The bins,
  // pixel order and detection thresholds are unchanged.
  const darkX = new Uint16Array(dark.length);
  const darkY = new Uint16Array(dark.length);
  let darkCount = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++)
      if (dark[y * width + x]) {
        darkX[darkCount] = x;
        darkY[darkCount++] = y;
      }
  const lines: Line[] = [];
  for (let step = -20; step <= 20; step++) {
    const slope = step * 0.003;
    const votes = new Uint16Array(height);
    for (let i = 0; i < darkCount; i++) {
      const bin = Math.round(darkY[i] - slope * (darkX[i] - middle));
      if (bin >= 0 && bin < height) votes[bin]++;
    }
    for (let y = 3; y < height - 3; y++) {
      let support = 0;
      for (let dy = -3; dy <= 3; dy++) support += votes[y + dy] || 0;
      if (support < width * (questionCount === 5 ? 0.85 : 0.5)) continue;
      let start = -1,
        last = -1,
        hits = 0;
      const finish = () => {
        const length = last - start + 1;
        if (
          start >= 0 &&
          length > width * (questionCount === 5 ? 0.5 : 0.2) &&
          hits / length > 0.88
        ) {
          lines.push({
            y,
            slope,
            left: start,
            right: last,
            coverage: hits / length,
          });
        }
        start = -1;
        hits = 0;
      };
      for (let x = 1; x < width - 1; x++) {
        const row = Math.round(y + slope * (x - middle));
        let hit = false;
        for (let dy = -3; dy <= 3; dy++)
          if (
            row + dy >= 0 &&
            row + dy < height &&
            dark[(row + dy) * width + x]
          ) {
            hit = true;
            break;
          }
        if (hit) {
          if (start < 0) start = x;
          last = x;
          hits++;
        } else if (start >= 0 && x - last > 7) finish();
      }
      finish();
    }
  }
  const dedupe = (candidates: Line[]) => {
    const chosen: Line[] = [];
    for (const line of candidates.sort(
      (a, b) =>
        (b.right - b.left) * b.coverage - (a.right - a.left) * a.coverage,
    )) {
      if (!chosen.some((old) => Math.abs(old.y - line.y) < 12))
        chosen.push(line);
    }
    return chosen.sort((a, b) => a.y - b.y);
  };
  const main = dedupe(
    lines.filter(
      (line) =>
        line.right - line.left > width * 0.74 && line.left < width * 0.12,
    ),
  ).slice(0, 7);
  debug?.("main", main);
  // Seven left-anchored rulings in this fixed university cover-sheet template.
  if (main.length !== 7) return null;
  const left = Math.round(
    main.slice(0, 3).reduce((sum, line) => sum + line.left, 0) / 3,
  );
  const right = Math.max(...main.map((line) => line.right));
  const span = right - left;
  if (
    span < width * 0.8 ||
    main[0].y > height * 0.24 ||
    main[6].y - main[5].y < span * 0.07 ||
    main[1].y - main[0].y < span * 0.055 ||
    main[4].y - main[2].y < span * 0.035 ||
    main[4].y - main[2].y > span * 0.1
  )
    return null;
  const mainSlope = main
    .slice(1, 6)
    .map((line) => line.slope)
    .sort((a, b) => a - b)[2];
  const scoreCandidates = lines.filter(
    (line) =>
      line.y >= main[6].y + 1 &&
      Math.abs(line.slope - mainSlope) < 0.024 &&
      line.y < main[6].y + span * 0.2 &&
      line.left < left + span * 0.025 &&
      Math.abs(line.left - left) < span * 0.045 &&
      line.right - line.left > span * (questionCount === 5 ? 0.6 : 0.22) &&
      line.right - line.left < span * 1.05,
  );
  const endpoints = [
    ...new Set(scoreCandidates.map((line) => Math.round(line.right / 8) * 8)),
  ];
  const families = endpoints
    .map((end) =>
      dedupe(scoreCandidates.filter((line) => Math.abs(line.right - end) < 8)),
    )
    .filter((family) => family.length === 4);
  const scoreLines =
    families.sort(
      (a, b) =>
        b.reduce((sum, line) => sum + line.right, 0) -
        a.reduce((sum, line) => sum + line.right, 0),
    )[0] || [];
  debug?.("scores", scoreLines);
  if (scoreLines.length !== 4) return null;
  const rowGaps = scoreLines
    .slice(1)
    .map((line, i) => line.y - scoreLines[i].y);
  if (Math.max(...rowGaps) / Math.min(...rowGaps) > 1.4) return null;
  const scoreSpan = scoreLines[0].right - scoreLines[0].left;
  if (
    scoreLines.some(
      (line) => Math.abs(line.right - scoreLines[0].right) > span * 0.025,
    ) ||
    scoreLines[0].y - main[6].y > span * 0.07 ||
    scoreLines[3].y - scoreLines[0].y < span * 0.065 ||
    scoreLines[3].y - scoreLines[0].y > span * 0.15
  )
    return null;
  const scoreColumns: number[] = [];
  for (let x = scoreLines[0].left - 2; x <= scoreLines[0].right + 2; x++) {
    let hits = 0;
    const a = scoreLines[0].y + 7,
      b = scoreLines[2].y - 5;
    for (let y = a; y <= b; y++)
      if (
        x > 0 &&
        x < width - 1 &&
        (dark[y * width + x] ||
          dark[y * width + x - 1] ||
          dark[y * width + x + 1])
      )
        hits++;
    if (hits / (b - a + 1) > 0.83 && !scoreColumns.some((old) => x - old < 6))
      scoreColumns.push(x);
  }
  debug?.("scoreColumns", scoreColumns);
  // Label column plus configured score columns, with a real outer divider.
  if (
    scoreColumns.length !== questionCount + 2 ||
    Math.abs(scoreColumns[0] - scoreLines[0].left) > 6 ||
    Math.abs(scoreColumns.at(-1)! - scoreLines[0].right) > 10
  )
    return null;
  const cells = scoreColumns.slice(2).map((x, i) => x - scoreColumns[i + 1]);
  if (
    Math.max(...cells) / Math.min(...cells) > 1.25 ||
    Math.min(...cells) < (scoreSpan / (questionCount + 2)) * 0.45
  )
    return null;
  const verticals: number[] = [];
  // Validate actual cell dividers rather than cropping by page percentages alone.
  const y0 = main[2].y + 5,
    y1 = main[4].y - 5;
  for (let x = left + 2; x < right - 2; x++) {
    let hits = 0;
    for (let y = y0; y <= y1; y++) {
      if (
        dark[y * width + x] ||
        dark[y * width + x - 1] ||
        dark[y * width + x + 1]
      )
        hits++;
    }
    if (hits / (y1 - y0 + 1) > 0.83 && !verticals.some((old) => x - old < 4))
      verticals.push(x);
  }
  const divider = (
    fraction: number,
    tolerance: number,
    edge: "left" | "right",
  ) => {
    const matches = verticals.filter(
      (x) => Math.abs((x - left) / span - fraction) < tolerance,
    );
    if (
      !matches.length ||
      Math.max(...matches) - Math.min(...matches) > span * 0.02
    )
      return null;
    return edge === "left" ? Math.min(...matches) : Math.max(...matches);
  };
  debug?.("verticals", verticals);
  const courseLeft = divider(0.155, 0.035, "left"),
    courseRight = divider(0.475, 0.035, "right");
  const studentLeft = divider(0.585, 0.035, "left"),
    studentRight = divider(0.855, 0.035, "right");
  if (
    courseLeft === null ||
    courseRight === null ||
    studentLeft === null ||
    studentRight === null
  )
    return null;
  const box = (
    x0: number,
    x1: number,
    topLine: Line,
    bottomLine: Line,
    inset = 0,
  ): CropBox => {
    const ys = [x0, x1].map((x) => topLine.y + topLine.slope * (x - middle));
    const ends = [x0, x1].map(
      (x) => bottomLine.y + bottomLine.slope * (x - middle),
    );
    const padding = 3;
    const x = Math.max(0, Math.floor(x0 + inset));
    const end = Math.min(width, Math.ceil(x1 - inset));
    const top = Math.max(0, Math.floor(Math.min(...ys) - padding));
    const bottom = Math.min(height, Math.ceil(Math.max(...ends) + padding));
    return { left: x, top, width: end - x, height: bottom - top };
  };
  return {
    writtenTotal: box(scoreColumns[1], scoreLines[0].right, scoreLines[2], scoreLines[3], 2),
    identity: {
      fullName: box(studentLeft, studentRight, main[2], main[3], 2),
      studentNumber: box(studentLeft, studentRight, main[3], main[4], 2),
      combined: box(studentLeft, studentRight, main[2], main[4], 2),
      fullNameLabelled: box(courseRight, studentRight, main[2], main[3]),
      studentNumberLabelled: box(courseRight, studentRight, main[3], main[4]),
    },
    regions: {
    // Keep the upper form context/labels, not just the isolated handwriting.
    student: box(left, right, main[0], main[4]),
    course: box(courseLeft, courseRight, main[3], main[4], 2),
    scores: box(
      scoreLines[0].left - 3,
      scoreLines[0].right + 3,
      scoreLines[0],
      scoreLines[3],
    ),
    },
  };
}
