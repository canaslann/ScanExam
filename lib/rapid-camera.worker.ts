import { detectLivePaper } from "./live-detection.ts";

// Use option 1's complete-form validation. A score grid alone cannot trigger
// option 3; the captured JPEG follows option 2's existing upload/OCR path.
self.onmessage=(event:MessageEvent<{pixels:ArrayBuffer;width:number;height:number;questionCount:number}>)=>{
  const {pixels,width,height,questionCount}=event.data;
  try {self.postMessage(detectLivePaper(new Uint8ClampedArray(pixels),width,height,questionCount,false));}
  catch {self.postMessage({box:null,acceptable:false,quality:0});}
};
