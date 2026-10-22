import type { Aspect, CameraPreset, LensName } from "../server/shared";

export interface Direction {
  camera: CameraPreset;
  cameraStrength: number;
  lens: LensName;
  fStop: number;
  focus: number;
  rackFocus: boolean;
  focusEnd: number;
  lut: string;
  lutStrength: number;
  grain: number;
  halation: number;
  aspect: Aspect;
  /** Which sections are switched on. Off sections keep their settings but apply nothing. */
  on: Record<Section, boolean>;
}

export type Section = "camera" | "lens" | "color" | "frame";

export const DEFAULT_DIRECTION: Direction = {
  camera: "dolly_in",
  cameraStrength: 1,
  lens: "40mm anamorphic",
  fStop: 2.0,
  focus: 0.7,
  rackFocus: false,
  focusEnd: 0.2,
  lut: "tungsten_night.cube",
  lutStrength: 0.85,
  grain: 0.035,
  halation: 0.35,
  aspect: "2.39",
  on: { camera: false, lens: false, color: false, frame: false },
};

/** The settings that actually apply: off sections fall back to "as shot".
 *  Recast never moves the camera — its camera motion comes from the take. */
export function effective(d: Direction, mode: "direct" | "recast"): Direction {
  const camera = d.on.camera && mode === "direct";
  return {
    ...d,
    camera: camera ? d.camera : "static",
    cameraStrength: camera ? d.cameraStrength : 0,
    lens: d.on.lens ? d.lens : "24mm",
    fStop: d.on.lens ? d.fStop : 16,
    rackFocus: d.on.lens && d.rackFocus,
    lut: d.on.color ? d.lut : "none",
    lutStrength: d.on.color ? d.lutStrength : 0,
    grain: d.on.color ? d.grain : 0,
    halation: d.on.color ? d.halation : 0,
    aspect: d.on.frame ? d.aspect : "native",
  };
}

export const F_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];
