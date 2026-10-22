// Depth maps for a take. Bright = near (Depth Anything convention), matching
// what the comfyui-backlot nodes expect.
//
// - Comfy target: workflows/backlot_depth.json (Depth Anything V2 Large on GPU).
// - Otherwise: Depth Anything V2 Small (Apache-2.0) through onnxruntime on the
//   CPU. The model downloads once into data/models/.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DATA_DIR, ENGINE, WORKFLOW_DIR } from "./config.js";
import { comfyClient, findByTitle, loadGraph } from "./engines/comfy.js";
import { probe } from "./media.js";

export const DEPTH_DIR = join(DATA_DIR, "depth");
const MODEL_DIR = join(DATA_DIR, "models");
const MODEL_PATH = join(MODEL_DIR, "depth-anything-v2-small.onnx");
const MODEL_URL = "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx";
const LONG_SIDE = 448; // multiple of 14 (ViT patch size)

export interface DepthHooks {
  progress: (p: number, message: string) => void;
  signal?: AbortSignal;
}

export function depthPath(clipId: string) {
  return join(DEPTH_DIR, `${clipId}.mp4`);
}

async function ensureModel(hooks: DepthHooks) {
  if (existsSync(MODEL_PATH)) return;
  await mkdir(MODEL_DIR, { recursive: true });
  hooks.progress(0, "Downloading Depth Anything V2 Small (99 MB, once)");
  const res = await fetch(MODEL_URL, { signal: hooks.signal });
  if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let got = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on("data", (c: Buffer) => {
    got += c.length;
    if (total) hooks.progress(0, `Downloading depth model ${Math.round((got / total) * 100)}%`);
  });
  const tmp = `${MODEL_PATH}.part`;
  await pipeline(body, createWriteStream(tmp));
  await rename(tmp, MODEL_PATH);
}

