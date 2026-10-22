// The no-GPU engine: an ffmpeg finishing pass that approximates the Direct
// controls (camera move as a 2D push/pan, focal crop, LUT, vignette, grain,
// mattes). It has no depth, so there is no parallax or depth of field - those
// come from the comfyui-backlot nodes on the Comfy target.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { LUT_DIR } from "../config.js";
import { ffmpegWithProgress, probe } from "../media.js";
import { LENSES, type RenderParams } from "../shared.js";
import type { Engine, EngineHooks } from "./types.js";

const E = "(PP*PP*(3-2*PP))"; // smoothstep of PP, PP substituted below

function moveExprs(p: RenderParams, frames: number) {
  const s = p.cameraStrength;
  const so = Math.min(1, s);
  const pp = `min(on/${Math.max(1, frames - 1)},1)`;
  const e = E.replaceAll("PP", pp);
  const focal = Math.max(1, LENSES[p.lens].focal / 24);
  const headroom = ["static", "dolly_in", "dolly_out", "push_tilt_up"].includes(p.camera) ? 1 : 1 + 0.15 * Math.max(0.5, s);
  const zb = (focal * headroom).toFixed(4);
  const cx = "(iw-iw/zoom)/2";
  const cy = "(ih-ih/zoom)/2";
  let z = zb;
  let x = cx;
  let y = cy;
  const sweep = (dir: number) => `(${0.9 * so * dir}*(1-2*${e}))`;
  switch (p.camera) {
    case "dolly_in": z = `${zb}*(1+${0.4 * s}*${e})`; break;
    case "dolly_out": z = `${zb}*(1+${0.35 * s}*(1-${e}))`; break;
    case "push_tilt_up": z = `${zb}*(1+${0.25 * s}*${e})`; y = `${cy}*(1+${sweep(0.6)})`; break;
    case "truck_left": case "orbit_left": x = `${cx}*(1+${sweep(1)})`; break;
    case "truck_right": case "orbit_right": x = `${cx}*(1+${sweep(-1)})`; break;
    case "crane_up": y = `${cy}*(1+${sweep(1)})`; break;
    case "crane_down": y = `${cy}*(1+${sweep(-1)})`; break;
    case "handheld":
      x = `${cx}*(1+${0.6 * so}*(sin(on*0.071+1.1)*0.7+sin(on*0.19+2.3)*0.3))`;
      y = `${cy}*(1+${0.6 * so}*(sin(on*0.063+0.4)*0.7+sin(on*0.17+4.0)*0.3))`;
      break;
  }
  return { z, x, y };
}

export function buildFilter(p: RenderParams, w: number, h: number, fps: number, frames: number): string {
  const { z, x, y } = moveExprs(p, frames);
  const chain: string[] = [];
  // upscale first so zoompan's integer crop offsets do not judder
  chain.push(`[0:v]scale=${w * 2}:${h * 2}:flags=bicubic,zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${w}x${h}:fps=${fps}[cam]`);
  let last = "cam";
  const lutPath = join(LUT_DIR, p.lut);
  if (p.lut !== "none" && existsSync(lutPath) && p.lutStrength > 0) {
    const esc = lutPath.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
    chain.push(`[${last}]split[o][g];[g]lut3d=file='${esc}':interp=tetrahedral[gl];[o][gl]blend=all_expr='A*${(1 - p.lutStrength).toFixed(3)}+B*${p.lutStrength.toFixed(3)}'[graded]`);
    last = "graded";
  }
  const post: string[] = [];
  post.push(`vignette=angle=${(0.35 + 0.5 * Math.min(1, p.halation + 0.2)).toFixed(3)}`);
  if (p.grain > 0) post.push(`noise=c0s=${Math.round(p.grain * 260)}:c0f=t+u`);
  const aspect = p.aspect === "native" ? w / h : Number(p.aspect);
  if (w / h < aspect - 0.01) {
    const bar = Math.round((h - w / aspect) / 2);
    post.push(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`, `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`);
  } else if (w / h > aspect + 0.01) {
    const bar = Math.round((w - h * aspect) / 2);
    post.push(`drawbox=x=0:y=0:w=${bar}:h=ih:color=black:t=fill`, `drawbox=x=iw-${bar}:y=0:w=${bar}:h=ih:color=black:t=fill`);
  }
  post.push("format=yuv420p");
  chain.push(`[${last}]${post.join(",")}[out]`);
  return chain.join(";");
}

export const previewEngine: Engine = {
  name: "preview",
  async render(p: RenderParams, clipPath: string, outPath: string, hooks: EngineHooks) {
    const info = await probe(clipPath);
    const fps = Math.round(info.fps) || 24;
    const frames = Math.max(1, Math.round(info.duration * fps));
    if (p.mode === "recast") hooks.message("Rendering camera, lens and color");
    else hooks.message("Rendering");
    const filter = buildFilter(p, info.width, info.height, fps, frames);
    await ffmpegWithProgress(
      ["-i", clipPath, "-filter_complex", filter, "-map", "[out]", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "copy", "-movflags", "+faststart", outPath],
      info.duration,
      hooks.progress,
      hooks.signal,
    );
  },
};
