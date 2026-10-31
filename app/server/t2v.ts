// Video takes that start from nothing or from frames: text to video (a prompt
// and optional reference images), start / end frame video, and Extend, which
// continues a take from its last frame. Takes are kept in data/t2v.json so
// they survive a restart.

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, RENDER_DIR } from "./config.js";
import { runFrames } from "./frames.js";
import { frameAt, joinContinuation } from "./media.js";
import { generateFromPrompt } from "./providers/comfyRouter.js";
import { OwnedMap, onPurged } from "./scope.js";
import { runCatalogModel } from "./providers/catalog.js";
import { FRAME_MODELS, T2V_ASPECTS, type FrameModel, type T2vAspect, type T2vTake } from "./shared.js";

const FILE = join(DATA_DIR, "t2v.json");
const takes = new OwnedMap<T2vTake>();

function load() {
  if (!existsSync(FILE)) return;
  try {
    for (const t of JSON.parse(readFileSync(FILE, "utf8")) as T2vTake[]) {
      // a take that was running when the server stopped will not finish
      if (t.status === "queued" || t.status === "running") Object.assign(t, { status: "failed", error: "Interrupted by a server restart" });
      takes.set(t.id, t);
    }
  } catch {
    /* unreadable: start empty */
  }
}
load();

const save = () => writeFile(FILE, JSON.stringify(takes.all(), null, 2)).catch(() => {});
onPurged(() => void save());

