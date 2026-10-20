/** Match the visible 5:3 object-cover preview, including portrait cameras. */
export function upperFormFrame(videoWidth: number, videoHeight: number) {
  if (!(videoWidth > 0 && videoHeight > 0)) throw new Error("Kamera henüz hazır değil.");
  const sourceWidth = Math.min(videoWidth, videoHeight / 0.6);
  const sourceHeight = sourceWidth * 0.6;
  const width = Math.round(Math.min(1600, sourceWidth));
  return {
    sourceX: (videoWidth - sourceWidth) / 2,
    sourceY: (videoHeight - sourceHeight) / 2,
    sourceWidth, sourceHeight, width, height: Math.round(width * 0.6),
  };
}
