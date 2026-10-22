import { useEffect, useRef, useState } from "react";
import type { PersonBox } from "../../server/shared";

const MAX_PEOPLE = 4;

/** Pick who SAM 3 tracks: scrub to a frame, drag a box around each person. Box 1 = character 1. */
export function PeoplePicker(p: {
  src: string;
  aspect: number; // width / height
  start: number; // trim start in the clip, seconds
  duration: number; // length of the take, seconds
  at: number; // seconds into the take
  setAt: (t: number) => void;
  boxes: PersonBox[];
  setBoxes: (b: PersonBox[]) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    const v = video.current;
    if (v && Math.abs(v.currentTime - (p.start + p.at)) > 0.02) v.currentTime = p.start + p.at;
  }, [p.start, p.at]);

  const point = (e: React.PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const toBox = (d: NonNullable<typeof draft>): PersonBox => ({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) });
  const full = p.boxes.length >= MAX_PEOPLE;

  return (
    <div className="pp">
      <div className="pp-frame" style={{ aspectRatio: String(p.aspect), ["--ar" as string]: String(p.aspect) }}>
        <video ref={video} src={`${p.src}#t=${(p.start + p.at).toFixed(2)}`} muted playsInline preload="auto" />
        <div
          ref={area}
          className={`pp-area ${full ? "full" : ""}`}
          onPointerDown={(e) => {
            if (full) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const q = point(e);
            setDraft({ x0: q.x, y0: q.y, x1: q.x, y1: q.y });
          }}
          onPointerMove={(e) => {
            if (!draft) return;
            const q = point(e);
            setDraft({ ...draft, x1: q.x, y1: q.y });
          }}
          onPointerUp={() => {
            if (!draft) return;
            const b = toBox(draft);
            setDraft(null);
            if (b.w >= 0.02 && b.h >= 0.02) p.setBoxes([...p.boxes, b]);
          }}
          onPointerCancel={() => setDraft(null)}
        >
          {p.boxes.map((b, i) => (
            <div key={i} className="pp-box" style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}>
              <span>{i + 1}</span>
            </div>
          ))}
          {draft && (() => {
            const b = toBox(draft);
            return <div className="pp-box draft" style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }} />;
          })()}
          {!p.boxes.length && !draft && <div className="pp-hint">Drag a box around the person to swap</div>}
        </div>
      </div>
      <label className="pp-scrub">
        <span>Frame {p.at.toFixed(1)} s</span>
        <input type="range" min={0} max={Math.max(0, p.duration - 0.05)} step={1 / 24} value={p.at} onChange={(e) => { p.setAt(Number(e.target.value)); p.setBoxes([]); }} aria-label="Frame to draw on" />
      </label>
      <small className="pp-note">Pick a moment where everyone you want swapped is clearly visible. Moving the slider clears the boxes.</small>
      {p.boxes.length > 0 && (
        <div className="pp-list">
          {p.boxes.map((_, i) => (
            <span key={i} className="pp-chip">
              Person {i + 1} → character {i + 1}
              <button onClick={() => p.setBoxes(p.boxes.filter((__, k) => k !== i))} aria-label={`Remove person ${i + 1}`}>×</button>
            </span>
          ))}
          {full && <small className="pp-note">Up to {MAX_PEOPLE} people.</small>}
        </div>
      )}
    </div>
  );
}
