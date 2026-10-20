import { CaptureGate } from "./capture-gate.ts";
import type { CropBox } from "./paper-regions.ts";

type Detection={box:CropBox|null;acceptable:boolean};

/** Capture one validated source frame, then wait for paper removal. No OCR. */
export class RapidCameraCapture {
  private gate=new CaptureGate(1,0);
  private saving=false;
  reset() { this.gate.reset(); }
  async accept<T>(frame:T,detection:Detection,now:number,save:(frame:T)=>Promise<void>) {
    if(this.saving) return "saving" as const;
    const state=this.gate.sample(detection.box,now,detection.acceptable);
    if(state!=="captured") return state;
    this.saving=true;
    try { await save(frame); return "captured" as const; }
    catch(error) { this.gate.reset(); throw error; }
    finally {this.saving=false;}
  }
}
