// Text to video: a new shot from a detailed prompt and optional reference
// images (characters, objects, places), no source video. Takes are kept in
// data/t2v.json so they survive a restart.

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, RENDER_DIR } from "./config.js";
import { generateFromPrompt } from "./providers/comfyRouter.js";
import { T2V_ASPECTS, type T2vAspect, type T2vTake } from "./shared.js";

const FILE = join(DATA_DIR, "t2v.json");
const takes = new Map<string, T2vTake>();

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

const save = () => writeFile(FILE, JSON.stringify([...takes.values()], null, 2)).catch(() => {});

export function listTakes(): T2vTake[] {
  return [...takes.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function startTake(o: { prompt: string; imageIds: string[]; imagePaths: string[]; model: string; quality: string; seconds: number; aspect: T2vAspect; audio: boolean }): T2vTake {
  const id = randomUUID().slice(0, 8);
  const take: T2vTake = {
    id, prompt: o.prompt, imageIds: o.imageIds, model: o.model, quality: o.quality, seconds: o.seconds, aspect: o.aspect, audio: o.audio,
    status: "running", progress: 0, message: "Starting", createdAt: Date.now(),
  };
  takes.set(id, take);
  void save();
  const outPath = join(RENDER_DIR, `t2v-${id}.mp4`);
  void (async () => {
    try {
      await generateFromPrompt(
        { model: o.model.replace(/^comfy:/, ""), prompt: o.prompt, imagePaths: o.imagePaths, quality: o.quality, seconds: o.seconds, aspect: T2V_ASPECTS[o.aspect], audio: o.audio, outPath },
        {
          progress: (p, m) => {
            if (p >= 0) take.progress = p;
            take.message = m;
          },
        },
      );
      Object.assign(take, { status: "succeeded", progress: 1, message: "Done", url: `/media/renders/t2v-${id}.mp4`, workflowUrl: existsSync(outPath.replace(/\.mp4$/, ".workflow.json")) ? `/media/renders/t2v-${id}.workflow.json` : undefined });
    } catch (e) {
      Object.assign(take, { status: "failed", message: "Failed", error: (e as Error).message.slice(0, 600) });
      console.error(`text-to-video ${id} failed:`, e);
    }
    void save();
  })();
  return take;
}
