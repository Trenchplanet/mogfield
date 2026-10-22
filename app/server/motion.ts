// Measures how the camera and the main subject move in a take, so prompts can
// lock motion second by second from real numbers instead of guesses.
//
// Camera: global motion of the *background* (far pixels per the depth map)
// between samples, found by brute-force search over shift and scale.
// Subject: the nearest region of the depth map — its centroid and size.

import { spawn } from "node:child_process";
import { probe } from "./media.js";

const W = 96; // analysis width; height follows the aspect
const SAMPLE_FPS = 4;

export interface MotionSecond {
  t: number; // start second
  pan: number; // + = camera pans right (frame widths per second)
  tilt: number; // + = camera tilts up (frame heights per second)
  push: number; // + = camera pushes in / zooms in (relative scale per second)
  subjectX: number; // 0 = left edge, 1 = right edge
  subjectY: number; // 0 = top, 1 = bottom
  subjectSize: number; // fraction of frame covered by the nearest region
}

export interface MotionReport {
  duration: number;
  seconds: MotionSecond[];
  handheld: boolean;
  hasSubject: boolean;
}

function grayFrames(path: string, w: number, h: number): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-v", "error", "-i", path, "-vf", `fps=${SAMPLE_FPS},scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1"]);
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg: ${err.slice(-300)}`));
      const all = Buffer.concat(chunks);
      const n = Math.floor(all.length / (w * h));
      resolve(Array.from({ length: n }, (_, i) => new Uint8Array(all.subarray(i * w * h, (i + 1) * w * h))));
    });
  });
}

/** Best (dx, dy, k) such that b(x) ≈ a(c + (x - c) / k - d) over background pixels. */
function globalMotion(a: Uint8Array, b: Uint8Array, bg: Uint8Array, w: number, h: number) {
  const cx = w / 2;
  const cy = h / 2;
  let best = { dx: 0, dy: 0, k: 1, err: Infinity };
  const margin = 6;
  for (const k of [0.96, 0.98, 0.99, 1, 1.01, 1.02, 1.04]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        let err = 0;
        let n = 0;
        for (let y = margin; y < h - margin; y += 2) {
          for (let x = margin; x < w - margin; x += 2) {
            const i = y * w + x;
            if (!bg[i]) continue;
            const sx = Math.round(cx + (x - cx) / k - dx);
            const sy = Math.round(cy + (y - cy) / k - dy);
            if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
            err += Math.abs(b[i] - a[sy * w + sx]);
            n++;
          }
        }
        if (n > 50) {
          const e = err / n;
          if (e < best.err) best = { dx, dy, k, err: e };
        }
      }
    }
  }
  return best;
}

/** Camera and subject motion per second. Without a depth map the whole frame
 *  counts as background and no subject is tracked. */
export async function analyzeMotion(videoPath: string, depthPath?: string): Promise<MotionReport> {
  const info = await probe(videoPath);
  const h = Math.max(8, Math.round((W * info.height) / info.width / 2) * 2);
  const [pic, dep] = await Promise.all([grayFrames(videoPath, W, h), depthPath ? grayFrames(depthPath, W, h) : Promise.resolve(null)]);
  const n = dep ? Math.min(pic.length, dep.length) : pic.length;
  const steps: { dx: number; dy: number; k: number; sx: number; sy: number; size: number }[] = [];

  for (let f = 0; f < n; f++) {
    if (!dep) {
      const m = f > 0 ? globalMotion(pic[f - 1], pic[f], new Uint8Array(pic[f].length).fill(1), W, h) : { dx: 0, dy: 0, k: 1 };
      steps.push({ dx: m.dx, dy: m.dy, k: m.k, sx: 0.5, sy: 0.5, size: 0 });
      continue;
    }
    const d = dep[f];
    // nearest ~12% of pixels = subject; farthest ~50% = background for camera motion
    const sorted = Array.from(d).sort((x, y) => x - y);
    const nearT = sorted[Math.floor(sorted.length * 0.88)];
    const farT = sorted[Math.floor(sorted.length * 0.5)];
    let sx = 0;
    let sy = 0;
    let cnt = 0;
    const bg = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) {
      if (d[i] >= nearT && d[i] > 40) {
        sx += i % W;
        sy += Math.floor(i / W);
        cnt++;
      }
      if (d[i] <= farT) bg[i] = 1;
    }
    const size = cnt / d.length;
    const m = f > 0 ? globalMotion(pic[f - 1], pic[f], bg, W, h) : { dx: 0, dy: 0, k: 1 };
    steps.push({ dx: m.dx, dy: m.dy, k: m.k, sx: cnt ? sx / cnt / W : 0.5, sy: cnt ? sy / cnt / h : 0.5, size });
  }

  const seconds: MotionSecond[] = [];
  const total = Math.max(1, Math.ceil(info.duration));
  for (let s = 0; s < total; s++) {
    const win = steps.slice(s * SAMPLE_FPS, (s + 1) * SAMPLE_FPS);
    if (!win.length) break;
    const sum = (f: (x: (typeof win)[0]) => number) => win.reduce((a, x) => a + f(x), 0);
    // content moving right (dx > 0) means the camera panned left
    seconds.push({
      t: s,
      pan: -sum((x) => x.dx) / W,
      tilt: sum((x) => x.dy) / h,
      push: win.reduce((a, x) => a * x.k, 1) - 1,
      subjectX: sum((x) => x.sx) / win.length,
      subjectY: sum((x) => x.sy) / win.length,
      subjectSize: sum((x) => x.size) / win.length,
    });
  }

  // handheld: lots of small direction changes with little net travel
  let flips = 0;
  for (let i = 2; i < steps.length; i++) {
    if (Math.sign(steps[i].dx) !== 0 && Math.sign(steps[i].dx) === -Math.sign(steps[i - 1].dx)) flips++;
    if (Math.sign(steps[i].dy) !== 0 && Math.sign(steps[i].dy) === -Math.sign(steps[i - 1].dy)) flips++;
  }
  const handheld = steps.length > 4 && flips / steps.length > 0.35;
  const hasSubject = steps.some((x) => x.size > 0.02);
  return { duration: info.duration, seconds, handheld, hasSubject };
}
