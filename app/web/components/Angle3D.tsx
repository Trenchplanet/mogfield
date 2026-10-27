import { useRef } from "react";
import { DEFAULT_VIEW, type ReshootView } from "../../server/shared";

/** The 3D angle picker for Re-shoot: the take stands in the middle, the camera is a
 *  sphere you drag around it. Drag to move it round and up or down, scroll (or the
 *  slider) to move it closer or further, arrow keys nudge it. */

const YAW = (-28 * Math.PI) / 180;
const PITCH = (24 * Math.PI) / 180;
const W = 360;
const H = 300;
const CX = W / 2;
const CY = 156;
const S = 92; // pixels per world unit
const RING = 1.45; // radius of the floor ring and of the camera orbit
const FLOOR = -0.62;

const rad = (d: number) => (d * Math.PI) / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** World (x right, y up, z towards the original camera) to screen, orthographic. */
function project(x: number, y: number, z: number) {
  const x1 = x * Math.cos(YAW) + z * Math.sin(YAW);
  const z1 = -x * Math.sin(YAW) + z * Math.cos(YAW);
  const y2 = y * Math.cos(PITCH) - z1 * Math.sin(PITCH);
  return { sx: CX + x1 * S, sy: CY - y2 * S, depth: y * Math.sin(PITCH) + z1 * Math.cos(PITCH) };
}

/** Where the camera sits for a view: on a sphere round the subject. */
function cameraAt(v: ReshootView) {
  const az = rad(v.azimuth);
  const el = rad(v.elevation);
  return [RING * Math.cos(el) * Math.sin(az), RING * Math.sin(el), RING * Math.cos(el) * Math.cos(az)] as const;
}

const ring = Array.from({ length: 73 }, (_, i) => {
  const a = (i / 72) * Math.PI * 2;
  const p = project(RING * Math.sin(a), FLOOR, RING * Math.cos(a));
  return `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`;
}).join(" ");

export function viewLabel(v: ReshootView) {
  const az = Math.round(Math.abs(v.azimuth));
  const side = v.azimuth < 0 ? "left" : "right";
  const round = az < 6 ? "Front" : az > 174 ? "Behind" : `${az}° ${side}`;
  const height = v.elevation >= 75 ? "top-down" : v.elevation >= 12 ? `${Math.round(v.elevation)}° up` : v.elevation <= -12 ? `${Math.round(-v.elevation)}° low` : "eye level";
  const range = v.distance <= 0.25 ? "close" : v.distance >= 0.75 ? "wide" : "medium";
  return `${round} · ${height} · ${range}`;
}

