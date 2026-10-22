import { useEffect, useRef, useState } from "react";
import type { Clip, DepthJob } from "../../server/shared";

export interface Trim {
  start: number;
  end: number;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** Shortens camera-roll style names ("Hf_20261017_073211_d5339c83-…") for a card label. */
export function shortName(name: string) {
  const clean = name.replace(/[_-]+/g, " ").trim();
  if (/^[a-z]{0,4}\s?\d{6,}/i.test(clean) || clean.length > 28) return clean.length > 28 ? `${clean.slice(0, 24)}…` : clean;
  return clean;
}

/**
 * The trim being dragged stays inside the card and only reaches the app when the
 * handle is let go, so a drag re-renders the card, not the whole page.
 */
function useTrimDraft(trim: Trim, onTrim: (t: Trim) => void) {
  const [draft, setDraft] = useState<Trim | null>(null);
  const draftRef = useRef<Trim | null>(null);
  const change = (t: Trim) => {
    draftRef.current = t;
    setDraft(t);
  };
  const commit = () => {
    if (draftRef.current) onTrim(draftRef.current);
    draftRef.current = null;
    setDraft(null);
  };
  return { shown: draft ?? trim, change, commit };
}

/**
 * A looping, muted preview of [trim.start, trim.end). While a handle is dragged it
 * shows `focus`; seeks are coalesced so the decoder only ever works on the latest one.
 * The loop and the playhead run on animation frames, not React renders.
 */
function LoopVideo({ src, trim, focus, playing, onHead, onBlocked, videoRef }: { src: string; trim: Trim; focus: number | null; playing: boolean; onHead?: (t: number) => void; onBlocked?: () => void; videoRef?: React.RefObject<HTMLVideoElement | null> }) {
  const own = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? own;
  const pending = useRef<number | null>(null);
  const live = useRef({ trim, focus, onHead });
  live.current = { trim, focus, onHead };

  const seek = (v: HTMLVideoElement, t: number) => {
    if (v.seeking) pending.current = t;
    else v.currentTime = t;
  };

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (focus !== null) {
      v.pause();
      seek(v, focus);
      return;
    }
    if (v.currentTime < trim.start || v.currentTime > trim.end) seek(v, trim.start);
    // `playing` is what the button asks for; only a blocked autoplay flips it back
    if (playing) void v.play().catch((e: Error) => e.name === "NotAllowedError" && onBlocked?.());
    else v.pause();
  }, [focus, trim.start, trim.end, playing, ref]);

  // keep the loop inside the trim and move the playhead
  const step = () => {
    const v = ref.current;
    if (!v) return;
    const { trim: t, focus: f, onHead: head } = live.current;
    if (f === null && !v.paused && !v.seeking && (v.currentTime >= t.end - 0.03 || v.currentTime < t.start - 0.1)) seek(v, t.start);
    head?.(f ?? v.currentTime);
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      stepRef.current();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <video
      ref={ref}
      src={src}
      muted
      playsInline
      autoPlay
      loop
      preload="auto"
      // animation frames stop in background tabs; timeupdate still fires there
      onTimeUpdate={step}
      onSeeked={(e) => {
        const t = pending.current;
        pending.current = null;
        if (t !== null) e.currentTarget.currentTime = t;
      }}
    />
  );
}

const PlayIcon = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>;
const PauseIcon = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><rect x="6" y="5" width="4.5" height="14" rx="1.2" /><rect x="13.5" y="5" width="4.5" height="14" rx="1.2" /></svg>;

export function TrimBar({ duration, trim, onTrim, onRelease, poster, headRef, playing, onTogglePlay, onFocus, maxLen = 30 }: { duration: number; trim: Trim; onTrim: (t: Trim) => void; onRelease: () => void; poster?: string; headRef: React.RefObject<HTMLDivElement | null>; playing: boolean; onTogglePlay: () => void; onFocus: (t: number | null) => void; maxLen?: number }) {
  const minLen = Math.min(4, duration);
  const step = 0.1;
  const pct = (t: number) => `${(t / Math.max(duration, 0.001)) * 100}%`;
  const release = () => {
    onFocus(null);
    onRelease();
  };
  return (
    <div className="trim" onClick={(e) => e.stopPropagation()}>
      <div className="trim-row">
        <button type="button" className="trim-play" onClick={onTogglePlay} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="trim-track" style={poster ? { backgroundImage: `url(${poster})` } : undefined}>
          <div className="trim-shade" style={{ left: 0, width: pct(trim.start) }} />
          <div className="trim-shade" style={{ left: pct(trim.end), right: 0 }} />
          <div className="trim-window" style={{ left: pct(trim.start), width: `calc(${pct(trim.end)} - ${pct(trim.start)})` }} />
          <div className="trim-head" ref={headRef} style={{ left: pct(trim.start) }} />
          <input
            type="range"
            aria-label="Trim start"
            min={0}
            max={duration}
            step={step}
            value={trim.start}
            onChange={(e) => {
              const s = Math.max(0, Math.min(Number(e.target.value), trim.end - minLen));
              // the window can be at most maxLen long: dragging the start pulls the end along
              onTrim({ start: s, end: Math.min(trim.end, s + maxLen) });
              onFocus(s);
            }}
            onPointerUp={release}
            onKeyUp={release}
            onBlur={release}
          />
          <input
            type="range"
            aria-label="Trim end"
            min={0}
            max={duration}
            step={step}
            value={trim.end}
            onChange={(e) => {
              const v = Math.min(duration, Math.max(Number(e.target.value), trim.start + minLen));
              onTrim({ start: Math.max(trim.start, v - maxLen), end: v });
              onFocus(Math.max(trim.start, v - 0.4));
            }}
            onPointerUp={release}
            onKeyUp={release}
            onBlur={release}
          />
        </div>
      </div>
      <div className="trim-labels">
        <span>{fmt(trim.start)}</span>
        <b>{(trim.end - trim.start).toFixed(1)}s</b>
        <span>{fmt(trim.end)}</span>
      </div>
    </div>
  );
}

