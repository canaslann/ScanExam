import type { CropBox } from "./paper-regions.ts";

export const CAPTURE_INTERVAL_MS = 180;
export const CAPTURE_STABLE_MS = 500;

/** Geometry is not recognition confidence. Require stable detections, then latch until removal. */
export class CaptureGate {
  private readonly requiredSamples: number;
  private readonly stableMs: number;
  constructor(requiredSamples = 3, stableMs = CAPTURE_STABLE_MS) {
    this.requiredSamples = requiredSamples;
    this.stableMs = stableMs;
  }
  private previous: CropBox | null = null;
  private stableSince = 0;
  private samples = 0;
  private latched = false;
  private absentSince: number | null = null;
  private sequence = 0;
  get generation() {
    return this.sequence;
  }
  reset() {
    this.sequence++;
    this.previous = null;
    this.samples = 0;
    this.latched = false;
    this.absentSince = null;
  }
  sample(
    box: CropBox | null,
    now: number,
    acceptable: boolean,
  ): "searching" | "steady" | "captured" | "remove" {
    if (!box) {
      this.previous = null;
      this.samples = 0;
      this.absentSince ??= now;
      if (now - this.absentSince >= 600) this.latched = false;
      return this.latched ? "remove" : "searching";
    }
    this.absentSince = null;
    if (this.latched) return "remove";
    if (!acceptable) {
      this.samples = 0;
      this.previous = null;
      return "searching";
    }
    const old = this.previous;
    const stable =
      old &&
      Math.max(
        Math.abs(box.left - old.left),
        Math.abs(box.top - old.top),
        Math.abs(box.width - old.width),
        Math.abs(box.height - old.height),
      ) < 10;
    if (!stable) {
      this.sequence++;
      this.stableSince = now;
      this.samples = 0;
    }
    this.previous = box;
    this.samples++;
    if (this.samples >= this.requiredSamples && now - this.stableSince >= this.stableMs) {
      this.latched = true;
      return "captured";
    }
    return "steady";
  }
}

/** Keep the sharpest source frame only within one uninterrupted stable run. */
export class CaptureFrameBuffer<T> {
  private generation = -1;
  private best: { frame: T; quality: number } | null = null;
  reset() {
    this.best = null;
    this.generation = -1;
  }
  consider(generation: number, frame: T, quality: number): T {
    if (generation !== this.generation) {
      this.reset();
      this.generation = generation;
    }
    if (Number.isFinite(quality) && (!this.best || quality > this.best.quality))
      this.best = { frame, quality };
    return this.best?.frame ?? frame;
  }
}
