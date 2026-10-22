import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Clip, Render } from "../../server/shared";
import { previewTransform } from "../camera";
import { loadLut } from "../lut";
import { MonitorGL } from "../monitorGL";
import type { Direction } from "../state";
import { saveToPhotos } from "../save";

export interface MonitorHandle {
  togglePlay(): void;
}

interface Props {
  clip: Clip | null;
  dir: Direction;
  render: Render | null; // the take shown in Reveal
  view: "live" | "reveal";
    developing: { progress: number; frame: string | null; message: string } | null;
  depthUrl?: string;
  showDepth: boolean;
  onToggleDepth: () => void;
}

function tc(sec: number) {
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const Monitor = forwardRef<MonitorHandle, Props>(function Monitor({ clip, dir, render, view, developing, depthUrl, showDepth, onToggleDepth }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const before = useRef<HTMLVideoElement>(null);
  const after = useRef<HTMLVideoElement>(null);
  const depthVideo = useRef<HTMLVideoElement>(null);
  const gl = useRef<MonitorGL | null>(null);
  const dirRef = useRef(dir);
  dirRef.current = dir;
  const depthOn = showDepth && !!depthUrl && view === "live";
  const depthRef = useRef(depthOn);
  depthRef.current = depthOn;
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [wipe, setWipe] = useState(0.5);
  const [glError, setGlError] = useState<string | null>(null);
  const dragging = useRef(false);

  useImperativeHandle(ref, () => ({
    togglePlay() {
      const vids = view === "reveal" ? [before.current, after.current] : [video.current];
      const paused = vids[0]?.paused ?? true;
      for (const v of vids) if (v) paused ? void v.play() : v.pause();
      setPlaying(paused);
    },
  }));

  // GL init
  useEffect(() => {
    if (!canvas.current) return;
    try {
      gl.current = new MonitorGL(canvas.current);
    } catch (e) {
      setGlError((e as Error).message);
    }
  }, []);

  // LUT swap
  useEffect(() => {
    let live = true;
    if (dir.lut === "none") gl.current?.setLut(null);
    else void loadLut(dir.lut).then((l) => live && gl.current?.setLut(l));
    return () => {
      live = false;
    };
  }, [dir.lut]);

  // render loop: draws only while live view is visible
  useEffect(() => {
    if (view !== "live") return;
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const v = video.current;
      const d = dirRef.current;
      if (!v || !gl.current || v.readyState < 2) return;
      const t = v.duration ? v.currentTime / v.duration : 0;
      const cam = previewTransform(d.camera, d.cameraStrength, d.lens, t);
      const dv = depthVideo.current;
      if (depthRef.current && dv && dv.readyState >= 2) {
        // keep the depth pass locked to the picture
        if (Math.abs(dv.currentTime - v.currentTime) > 0.08) dv.currentTime = v.currentTime;
        if (v.paused !== dv.paused) v.paused ? dv.pause() : void dv.play().catch(() => {});
        gl.current.draw(dv, { zoom: cam.zoom, pan: cam.pan, lutMix: 0, vignette: 0, grain: 0, halation: 0, depthMode: 1 }, now / 1000);
      } else {
        gl.current.draw(v, { zoom: cam.zoom, pan: cam.pan, lutMix: d.lutStrength, vignette: 0.15 + d.halation * 0.15, grain: d.grain, halation: d.halation }, now / 1000);
      }
      setTime(Math.floor(v.currentTime));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [view, clip?.id]);

  // keep reveal pair in sync
  useEffect(() => {
    if (view !== "reveal") return;
    const a = after.current;
    const b = before.current;
    if (!a || !b) return;
    let raf = 0;
    const sync = () => {
      raf = requestAnimationFrame(sync);
      // a trimmed result starts at the trim's in-point of the original
      const offset = render?.params.trim?.start ?? 0;
      if (Math.abs(a.currentTime + offset - b.currentTime) > 0.06) b.currentTime = a.currentTime + offset;
      setTime(Math.floor(a.currentTime));
    };
    raf = requestAnimationFrame(sync);
    void a.play().catch(() => {});
    void b.play().catch(() => {});
    setPlaying(true);
    return () => cancelAnimationFrame(raf);
  }, [view, render?.id]);

  const aspect = clip ? clip.width / clip.height : 16 / 9;
  const target = dir.aspect === "native" ? aspect : Number(dir.aspect);
  // matte sizes as % of the frame
  const barY = aspect < target ? (1 - aspect / target) * 50 : 0;
  const barX = aspect > target ? (1 - target / aspect) * 50 : 0;

  const onWipe = (e: React.PointerEvent) => {
    if (!dragging.current && e.type === "pointermove") return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setWipe(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };

  return (
    <div className="monitor-frame" style={{ ["--ar" as string]: String(aspect) }}>
      {clip && (
        <video
          ref={video}
          key={clip.id}
          className="src-video"
          src={clip.url}
          crossOrigin="anonymous"
          muted
          loop
          playsInline
          autoPlay
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
      )}
      {depthUrl && <video ref={depthVideo} key={depthUrl} className="src-video" src={depthUrl} crossOrigin="anonymous" muted loop playsInline autoPlay />}
      <canvas ref={canvas} className="gl" style={{ visibility: view === "live" ? "visible" : "hidden" }} />
      {glError && view === "live" && <div className="gl-error">Live preview needs WebGL2 ({glError}). Renders still work.</div>}

      {view === "reveal" && render?.url && clip && (
        <div
          className="reveal"
          onPointerDown={(e) => {
            dragging.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            onWipe(e);
          }}
          onPointerMove={onWipe}
          onPointerUp={() => (dragging.current = false)}
        >
          <video ref={after} src={render.url} muted loop playsInline className="after" />
          <video ref={before} src={clip.url} muted loop playsInline className="before" style={{ clipPath: `inset(0 ${(1 - wipe) * 100}% 0 0)` }} />
          <div className="wipe-line" style={{ left: `${wipe * 100}%` }}>
            <div className="wipe-handle" aria-hidden>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l-6 6 6 6M15 6l6 6-6 6" /></svg>
            </div>
          </div>
          <span className="chip reveal-tag left">Original</span>
          <span className="chip reveal-tag right">MOGFIELD</span>
        </div>
      )}

      {developing && (
        <div className="generating">
          {(developing.frame || clip?.poster) && <img src={developing.frame ?? clip!.poster} alt="" />}
          <div className="gen-center">
            <svg className="ring" viewBox="0 0 48 48" aria-hidden>
              <circle cx="24" cy="24" r="20" className="ring-bg" />
              <circle cx="24" cy="24" r="20" className="ring-fg" style={{ strokeDashoffset: 125.66 * (1 - Math.max(0.03, developing.progress)) }} />
            </svg>
            <b>{Math.round(developing.progress * 100)}%</b>
            <span>{developing.message}</span>
          </div>
        </div>
      )}

      <div className="matte top" style={{ height: `${barY}%` }} />
      <div className="matte bottom" style={{ height: `${barY}%` }} />
      <div className="matte left" style={{ width: `${barX}%` }} />
      <div className="matte right" style={{ width: `${barX}%` }} />

      <div className="chips top-left">
        <span className="chip">{view === "reveal" ? "Result" : depthOn ? "Depth" : "Live preview"}</span>
        {depthUrl && view === "live" && (
          <button className={`chip toggle-chip ${depthOn ? "on" : ""}`} onClick={onToggleDepth} aria-pressed={depthOn} title="Toggle depth map (D)">
            Depth
          </button>
        )}
      </div>
{view === "reveal" && render?.url && (
      <div className="chips top-right">
        <a className="chip dl-chip" href={render.url} download={`mogfield-video-${render.take}.mp4`} {...saveToPhotos(render.url, `mogfield-video-${render.take}.mp4`)} title="Download this video">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
          Download
        </a>
      </div>
      )}
{view === "live" && (
      <div className="chips top-right">
        <span className="chip">{dir.aspect === "native" ? "Original" : dir.aspect === "0.5625" ? "9:16" : dir.aspect === "1.78" ? "16:9" : `${dir.aspect}:1`}</span>
      </div>
      )}
      {depthOn && (
        <div className="depth-legend" aria-hidden>
          <span>Far</span>
          <i />
          <span>Near</span>
        </div>
      )}
      {view === "live" && <div className="time">{tc(time)}{!playing && " · Paused"}</div>}
      {!clip && <div className="no-signal">Add a video to start</div>}
    </div>
  );
});