export function listTakes(): T2vTake[] {
  return [...takes.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Runs a take's job in the background and keeps its status up to date. */
function run(take: T2vTake, job: (hooks: { progress: (p: number, m: string) => void }) => Promise<Partial<T2vTake>>) {
  takes.set(take.id, take);
  void save();
  void (async () => {
    try {
      const done = await job({
        progress: (p, m) => {
          if (p >= 0) take.progress = p;
          take.message = m;
        },
      });
      Object.assign(take, { status: "succeeded", progress: 1, message: "Done", ...done });
    } catch (e) {
      Object.assign(take, { status: "failed", message: "Failed", error: (e as Error).message.slice(0, 600) });
      console.error(`${take.kind ?? "t2v"} take ${take.id} failed:`, e);
    }
    void save();
  })();
  return take;
}

const media = (file: string) => `/media/renders/${file}`;
const workflowOf = (outPath: string, file: string) => (existsSync(outPath.replace(/\.mp4$/, ".workflow.json")) ? media(file.replace(/\.mp4$/, ".workflow.json")) : undefined);

/** A video that starts on a start frame and/or lands on an end frame. */
export function startFramesTake(o: { prompt: string; model: FrameModel; quality: string; seconds: number; aspect: T2vAspect; audio: boolean; start?: { id: string; path: string }; end?: { id: string; path: string }; refs?: { id: string; path: string }[] }): T2vTake {
  const id = randomUUID().slice(0, 8);
  const take: T2vTake = {
    id, kind: "frames", prompt: o.prompt, imageIds: (o.refs ?? []).map((r) => r.id), startFrameId: o.start?.id, endFrameId: o.end?.id, model: o.model, quality: o.quality, seconds: o.seconds, aspect: o.aspect, audio: o.audio,
    status: "running", progress: 0, message: "Starting", createdAt: Date.now(),
  };
  const file = `frames-${id}.mp4`;
  const outPath = join(RENDER_DIR, file);
  return run(take, async (hooks) => {
    await runFrames({ model: o.model, prompt: o.prompt, startFrame: o.start?.path, endFrame: o.end?.path, refs: o.refs?.map((r) => r.path), quality: o.quality, seconds: o.seconds, aspect: T2V_ASPECTS[o.aspect], audio: o.audio }, outPath, hooks);
    return { url: media(file), workflowUrl: workflowOf(outPath, file) };
  });
}

export const CONTINUE = "Continue this exact shot from this frame, as the next seconds of the same video: same characters with the same faces, hair, outfits and props, same place, same lighting and colour grade, same camera style and lens, same visual style. No cut, no new scene, no change of look.";

/** The continuation prompt, with what should happen next when given. */
export const extendPrompt = (next: string) => (next ? `${CONTINUE}\n\nWhat happens next: ${next}` : CONTINUE);

/**
 * Extend: the take's last frame becomes the first frame of a new clip, so the
 * characters, place and style carry straight over; then both are joined.
 */
export function startExtend(o: { clipId: string; clipPath: string; from: number; prompt: string; model: FrameModel; quality: string; seconds: number; aspect: T2vAspect; audio: boolean }): T2vTake {
  const id = randomUUID().slice(0, 8);
  const prompt = extendPrompt(o.prompt);
  const take: T2vTake = {
    id, kind: "extend", prompt: o.prompt, imageIds: [], clipId: o.clipId, from: o.from, model: o.model, quality: o.quality, seconds: o.seconds, aspect: o.aspect, audio: o.audio,
    status: "running", progress: 0, message: "Taking the last frame", createdAt: Date.now(),
  };
  const file = `extend-${id}.mp4`;
  const outPath = join(RENDER_DIR, file);
  const framePath = join(RENDER_DIR, `extend-${id}-start.png`);
  const joinedFile = `extend-${id}-joined.mp4`;
  return run(take, async (hooks) => {
    // one frame before the end: seeking to the very end can land past the last frame
    await frameAt(o.clipPath, Math.max(0, o.from - 0.05), framePath);
    await runFrames({ model: o.model, prompt, startFrame: framePath, quality: o.quality, seconds: o.seconds, aspect: T2V_ASPECTS[o.aspect], audio: o.audio }, outPath, hooks);
    hooks.progress(0.97, "Joining with the original");
    await joinContinuation(o.clipPath, o.from, outPath, join(RENDER_DIR, joinedFile));
    return { url: media(file), joinedUrl: media(joinedFile), workflowUrl: workflowOf(outPath, file) };
  });
}

export function isFrameModel(m: unknown): m is FrameModel {
  return typeof m === "string" && m in FRAME_MODELS;
}

export function startTake(o: { prompt: string; imageIds: string[]; imagePaths: string[]; model: string; quality: string; seconds: number; aspect: T2vAspect; audio: boolean; catalog?: boolean }): T2vTake {
  const id = randomUUID().slice(0, 8);
  const take: T2vTake = {
    id, kind: "t2v", prompt: o.prompt, imageIds: o.imageIds, model: o.model, quality: o.quality, seconds: o.seconds, aspect: o.aspect, audio: o.audio,
    status: "running", progress: 0, message: "Starting", createdAt: Date.now(),
  };
  takes.set(id, take);
  void save();
  const outPath = join(RENDER_DIR, `t2v-${id}.mp4`);
  void (async () => {
    try {
      const hooks = {
        progress: (p: number, m: string) => {
          if (p >= 0) take.progress = p;
          take.message = m;
        },
      };
      const job = { model: o.model.replace(/^comfy:/, ""), prompt: o.prompt, imagePaths: o.imagePaths, quality: o.quality, seconds: o.seconds, aspect: T2V_ASPECTS[o.aspect], audio: o.audio, outPath };
      // any other video model in the Comfy API catalog: its request is filled from its schema
      if (o.catalog) await runCatalogModel({ ...job, output: "video" }, hooks);
      else await generateFromPrompt(job, hooks);
      Object.assign(take, { status: "succeeded", progress: 1, message: "Done", url: `/media/renders/t2v-${id}.mp4`, workflowUrl: existsSync(outPath.replace(/\.mp4$/, ".workflow.json")) ? `/media/renders/t2v-${id}.workflow.json` : undefined });
    } catch (e) {
      Object.assign(take, { status: "failed", message: "Failed", error: (e as Error).message.slice(0, 600) });
      console.error(`text-to-video ${id} failed:`, e);
    }
    void save();
  })();
  return take;
}
