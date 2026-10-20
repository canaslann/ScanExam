"use client";
import { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, RotateCcw, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { upperFormFrame } from "@/lib/camera-frame";
import { RapidCameraCapture } from "@/lib/rapid-camera-capture";
import type { CropBox } from "@/lib/paper-regions";
import RapidCameraWorker from "@/lib/rapid-camera.worker?worker";

type Detection={box:CropBox|null;acceptable:boolean;quality:number};

export function RapidCamera({questionCount,enabled,onCapture}:{
  questionCount:number;enabled:boolean;onCapture:(blob:Blob)=>Promise<void>;
}) {
  const videoRef=useRef<HTMLVideoElement>(null),capture=useRef(onCapture),available=useRef(enabled);
  const controller=useRef(new RapidCameraCapture());
  const [active,setActive]=useState(false),[device,setDevice]=useState("");
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]);
  const [message,setMessage]=useState("Kamera kapalı"),[saving,setSaving]=useState(false),[flash,setFlash]=useState(false);
  useEffect(()=>{capture.current=onCapture;available.current=enabled;},[onCapture,enabled]);
  useEffect(()=>{
    if(!active) return;
    let disposed=false,stream:MediaStream|undefined,worker:Worker|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined,flashTimer:ReturnType<typeof setTimeout>|undefined;
    const camera=videoRef.current;
    controller.current=new RapidCameraCapture();
    const stopForHidden=()=>{
      if(document.hidden){setActive(false);setMessage("Sekme gizlendi; devam etmek için kamerayı yeniden açın.");}
    };
    const listDevices=()=>{void navigator.mediaDevices.enumerateDevices().then(all=>{
      if(!disposed)setDevices(all.filter(item=>item.kind==="videoinput"));
    }).catch(()=>undefined);};
    const fail=(error:unknown)=>{
      if(disposed)return;
      setActive(false);setSaving(false);
      setMessage(error instanceof Error?error.message:"Hızlı kamera açılamadı.");
    };
    const save=async(frame:HTMLCanvasElement)=>{
      setSaving(true);
      try {
        // Exactly the same frame shape, JPEG quality and callback as manual
        // camera capture. Detection coordinates never crop out identity.
        const blob=await new Promise<Blob>((resolve,reject)=>frame.toBlob(value=>value?resolve(value):reject(new Error("Fotoğraf hazırlanamadı.")),"image/jpeg",.94));
        if(disposed)return;
        await capture.current(blob);
        if(disposed)return;
        setFlash(true);setMessage("Görüntü kaydedildi · sıradaki kâğıt için kâğıdı çerçeveden çıkarın.");
        clearTimeout(flashTimer);flashTimer=setTimeout(()=>setFlash(false),900);
      } finally {if(!disposed)setSaving(false);}
    };
    const start=async()=>{
      if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)
        throw new Error("Kamera için bilgisayarda localhost, telefonda HTTPS bağlantısını kullanın.");
      stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{
        ...(device?{deviceId:{exact:device}}:{facingMode:{ideal:"environment"}}),
        width:{ideal:2560},height:{ideal:1440},
      }});
      if(disposed){stream.getTracks().forEach(track=>track.stop());return;}
      if(!camera)return;
      camera.srcObject=stream;await camera.play();
      if(disposed)return;
      listDevices();navigator.mediaDevices.addEventListener("devicechange",listDevices);
      stream.getVideoTracks()[0]?.addEventListener("ended",()=>fail(new Error("Kamera bağlantısı kesildi; yeniden açın.")));
      worker=new RapidCameraWorker();
      worker.onerror=()=>fail(new Error("Tablo algılama başlatılamadı; sayfayı yenileyin."));
      const sample=()=>{
        if(disposed)return;
        if(!available.current||!camera.videoWidth){
          controller.current.reset();
          setMessage(available.current?"Kamera hazırlanıyor…":"Aktarım kuyruğu hazır olunca yakalama devam edecek.");
          timer=setTimeout(sample,300);return;
        }
        const box=upperFormFrame(camera.videoWidth,camera.videoHeight);
        const frame=document.createElement("canvas");frame.width=box.width;frame.height=box.height;
        frame.getContext("2d")!.drawImage(camera,box.sourceX,box.sourceY,box.sourceWidth,box.sourceHeight,0,0,box.width,box.height);
        const analysis=document.createElement("canvas");analysis.width=800;analysis.height=Math.round(frame.height*800/frame.width);
        const ctx=analysis.getContext("2d",{willReadFrequently:true})!;
        ctx.drawImage(frame,0,0,analysis.width,analysis.height);
        const pixels=ctx.getImageData(0,0,analysis.width,analysis.height).data;
        // The full-resolution frame stays in this closure while its own
        // analysis runs. Never photograph a later, unvalidated video frame.
        worker!.onmessage=async(event:MessageEvent<Detection>)=>{
          if(disposed)return;
          if(!available.current){controller.current.reset();timer=setTimeout(sample,300);return;}
          try {
            const state=await controller.current.accept(frame,event.data,performance.now(),save);
            if(disposed)return;
            if(state==="remove")setMessage("Sıradaki kâğıt için kâğıdı çerçeveden çıkarın.");
            else if(state!=="captured")setMessage(event.data.box?"Tablo bulundu; netleşmesini bekleyin.":"İsim, numara ve Puan / Not tablosunun tamamını çerçeveye alın.");
            timer=setTimeout(sample,90);
          } catch(error){fail(error);}
        };
        worker!.postMessage({pixels:pixels.buffer,width:analysis.width,height:analysis.height,questionCount},[pixels.buffer]);
      };
      setMessage("İsim, numara ve Puan / Not tablosunu çerçeveye alın; uygun görüntü otomatik çekilir.");
      sample();
    };
    document.addEventListener("visibilitychange",stopForHidden);
    void start().catch(fail);
    return()=>{
      disposed=true;clearTimeout(timer);clearTimeout(flashTimer);worker?.terminate();
      stream?.getTracks().forEach(track=>track.stop());
      navigator.mediaDevices?.removeEventListener("devicechange",listDevices);
      document.removeEventListener("visibilitychange",stopForHidden);
      if(camera)camera.srcObject=null;
    };
  },[active,device,questionCount]);
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <Button className="camera-toggle" disabled={!enabled&&!active} onClick={()=>{setSaving(false);setFlash(false);setMessage(active?"Kamera kapalı":"Kamera hazırlanıyor…");setActive(!active);}}>
        <Camera className="size-4"/>{active?"Kamerayı kapat":"Kamerayı aç"}
      </Button>
      {devices.length>0&&<select aria-label="Kamera seçimi" value={device} disabled={saving} onChange={event=>setDevice(event.target.value)} className="min-w-0 max-w-full rounded-lg border border-input bg-muted px-2 py-2 text-sm text-foreground">
        <option value="">Otomatik kamera</option>{devices.map((item,i)=><option key={item.deviceId} value={item.deviceId}>{item.label||`Kamera ${i+1}`}</option>)}
      </select>}
      {active&&<Button variant="ghost" disabled={saving} onClick={()=>{controller.current.reset();setFlash(false);setMessage("Sonraki kâğıt için hazır.");}}><RotateCcw className="size-4"/>Sonraki kâğıda hazırla</Button>}
    </div>
    <div className={`camera-preview relative aspect-[5/3] overflow-hidden rounded-xl ${active?"is-active":""}`}>
      <video ref={videoRef} autoPlay muted playsInline className={`size-full object-cover ${active?"":"invisible"}`}/>
      <div className="camera-outline pointer-events-none absolute inset-[3%] rounded-lg border"><i className="corner corner-tl"/><i className="corner corner-tr"/><i className="corner corner-bl"/><i className="corner corner-br"/></div>
      {!active&&<div className="absolute inset-0 grid place-items-center text-center"><div className="camera-idle"><div className="camera-idle-icon"><ScanLine className="size-7"/></div><p>Üst form ve puan tablosu</p></div></div>}
      {flash&&active&&<div className="capture-flash absolute inset-0 grid place-items-center"><div className="capture-confirmation rounded-2xl p-5 text-center"><CheckCircle2 className="mx-auto size-12"/><p className="mt-2 font-semibold">Görüntü kaydedildi</p></div></div>}
    </div>
    <p className="camera-message min-h-10 text-sm" role="status" aria-live="polite">{saving?"Görüntü kaydediliyor…":message}</p>
    <p className="text-xs leading-5 text-muted-foreground">İsim, numara ve puan tablosu birlikte göründüğünde otomatik çekilir. Kaydedilen fotoğraf seri çekimdeki aynı okuma kuyruğuna gider. Okuma sonucunu beklemeden sonraki kâğıda geçebilirsiniz.</p>
  </div>;
}
