import { detectLivePaper } from "./live-detection.ts";

self.onmessage = (
  event: MessageEvent<{
    pixels: ArrayBuffer;
    width: number;
    height: number;
    questionCount: number;
  }>,
) => {
  const { width, height, questionCount } = event.data,
    pixels = new Uint8ClampedArray(event.data.pixels);
  try {
    self.postMessage(detectLivePaper(pixels, width, height, questionCount));
  } catch {
    self.postMessage({ box: null, acceptable: false, quality: 0 });
  }
};
