import { cameraPose, ease, LENSES, type CameraPreset, type LensName } from "../server/shared";

/** 2D preview of a camera move, matching the preview engine's ffmpeg pass:
 *  zoom >= 1 and a pan in uv units within the available margin. */
export function previewTransform(preset: CameraPreset, strength: number, lens: LensName, t: number) {
  const focal = Math.max(1, LENSES[lens].focal / 24);
  const s = strength;
  const so = Math.min(1, s);
  const e = ease(Math.min(1, Math.max(0, t)));
  const headroom = ["static", "dolly_in", "dolly_out", "push_tilt_up"].includes(preset) ? 1 : 1 + 0.15 * Math.max(0.5, s);
  let zoom = focal * headroom;
  let px = 0;
  let py = 0;
  const sweep = (dir: number) => 0.9 * so * dir * (1 - 2 * e);
  switch (preset) {
    case "dolly_in": zoom *= 1 + 0.4 * s * e; break;
    case "dolly_out": zoom *= 1 + 0.35 * s * (1 - e); break;
    case "push_tilt_up": zoom *= 1 + 0.25 * s * e; py = sweep(0.6); break;
    case "truck_left": case "orbit_left": px = sweep(1); break;
    case "truck_right": case "orbit_right": px = sweep(-1); break;
    case "crane_up": py = sweep(1); break;
    case "crane_down": py = sweep(-1); break;
    case "handheld": {
      const on = t * 120;
      px = 0.6 * so * (Math.sin(on * 0.071 + 1.1) * 0.7 + Math.sin(on * 0.19 + 2.3) * 0.3);
      py = 0.6 * so * (Math.sin(on * 0.063 + 0.4) * 0.7 + Math.sin(on * 0.17 + 4.0) * 0.3);
      break;
    }
  }
  const margin = (1 - 1 / zoom) / 2;
  return { zoom, pan: [px * margin, py * margin] as [number, number] };
}

export const PRESET_LABEL: Record<CameraPreset, string> = {
  static: "Sticks",
  dolly_in: "Dolly in",
  dolly_out: "Dolly out",
  truck_left: "Truck L",
  truck_right: "Truck R",
  orbit_left: "Orbit L",
  orbit_right: "Orbit R",
  crane_up: "Crane up",
  crane_down: "Crane down",
  push_tilt_up: "Push + tilt",
  handheld: "Handheld",
};

/** 3D camera positions along the path, for the isometric path preview. */
export function pathPoints(preset: CameraPreset, strength: number, n = 32) {
  return Array.from({ length: n }, (_, i) => {
    const p = cameraPose(preset, i / (n - 1), strength);
    // orbit: swing around the subject rather than slide
    if (preset.startsWith("orbit")) {
      const ang = (p.tx / 0.16) * 0.9;
      return { x: Math.sin(ang) * 1.6, y: 0, z: -1.6 + (1 - Math.cos(ang)) * 1.6 };
    }
    return { x: -p.tx * 8 - p.yaw * 4, y: p.ty * 8 + p.pitch * 3, z: -1.6 + p.tz * 4 };
  });
}
