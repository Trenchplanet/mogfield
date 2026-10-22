import { useEffect, useMemo, useState } from "react";
import { ASPECTS, CAMERA_PRESETS, LENSES, type CameraPreset, type LensName } from "../../server/shared";
import { PRESET_LABEL, pathPoints } from "../camera";
import { applyLutPixel, loadLut, lutLabel } from "../lut";
import { F_STOPS, type Direction } from "../state";

type Set = (patch: Partial<Direction>) => void;

// ------------------------------------------------------------ lens

export function LensCarousel({ dir, set }: { dir: Direction; set: Set }) {
  const names = Object.keys(LENSES) as LensName[];
  return (
    <div className="chip-row" role="radiogroup" aria-label="Lens">
      {names.map((n) => {
        const l = LENSES[n];
        const active = n === dir.lens;
        return (
          <button
            key={n}
            role="radio"
            aria-checked={active}
            className={`opt ${active ? "on" : ""}`}
            onClick={() => set({ lens: n, fStop: Math.max(dir.fStop, l.tstop) })}
            title={n}
          >
            {l.focal}mm{l.squeeze > 1 && <small>Ana</small>}
          </button>
        );
      })}
    </div>
  );
}

export function ApertureRing({ dir, set }: { dir: Direction; set: Set }) {
  const minT = LENSES[dir.lens].tstop;
  const stops = F_STOPS.filter((s) => s >= minT - 0.01);
  if (!stops.includes(minT)) stops.unshift(minT);
  return (
    <div className="field-block">
      <span className="field-label">Aperture</span>
      <div className="chip-row" role="radiogroup" aria-label="Aperture">
        {stops.map((s) => (
          <button key={s} role="radio" aria-checked={Math.abs(s - dir.fStop) < 0.05} className={`opt ${Math.abs(s - dir.fStop) < 0.05 ? "on" : ""}`} onClick={() => set({ fStop: s })}>
            f/{s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ move picker

function PathPreview({ preset, strength }: { preset: CameraPreset; strength: number }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      // rAF timestamps can predate `start` on the first frame
      setT((Math.max(0, now - start) / 2200) % 1.25);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [preset]);
  const pts = useMemo(() => pathPoints(preset, strength), [preset, strength]);
  // isometric projection
  const iso = (p: { x: number; y: number; z: number }) => ({ x: 100 + (p.x - p.z) * 30, y: 74 + (p.x + p.z) * 15 - p.y * 34 });
  const d = pts.map((p, i) => `${i ? "L" : "M"}${iso(p).x.toFixed(1)},${iso(p).y.toFixed(1)}`).join(" ");
  const cur = iso(pts[Math.max(0, Math.min(pts.length - 1, Math.floor(Math.min(1, t) * (pts.length - 1))))]);
  const subj = iso({ x: 0, y: 0, z: 0 });
  const grid = [];
  for (let i = -3; i <= 3; i++) {
    const a = iso({ x: i, y: 0, z: -3 });
    const b = iso({ x: i, y: 0, z: 3 });
    const c = iso({ x: -3, y: 0, z: i });
    const e = iso({ x: 3, y: 0, z: i });
    grid.push(<line key={`x${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />, <line key={`z${i}`} x1={c.x} y1={c.y} x2={e.x} y2={e.y} />);
  }
  return (
    <svg className="path-preview" viewBox="0 0 200 130" aria-label={`${PRESET_LABEL[preset]} camera path`}>
      <g className="floor">{grid}</g>
      <g className="subject">
        <ellipse cx={subj.x} cy={subj.y} rx="7" ry="3.5" />
        <rect x={subj.x - 3.5} y={subj.y - 22} width="7" height="22" rx="3" />
        <circle cx={subj.x} cy={subj.y - 26} r="4" />
      </g>
      <path d={d} className="cam-path" />
      <g transform={`translate(${cur.x},${cur.y}) scale(1.5)`} className="cam-body">
        <circle r="4" />
      </g>
      <line x1={cur.x} y1={cur.y} x2={subj.x} y2={subj.y - 14} className="sightline" />
    </svg>
  );
}

export function MovePicker({ dir, set }: { dir: Direction; set: Set }) {
  return (
    <div className="move-picker">
      <PathPreview preset={dir.camera} strength={dir.cameraStrength} />
      <div className="move-grid" role="radiogroup" aria-label="Camera move">
        {CAMERA_PRESETS.map((p) => (
          <button key={p} role="radio" aria-checked={dir.camera === p} className={dir.camera === p ? "active" : ""} onClick={() => set({ camera: p })}>
            {PRESET_LABEL[p]}
          </button>
        ))}
      </div>
      <Slider label="Intensity" value={dir.cameraStrength} min={0} max={2} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ cameraStrength: v })} />
    </div>
  );
}

// ------------------------------------------------------------ grade

function useSwatch(lut: string, posterUrl: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!posterUrl) return;
    let live = true;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = posterUrl;
    img.onload = async () => {
      const W = 96, H = 54;
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const g = c.getContext("2d")!;
      const s = Math.max(W / img.width, H / img.height);
      g.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
      if (lut !== "none") {
        const l = await loadLut(lut);
        const d = g.getImageData(0, 0, W, H);
        for (let i = 0; i < d.data.length; i += 4) {
          const [r, gg, b] = applyLutPixel(l, d.data[i] / 255, d.data[i + 1] / 255, d.data[i + 2] / 255);
          d.data[i] = r * 255;
          d.data[i + 1] = gg * 255;
          d.data[i + 2] = b * 255;
        }
        g.putImageData(d, 0, 0);
      }
      if (live) setUrl(c.toDataURL());
    };
    return () => {
      live = false;
    };
  }, [lut, posterUrl]);
  return url;
}

function Swatch({ lut, poster, active, onClick }: { lut: string; poster?: string; active: boolean; onClick: () => void }) {
  const url = useSwatch(lut, poster);
  return (
    <button className={`swatch ${active ? "active" : ""}`} onClick={onClick} aria-pressed={active}>
      <span className="swatch-img" style={url ? { backgroundImage: `url(${url})` } : undefined} />
      <span className="swatch-label">{lut === "none" ? "Natural" : lutLabel(lut)}</span>
    </button>
  );
}

export function GradePanel({ dir, set, luts, poster }: { dir: Direction; set: Set; luts: string[]; poster?: string }) {
  return (
    <div className="grade">
      <div className="swatches">
        {["none", ...luts].map((l) => (
          <Swatch key={l} lut={l} poster={poster} active={dir.lut === l} onClick={() => set({ lut: l })} />
        ))}
      </div>
      <Slider label="Strength" value={dir.lutStrength} min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ lutStrength: v })} />
      <Slider label="Glow" value={dir.halation} min={0} max={1.2} step={0.05} fmt={(v) => `${Math.round((v / 1.2) * 100)}%`} onChange={(v) => set({ halation: v })} />
      <Slider label="Grain" value={dir.grain} min={0} max={0.15} step={0.005} fmt={(v) => `${Math.round((v / 0.15) * 100)}%`} onChange={(v) => set({ grain: v })} />
    </div>
  );
}

export function FocusPanel({ dir, set }: { dir: Direction; set: Set }) {
  return (
    <div className="focus-panel">
      <Slider label="Focus" value={dir.focus} min={0} max={1} step={0.01} fmt={(v) => (v > 0.66 ? "Near" : v > 0.33 ? "Mid" : "Far")} onChange={(v) => set({ focus: v })} />
      <label className="toggle">
        <input type="checkbox" checked={dir.rackFocus} onChange={(e) => set({ rackFocus: e.target.checked })} />
        <span>Rack focus</span>
      </label>
      {dir.rackFocus && (
        <Slider label="To" value={dir.focusEnd} min={0} max={1} step={0.01} fmt={(v) => (v > 0.66 ? "Near" : v > 0.33 ? "Mid" : "Far")} onChange={(v) => set({ focusEnd: v })} />
      )}
    </div>
  );
}

export function AspectPicker({ dir, set }: { dir: Direction; set: Set }) {
  const label: Record<string, string> = { "2.39": "2.39", "1.85": "1.85", "1.78": "16:9", "0.5625": "9:16" };
  return (
    <div className="aspect-picker" role="radiogroup" aria-label="Aspect ratio">
      {ASPECTS.map((a) => (
        <button key={a} role="radio" aria-checked={dir.aspect === a} className={dir.aspect === a ? "active" : ""} onClick={() => set({ aspect: a })}>
          {label[a]}
        </button>
      ))}
    </div>
  );
}

export function Slider(p: { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="slider">
      <span className="slider-label">{p.label}</span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
      <span className="slider-value">{p.fmt(p.value)}</span>
    </label>
  );
}
