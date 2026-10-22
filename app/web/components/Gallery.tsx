import { useEffect, useRef, useState } from "react";
import type { Clip, Render } from "../../server/shared";
import { PRESET_LABEL } from "../camera";
import { lutLabel } from "../lut";
import { saveToPhotos } from "../save";

/** Plays only while on screen: a phone on a tunnel can't stream every tile at once. */
function LoopingVideo({ src, poster }: { src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const io = new IntersectionObserver(([e]) => (e.isIntersecting ? void v.play().catch(() => {}) : v.pause()), { threshold: 0.5 });
    io.observe(v);
    return () => io.disconnect();
  }, []);
  return <video ref={ref} src={src} poster={poster} muted loop playsInline preload={poster ? "none" : "metadata"} />;
}

export function Gallery(p: {
  clips: Clip[];
  renders: Render[];
  activeClip: string | null;
  activeRender: string | null;
  onClip: (id: string) => void;
  onRender: (id: string) => void;
}) {
  const takes = p.renders.filter((r) => r.status !== "failed");
  const [tab, setTab] = useState<"samples" | "takes">(takes.length ? "takes" : "samples");
  const clipById = new Map(p.clips.map((c) => [c.id, c]));
  const aspectOf = (id: string) => {
    const c = clipById.get(id);
    return c ? c.width / c.height : 3 / 4;
  };
  return (
    <section className="gallery">
      <div className="pill-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "samples"} className={tab === "samples" ? "on" : ""} onClick={() => setTab("samples")}>
          Samples
        </button>
        <button role="tab" aria-selected={tab === "takes"} className={tab === "takes" ? "on" : ""} onClick={() => setTab("takes")}>
          Your videos {takes.length ? <span className="count">{takes.length}</span> : null}
        </button>
      </div>
      <div className="gallery-grid">
        {tab === "samples" &&
          p.clips.map((c) => (
            <button key={c.id} className={`g-card ${p.activeClip === c.id && !p.activeRender ? "on" : ""}`} style={{ ["--ar" as string]: String(c.width / c.height) }} onClick={() => p.onClip(c.id)}>
              <LoopingVideo src={c.url} poster={c.poster} />
              <span className="g-meta">
                <b>{c.name}</b>
                <small>{c.sample ? "Sample" : "Uploaded"} · {c.duration.toFixed(1)}s</small>
              </span>
            </button>
          ))}
        {tab === "takes" &&
          (takes.length ? (
            takes.map((r) => (
              <div key={r.id} className="g-item" style={{ ["--ar" as string]: String(aspectOf(r.params.clipId)) }}>
              <button className={`g-card ${p.activeRender === r.id ? "on" : ""}`} style={{ ["--ar" as string]: String(aspectOf(r.params.clipId)) }} onClick={() => r.status === "succeeded" && p.onRender(r.id)}>
                {r.status === "succeeded" && r.url ? (
                  <LoopingVideo src={r.url} poster={clipById.get(r.params.clipId)?.poster} />
                ) : (
                  <span className="g-pending">{Math.round(r.progress * 100)}%</span>
                )}
                <span className="g-meta">
                  <b>Video {r.take}</b>
                  <small>
                    {PRESET_LABEL[r.params.camera]} · {r.params.lens} · {r.params.lut === "none" ? "Natural" : lutLabel(r.params.lut)}
                  </small>
                </span>
              </button>
              {r.status === "succeeded" && r.url && (
                <a className="g-dl" href={r.url} download={`mogfield-video-${r.take}.mp4`} {...saveToPhotos(r.url, `mogfield-video-${r.take}.mp4`)} title="Download video" aria-label={`Download video ${r.take}`}>
                  <svg viewBox="0 0 24 24" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
                </a>
              )}
              </div>
            ))
          ) : (
            <p className="g-empty">Nothing yet. Pick a video, choose a camera move and tap Generate.</p>
          ))}
      </div>
    </section>
  );
}
