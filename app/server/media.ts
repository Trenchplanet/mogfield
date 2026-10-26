import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";

export interface Probe {
  width: number;
  height: number;
  duration: number;
  fps: number;
  frames: number;
  hasAudio: boolean;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`))));
  });
}

export async function probe(path: string): Promise<Probe> {
  const out = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path]);
  const j = JSON.parse(out);
  const v = j.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  if (!v) throw new Error("no video stream");
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || "24/1").split("/").map(Number);
  const fps = d ? n / d : n || 24;
  const duration = Number(v.duration ?? j.format.duration ?? 0);
  // phones store rotation as side data; swap dims for portrait takes
  const rot = Math.abs(Number(v.side_data_list?.find((s: { rotation?: number }) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0));
  const swap = rot === 90 || rot === 270;
  return {
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    duration,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 24,
    frames: Number(v.nb_frames) || Math.round(duration * (fps || 24)),
    hasAudio: j.streams.some((s: { codec_type: string }) => s.codec_type === "audio"),
  };
}

export async function poster(video: string, out: string, at = 0.5): Promise<void> {
  await run("ffmpeg", ["-y", "-v", "error", "-ss", String(at), "-i", video, "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", "-q:v", "3", out]);
}

/**
 * Normalise an upload to an H.264 MP4 the browser and every engine can read:
 * max 1280 on the long edge, even dims, 24 fps cap, max 60 s (the trim then
 * picks a window of up to 30 s).
 */
export async function normalise(input: string, out: string): Promise<void> {
  await run("ffmpeg", [
    "-y", "-v", "error", "-i", input, "-t", "60",
    "-vf", "scale='if(gt(iw,ih),trunc(min(1280,iw)/2)*2,-2)':'if(gt(iw,ih),-2,trunc(min(1280,ih)/2)*2)',fps='min(24,source_fps)',format=yuv420p",
    // a keyframe every half second keeps scrubbing and trim previews snappy
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "12", "-keyint_min", "12", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
  ]);
}

/** Run ffmpeg, reporting 0..1 progress against an expected duration. */
export function ffmpegWithProgress(args: string[], duration: number, onProgress: (p: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-v", "error", "-progress", "pipe:1", "-nostats", ...args]);
    let err = "";
    const onAbort = () => p.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort);
    p.stdout.on("data", (d: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m && duration > 0) onProgress(Math.min(0.999, Number(m[1]) / 1e6 / duration));
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-1200)}`));
    });
  });
}

/** Frame-accurate cut of [start, end) seconds, re-encoded like normalise().
 *  `depth` drops audio and keeps more quality for a depth map. */
export async function trimVideo(input: string, out: string, start: number, end: number, depth = false): Promise<void> {
  await run("ffmpeg", [
    "-y", "-v", "error", "-ss", start.toFixed(3), "-to", end.toFixed(3), "-i", input,
    "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", depth ? "16" : "18",
    ...(depth ? ["-an"] : ["-c:a", "aac", "-b:a", "128k"]), "-movflags", "+faststart", out,
  ]);
}

/** Restore the source clip's audio onto a silent generated video. */
export async function restoreSourceAudio(source: string, output: string): Promise<boolean> {
  if (!(await probe(source)).hasAudio) return false;
  const temp = `${output}.audio.mp4`;
  try {
    await run("ffmpeg", [
      "-y", "-v", "error", "-i", output, "-i", source,
      "-map", "0:v:0", "-map", "1:a:0?", "-map_metadata", "0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", temp,
    ]);
    await rename(temp, output);
    return true;
  } finally {
    await rm(temp, { force: true });
  }
}

export { run as exec };

/** One frame at full size as a PNG, `at` seconds in (the last frame: duration minus one frame). */
export async function frameAt(video: string, at: number, out: string): Promise<void> {
  await run("ffmpeg", ["-y", "-v", "error", "-ss", String(Math.max(0, at)), "-i", video, "-frames:v", "1", out]);
}

/**
 * The original take up to `aEnd`, then the continuation without its first frame
 * (that frame is the original's last). The continuation is fitted to the
 * original's size and frame rate; a side without sound gets silence.
 */
export async function joinContinuation(a: string, aEnd: number, b: string, out: string): Promise<void> {
  const [pa, pb] = await Promise.all([probe(a), probe(b)]);
  const fps = Math.round(pa.fps * 1000) / 1000;
  const w = pa.width;
  const h = pa.height;
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
  const aDur = Math.min(aEnd, pa.duration);
  const bDur = Math.max(0, pb.duration - 1 / pb.fps);
  const silence = (d: number, label: string) => `anullsrc=r=48000:cl=stereo,atrim=0:${d.toFixed(3)}[${label}]`;
  const graph = [
    `[0:v]trim=0:${aDur.toFixed(3)},setpts=PTS-STARTPTS,${fit}[va]`,
    `[1:v]trim=start_frame=1,setpts=PTS-STARTPTS,${fit}[vb]`,
    pa.hasAudio ? `[0:a]atrim=0:${aDur.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[aa]` : silence(aDur, "aa"),
    pb.hasAudio ? `[1:a]atrim=start=${(1 / pb.fps).toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[ab]` : silence(bDur, "ab"),
    `[va][aa][vb][ab]concat=n=2:v=1:a=1[v][a]`,
  ].join(";");
  await run("ffmpeg", ["-y", "-v", "error", "-i", a, "-i", b, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]);
}

/** Agent mode: shots one after another as one film, each fitted to the first shot's size; a shot without sound gets silence. */
export async function concatShots(paths: string[], out: string): Promise<void> {
  const ps = await Promise.all(paths.map((p) => probe(p)));
  const { width: w, height: h } = ps[0];
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=24,format=yuv420p`;
  const parts: string[] = [];
  const pairs: string[] = [];
  ps.forEach((p, i) => {
    // video models often wobble in a clip's last frames: leave out its last 0.12 s
    const d = Math.max(0.5, p.duration - 0.12).toFixed(3);
    parts.push(`[${i}:v]trim=0:${d},setpts=PTS-STARTPTS,${fit}[v${i}]`);
    parts.push(p.hasAudio ? `[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${d},afade=t=out:st=${(Number(d) - 0.04).toFixed(3)}:d=0.04[a${i}]` : `anullsrc=r=48000:cl=stereo,atrim=0:${d}[a${i}]`);
    pairs.push(`[v${i}][a${i}]`);
  });
  const graph = [...parts, `${pairs.join("")}concat=n=${ps.length}:v=1:a=1[v][a]`].join(";");
  await run("ffmpeg", ["-y", "-v", "error", ...paths.flatMap((p) => ["-i", p]), "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]);
}