/** Everything a card needs to drive one looping preview and its TrimBar. */
function useTrimmedPreview(clip: Clip, trim: Trim, onTrim: (t: Trim) => void) {
  const { shown, change, commit } = useTrimDraft(trim, onTrim);
  const [focus, setFocus] = useState<number | null>(null);
  const [playing, setPlaying] = useState(true);
  const headRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const onHead = (t: number) => {
    const h = headRef.current;
    if (!h) return;
    const { start, end } = shownRef.current;
    h.style.left = `${(Math.min(end, Math.max(start, t)) / Math.max(clip.duration, 0.001)) * 100}%`;
  };
  const video = { trim: shown, focus, playing, onHead, onBlocked: () => setPlaying(false) };
  const bar = { duration: clip.duration, trim: shown, onTrim: change, onRelease: commit, poster: clip.poster, headRef, playing, onTogglePlay: () => setPlaying((p) => !p), onFocus: setFocus };
  return { video, bar };
}

/** Easy: the take as a small tilted card that loops the trimmed section. */
export function EasyVideoCard({ clip, trim, onTrim, onReplace, maxLen }: { clip: Clip; trim: Trim; onTrim: (t: Trim) => void; onReplace: () => void; maxLen: number }) {
  const { video, bar } = useTrimmedPreview(clip, trim, onTrim);
  return (
    <div className="video-card easy">
      <div className="tilt-card" style={{ ["--ar" as string]: String(clip.width / clip.height) }}>
        <LoopVideo src={clip.url} {...video} />
        <button className="tilt-meta" onClick={onReplace}>Replace</button>
      </div>
      <TrimBar {...bar} maxLen={maxLen} />
    </div>
  );
}

/** Pro: the take and its depth map side by side, both looping the trimmed section in sync. */
export function ProVideoCard({ clip, trim, onTrim, onReplace, depthJob, maxLen }: { clip: Clip; trim: Trim; onTrim: (t: Trim) => void; onReplace: () => void; depthJob: DepthJob | null; maxLen: number }) {
  const { video, bar } = useTrimmedPreview(clip, trim, onTrim);
  const main = useRef<HTMLVideoElement>(null);
  const depth = useRef<HTMLVideoElement>(null);

  // the depth tile follows the picture
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const a = main.current;
      const b = depth.current;
      if (!a || !b || b.readyState < 2) return;
      if (Math.abs(a.currentTime - b.currentTime) > 0.08) b.currentTime = a.currentTime;
      if (a.paused !== b.paused) a.paused ? b.pause() : void b.play().catch(() => {});
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clip.depthUrl]);

  const running = depthJob?.status === "running";
  return (
    <div className="video-card pro">
      <div className="pair" style={{ ["--ar" as string]: String(clip.width / clip.height) }}>
        <div className="pair-tile">
          <LoopVideo src={clip.url} {...video} videoRef={main} />
          <span className="chip pair-label">Original</span>
        </div>
        <div className="pair-tile">
          {clip.depthUrl ? (
            <>
              <video ref={depth} src={clip.depthUrl} muted playsInline autoPlay loop />
              <span className="chip pair-label">Depth</span>
            </>
          ) : (
            <div className="pair-wait">
              <span>{running ? `Mapping depth ${Math.round((depthJob?.progress ?? 0) * 100)}%` : depthJob?.status === "failed" ? "Depth failed" : "Preparing depth…"}</span>
              <span className="depth-bar"><i style={{ width: `${Math.round((depthJob?.progress ?? 0) * 100)}%` }} /></span>
            </div>
          )}
        </div>
      </div>
      <div className="video-card-meta">
        <span className="row-text">
          <b title={clip.name}>{shortName(clip.name)}</b>
          <small>{clip.duration.toFixed(1)}s · {clip.width}×{clip.height}</small>
        </span>
        <button className="small" onClick={onReplace}>Replace</button>
      </div>
      <TrimBar {...bar} maxLen={maxLen} />
    </div>
  );
}
