"use client";
import { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, RotateCcw, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CAPTURE_INTERVAL_MS,
  CaptureFrameBuffer,
  CaptureGate,
} from "@/lib/capture-gate";
import type { CropBox } from "@/lib/paper-regions";
import PaperDetectorWorker from "@/lib/paper-detector.worker?worker";

export function LiveCamera({
  questionCount,
  enabled,
  onCapture,
}: {
  questionCount: number;
  enabled: boolean;
  onCapture: (blob: Blob) => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null),
    gate = useRef(new CaptureGate());
  const captureRef = useRef(onCapture),
    enabledRef = useRef(enabled);
  const [active, setActive] = useState(false),
    [device, setDevice] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [message, setMessage] = useState("Kamera kapalı"),
    [flash, setFlash] = useState(false);
  useEffect(() => {
    captureRef.current = onCapture;
    enabledRef.current = enabled;
  }, [onCapture, enabled]);
  useEffect(() => {
    if (!active) return;
    const videoElement = videoRef.current;
    let disposed = false,
      stream: MediaStream | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      flashTimer: ReturnType<typeof setTimeout> | undefined;
    let worker: Worker | undefined;
    const frames = new CaptureFrameBuffer<HTMLCanvasElement>();
    gate.current.reset();
    const list = () =>
      navigator.mediaDevices
        .enumerateDevices()
        .then((all) => {
          if (!disposed)
            setDevices(all.filter((item) => item.kind === "videoinput"));
        })
        .catch(() => undefined);
    const hidden = () => {
      if (document.hidden) {
        setActive(false);
        setMessage(
          "Sekme gizlendi; taramayı sürdürmek için kamerayı yeniden açın.",
        );
      }
    };
    document.addEventListener("visibilitychange", hidden);
    const start = async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "Canlı kamera için HTTPS gerekir. Bilgisayarda localhost, telefonda güvenilir HTTPS adresi kullanın.",
        );
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(device
            ? { deviceId: { exact: device } }
            : { facingMode: { ideal: "environment" } }),
          // Portrait streams often expose the shorter side as videoWidth.
          // Ask for more optical detail before the existing 1600px snapshot
          // limit; "ideal" still allows cameras to negotiate a lower size.
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
      });
      if (disposed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      if (disposed) return;
      void list();
      navigator.mediaDevices.addEventListener("devicechange", list);
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (!disposed) {
          setActive(false);
          setMessage(
            "Kamera bağlantısı kesildi. Aygıtı kontrol edip yeniden açın.",
          );
        }
      });
      // Let Vite resolve the browser asset; RSC rewrites this component's import.meta.url to file://.
      worker = new PaperDetectorWorker();
      worker.onerror = () => {
        if (!disposed) {
          setActive(false);
          setMessage(
            "Otomatik algılama başlatılamadı. Sayfayı yenileyin veya fotoğraf seçin.",
          );
        }
      };
      const sample = () => {
        if (disposed) return;
        if (!enabledRef.current || !video.videoWidth) {
          gate.current.reset();
          frames.reset();
          setMessage(
            enabledRef.current
              ? "Kamera hazırlanıyor…"
              : "Kuyruk dolu veya yerel kayıt hazır değil; tarama bekliyor.",
          );
          timer = setTimeout(sample, 600);
          return;
        }
        // Keep a fixed color snapshot until analysis finishes; never capture a later camera frame.
        const sourceWidth = Math.min(video.videoWidth, video.videoHeight / 0.6),
          sourceHeight = sourceWidth * 0.6,
          sourceX = (video.videoWidth - sourceWidth) / 2,
          sourceY = (video.videoHeight - sourceHeight) / 2;
        const frame = document.createElement("canvas");
        frame.width = Math.min(1600, sourceWidth);
        frame.height = Math.round(
          (sourceHeight * frame.width) / sourceWidth,
        );
        frame
          .getContext("2d")!
          .drawImage(
            video,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            0,
            0,
            frame.width,
            frame.height,
          );
        const analysis = document.createElement("canvas");
        analysis.width = 800;
        analysis.height = Math.round((frame.height * 800) / frame.width);
        const ctx = analysis.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(frame, 0, 0, analysis.width, analysis.height);
        const pixels = ctx.getImageData(
          0,
          0,
          analysis.width,
          analysis.height,
        ).data;
        worker!.onmessage = async (
          event: MessageEvent<{
            box: CropBox | null;
            acceptable: boolean;
            quality: number;
          }>,
        ) => {
          if (disposed) return;
          const state = gate.current.sample(
            event.data.box,
            performance.now(),
            event.data.acceptable,
          );
          const captureFrame =
            state === "steady" || state === "captured"
              ? frames.consider(gate.current.generation, frame, event.data.quality)
              : frame;
          if (state !== "steady" && state !== "captured") frames.reset();
          setMessage(
            state === "remove"
              ? "Sıradaki kâğıt için kâğıdı çerçeveden çıkarın."
              : state === "steady"
                ? "Tablo algılandı · sabit tutun…"
                : event.data.box
                  ? "Daha net ışık/odak için kamerayı sabit tutun."
                  : "Üst formu ve tüm Puan / Not tablosunu çerçeveye hizalayın.",
          );
          if (state === "captured" && enabledRef.current) {
            try {
              const blob = await new Promise<Blob>((resolve, reject) =>
                captureFrame.toBlob(
                  (value) =>
                    value
                      ? resolve(value)
                      : reject(new Error("Görüntü hazırlanamadı.")),
                  "image/jpeg",
                  0.94,
                ),
              );
              if (disposed) return;
              await captureRef.current(blob);
              if (!disposed) {
                setFlash(true);
                setMessage(
                  "Görüntü kaydedildi · aktarım/OCR arka planda · sonraki kâğıda geçin.",
                );
                flashTimer = setTimeout(() => setFlash(false), 1600);
              }
            } catch (error) {
              if (!disposed) {
                gate.current.reset();
                setActive(false);
                setMessage(
                  error instanceof Error
                    ? error.message
                    : "Kuyruğa kayıt başarısız.",
                );
              }
            }
          }
          if (!disposed) timer = setTimeout(sample, CAPTURE_INTERVAL_MS);
        };
        worker!.postMessage(
          {
            pixels: pixels.buffer,
            width: analysis.width,
            height: analysis.height,
            questionCount,
          },
          [pixels.buffer],
        );
      };
      sample();
    };
    void start().catch((error: unknown) => {
      if (!disposed) {
        setActive(false);
        setMessage(
          error instanceof Error
            ? `${error.name === "NotAllowedError" ? "Kamera izni verilmedi. " : error.name === "NotReadableError" ? "Kamera başka uygulamada açık olabilir. " : ""}${error.message}`
            : "Kamera açılamadı.",
        );
      }
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(flashTimer);
      worker?.terminate();
      stream?.getTracks().forEach((track) => track.stop());
      navigator.mediaDevices?.removeEventListener("devicechange", list);
      document.removeEventListener("visibilitychange", hidden);
      if (videoElement) videoElement.srcObject = null;
    };
  }, [active, device, questionCount]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="camera-toggle"
          disabled={!enabled && !active}
          onClick={() => setActive(!active)}
        >
          <Camera className="size-4" />
          {active ? "Kamerayı kapat" : "Kamerayı aç"}
        </Button>
        {devices.length > 0 && (
          <select
            aria-label="Kamera seçimi"
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            className="min-w-0 max-w-full rounded-lg border border-input bg-muted px-2 py-2 text-sm text-foreground"
          >
            <option value="">Otomatik kamera</option>
            {devices.map((item, i) => (
              <option key={item.deviceId} value={item.deviceId}>
                {item.label || `Kamera ${i + 1}`}
              </option>
            ))}
          </select>
        )}
        {active && (
          <Button
            variant="ghost"
            onClick={() => gate.current.reset()}
          >
            <RotateCcw className="size-4" />
            Sonraki kâğıda hazırla
          </Button>
        )}
      </div>
      <div className={`camera-preview relative aspect-[5/3] overflow-hidden rounded-xl ${active ? "is-active" : ""}`}>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className={`size-full object-cover ${active ? "" : "invisible"}`}
        />
        <div className="camera-outline pointer-events-none absolute inset-[3%] rounded-lg border"><i className="corner corner-tl" /><i className="corner corner-tr" /><i className="corner corner-bl" /><i className="corner corner-br" /></div>
        {!active && (
          <div className="absolute inset-0 grid place-items-center text-center">
            <div className="camera-idle">
              <div className="camera-idle-icon"><ScanLine className="size-7" /></div>
              <p>Üst form ve puan tablosu</p>
            </div>
          </div>
        )}
        {flash && active && (
          <div className="capture-flash absolute inset-0 grid place-items-center">
            <div className="capture-confirmation rounded-2xl p-5 text-center">
              <CheckCircle2 className="mx-auto size-12" />
              <p className="mt-2 font-semibold">Görüntü kaydedildi</p>
            </div>
          </div>
        )}
      </div>
      <p
        className="camera-message min-h-10 text-sm"
        role="status"
        aria-live="polite"
      >
        {message}
      </p>
      <details className="camera-hint text-xs leading-5">
        <summary>Tarama ipuçları</summary>
        <p>
        Yeşil tik görüntünün bu cihaza kaydedildiğini belirtir, okuma sonucu
        değildir. Aktarım bilgisayara arka planda yapılır. Kâğıdı tamamen
        çıkarıp yenisini tutun; üst üste değiştiriyorsanız “Sonraki kâğıda
        hazırla”yı kullanın. Soru sayısı / şablon eşleşmezse otomatik
        yakalanmaz.
        </p>
      </details>
    </div>
  );
}