export function Angle3D(p: { view: ReshootView; onChange: (v: ReshootView) => void; videoUrl?: string; disabled?: boolean }) {
  const { view } = p;
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef(false);

  const cam = cameraAt(view);
  const camP = project(...cam);
  const foot = project(cam[0], FLOOR, cam[2]);
  const orig = project(...cameraAt({ azimuth: 0, elevation: 0, distance: 0 }));
  // the arc the camera rides up and down, in the plane of its current azimuth
  const arc = Array.from({ length: 31 }, (_, i) => {
    const e = -30 + (i / 30) * 120;
    const q = project(...cameraAt({ azimuth: view.azimuth, elevation: e, distance: 0 }));
    return `${q.sx.toFixed(1)},${q.sy.toFixed(1)}`;
  }).join(" ");

  /** The point on the camera sphere nearest the pointer; ties go to the side already chosen. */
  const pick = (clientX: number, clientY: number) => {
    const box = svg.current!.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * W;
    const py = ((clientY - box.top) / box.height) * H;
    let best = { az: view.azimuth, el: view.elevation, cost: Infinity };
    for (let az = -180; az <= 180; az += 3) {
      for (let el = -30; el <= 90; el += 3) {
        const q = project(...cameraAt({ azimuth: az, elevation: el, distance: 0 }));
        const dAz = Math.min(Math.abs(az - view.azimuth), 360 - Math.abs(az - view.azimuth));
        const cost = (q.sx - px) ** 2 + (q.sy - py) ** 2 + 0.6 * (dAz * dAz + (el - view.elevation) ** 2) * 0.05;
        if (cost < best.cost) best = { az, el, cost };
      }
    }
    p.onChange({ ...view, azimuth: best.az, elevation: best.el });
  };

  const nudge = (key: string) => {
    const step = 5;
    const next = { ...view };
    if (key === "ArrowLeft") next.azimuth = ((view.azimuth - step + 540) % 360) - 180;
    else if (key === "ArrowRight") next.azimuth = ((view.azimuth + step + 540) % 360) - 180;
    else if (key === "ArrowUp") next.elevation = clamp(view.elevation + step, -30, 90);
    else if (key === "ArrowDown") next.elevation = clamp(view.elevation - step, -30, 90);
    else return false;
    p.onChange(next);
    return true;
  };

  // the marker is bigger and brighter the closer the shot
  const markerR = 11 - view.distance * 3;

  return (
    <div className={`a3d ${p.disabled ? "off" : ""}`}>
      <div className="a3d-head">
        <b>3D angle</b>
        <span>{viewLabel(view)}</span>
        <button type="button" className="a3d-reset" onClick={() => p.onChange(DEFAULT_VIEW)} disabled={p.disabled}>Reset</button>
      </div>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="a3d-stage"
        role="slider"
        tabIndex={0}
        aria-label="Camera position. Drag, or use the arrow keys."
        aria-valuetext={viewLabel(view)}
        onPointerDown={(e) => {
          if (p.disabled) return;
          drag.current = true;
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          pick(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => drag.current && pick(e.clientX, e.clientY)}
        onPointerUp={() => (drag.current = false)}
        onPointerCancel={() => (drag.current = false)}
        onWheel={(e) => !p.disabled && p.onChange({ ...view, distance: clamp(view.distance + (e.deltaY > 0 ? 0.05 : -0.05), 0, 1) })}
        onKeyDown={(e) => !p.disabled && nudge(e.key) && e.preventDefault()}
      >
        <polyline points={ring} className="a3d-ring" />
        <polyline points={arc} className="a3d-arc" />
        {/* the take, standing in the middle */}
        <g transform={`matrix(${((Math.cos(YAW) * S) / 100).toFixed(4)} ${((-Math.sin(YAW) * Math.sin(PITCH) * S) / 100).toFixed(4)} 0 ${((Math.cos(PITCH) * S) / 100).toFixed(4)} ${CX} ${CY})`}>
          <rect x={-50} y={-62} width={100} height={124} rx={5} className="a3d-plane" />
          {p.videoUrl && (
            <foreignObject x={-50} y={-62} width={100} height={124}>
              <video src={p.videoUrl} muted playsInline preload="auto" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 5, display: "block" }} />
            </foreignObject>
          )}
        </g>
        <circle cx={orig.sx} cy={orig.sy} r={3} className="a3d-orig" />
        <text x={orig.sx + 7} y={orig.sy + 3} className="a3d-tag">original</text>
        <line x1={foot.sx} y1={foot.sy} x2={camP.sx} y2={camP.sy} className="a3d-drop" />
        <circle cx={foot.sx} cy={foot.sy} r={2.5} className="a3d-foot" />
        <line x1={camP.sx} y1={camP.sy} x2={CX} y2={CY} className="a3d-beam" />
        <circle cx={camP.sx} cy={camP.sy} r={markerR} className="a3d-cam" />
        <circle cx={camP.sx} cy={camP.sy} r={markerR * 0.38} className="a3d-lens" />
      </svg>
      <label className="a3d-dist">
        <span>Close</span>
        <input type="range" min={0} max={1} step={0.05} value={view.distance} disabled={p.disabled} onChange={(e) => p.onChange({ ...view, distance: Number(e.target.value) })} aria-label="Camera distance" />
        <span>Wide</span>
      </label>
    </div>
  );
}
