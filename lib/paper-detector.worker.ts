import { detectLivePaper } from "./live-detection.ts";

self.onmessage = (
  event: MessageEvent<{
    pixels: ArrayBuffer;
    width: number;
    height: number;
    questionCount: number;
    rapid?: boolean;
  }>,
) => {
  const { width, height, questionCount } = event.data,
    pixels = new Uint8ClampedArray(event.data.pixels);
  try {
    self.postMessage(detectLivePaper(pixels, width, height, questionCount, event.data.rapid));
  } catch {
    self.postMessage({ box: null, acceptable: false, quality: 0 });
  }
};