type Ort = typeof import("onnxruntime-node");
let session: Promise<{ ort: Ort; s: import("onnxruntime-node").InferenceSession }> | null = null;
function getSession() {
  session ??= (async () => {
    const m = (await import("onnxruntime-node")) as unknown as Ort & { default?: Ort };
    const ort = m.default ?? m;
    const s = await ort.InferenceSession.create(MODEL_PATH, { graphOptimizationLevel: "all" });
    return { ort, s };
  })();
  return session;
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

async function localDepth(clipPath: string, out: string, hooks: DepthHooks) {
  await ensureModel(hooks);
  const info = await probe(clipPath);
  const scale = LONG_SIDE / Math.max(info.width, info.height);
  const r14 = (v: number) => Math.max(14, Math.round((v * scale) / 14) * 14);
  const W = r14(info.width);
  const H = r14(info.height);
  const fps = info.fps || 24;
  const total = Math.max(1, info.frames);
  hooks.progress(0, "Loading depth model");
  const { ort, s } = await getSession();

  const dec = spawn("ffmpeg", ["-v", "error", "-i", clipPath, "-vf", `scale=${W}:${H}:flags=area,format=rgb24`, "-f", "rawvideo", "pipe:1"]);
  const enc = spawn("ffmpeg", [
    "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", String(fps), "-i", "pipe:0",
    "-vf", `scale=${info.width}:${info.height}:flags=bicubic,format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-movflags", "+faststart", out,
  ]);
  let encErr = "";
  enc.stderr.on("data", (d) => (encErr += d));
  const encDone = new Promise<void>((res, rej) => enc.on("close", (c) => (c === 0 ? res() : rej(new Error(`depth encode failed: ${encErr.slice(-400)}`)))));
  const kill = () => {
    dec.kill("SIGKILL");
    enc.kill("SIGKILL");
  };
  hooks.signal?.addEventListener("abort", kill);

  const frameBytes = W * H * 3;
  const input = new Float32Array(3 * W * H);
  const gray = Buffer.alloc(W * H);
  // EMA of a robust per-frame range keeps brightness stable across the take
  let lo = Number.NaN;
  let hi = Number.NaN;
  let pending: Buffer = Buffer.alloc(0);
  let n = 0;

  for await (const chunk of dec.stdout as AsyncIterable<Buffer>) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const px = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      for (let i = 0, p = 0; i < W * H; i++, p += 3) {
        input[i] = (px[p] / 255 - MEAN[0]) / STD[0];
        input[W * H + i] = (px[p + 1] / 255 - MEAN[1]) / STD[1];
        input[2 * W * H + i] = (px[p + 2] / 255 - MEAN[2]) / STD[2];
      }
      const res = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, H, W]) });
      const d = res[s.outputNames[0]].data as Float32Array;
      // 2nd / 98th percentile from a strided sample
      const sample: number[] = [];
      for (let i = 0; i < d.length; i += 7) sample.push(d[i]);
      sample.sort((a, b) => a - b);
      const fLo = sample[Math.floor(sample.length * 0.02)];
      const fHi = sample[Math.floor(sample.length * 0.98)];
      lo = Number.isNaN(lo) ? fLo : lo * 0.8 + fLo * 0.2;
      hi = Number.isNaN(hi) ? fHi : hi * 0.8 + fHi * 0.2;
      const span = Math.max(1e-6, hi - lo);
      for (let i = 0; i < d.length; i++) gray[i] = Math.max(0, Math.min(255, Math.round(((d[i] - lo) / span) * 255)));
      if (!enc.stdin.write(gray)) await new Promise((r) => enc.stdin.once("drain", r));
      n++;
      hooks.progress(Math.min(0.99, n / total), `Depth ${n}/${total}`);
    }
  }
  enc.stdin.end();
  await encDone;
  hooks.signal?.removeEventListener("abort", kill);
  if (n === 0) throw new Error("no frames decoded");
}

async function comfyDepth(clipPath: string, out: string, hooks: DepthHooks) {
  const c = comfyClient();
  const graph = await loadGraph("backlot_depth");
  const outId = findByTitle(graph, "BL:output")[0];
  if (!outId) throw new Error("workflows/backlot_depth.json has no node titled BL:output");
  const wf = c.workflows.fromJson(structuredClone(graph));
  for (const id of findByTitle(graph, "BL:video")) wf.setInput(id, "file", c.assets.fromFile(clipPath));
  hooks.progress(0, "Submitting depth to Comfy");
  const job = await c.submit(wf, { signal: hooks.signal });
  try {
    for await (const ev of job.events(hooks.signal)) {
      if (ev.kind === "progress") hooks.progress(ev.value, "Depth Anything V2 (GPU)");
      if (ev.kind === "statusChange" && ["succeeded", "failed", "canceled", "expired"].includes(ev.status)) break;
    }
  } catch (e) {
    if (hooks.signal?.aborted) throw e;
  }
  await job.result(hooks.signal);
  const o = job.getOutputs(outId)[0];
  if (!o) throw new Error("depth workflow returned no output");
  await o.toFile(out);
}

// One depth job per clip: a second caller (say, Generate while the
// background job runs) joins the first and gets its progress too.
const inflight = new Map<string, { done: Promise<string>; listeners: Set<DepthHooks["progress"]> }>();

export function generateDepth(clipPath: string, clipId: string, hooks: DepthHooks): Promise<string> {
  const running = inflight.get(clipId);
  if (running) {
    running.listeners.add(hooks.progress);
    return running.done;
  }
  const listeners = new Set([hooks.progress]);
  const done = runDepth(clipPath, clipId, { progress: (p, m) => listeners.forEach((l) => l(p, m)), signal: hooks.signal }).finally(() => inflight.delete(clipId));
  inflight.set(clipId, { done, listeners });
  return done;
}

async function runDepth(clipPath: string, clipId: string, hooks: DepthHooks): Promise<string> {
  await mkdir(DEPTH_DIR, { recursive: true });
  const out = depthPath(clipId);
  const tmp = join(DEPTH_DIR, `${clipId}.part.mp4`);
  const useComfy = ENGINE === "comfy" && existsSync(join(WORKFLOW_DIR, "backlot_depth.json"));
  await (useComfy ? comfyDepth : localDepth)(clipPath, tmp, hooks);
  await rename(tmp, out);
  return out;
}
