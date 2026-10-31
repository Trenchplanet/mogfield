// Pika H3 Flex in the Studio, Re-shoot and Genjutsu takes
// (workflows/backlot_pika_h3_ref2va.json): the take goes in as <Video 1>, with
// its sound, and the character or style picture as <Picture 1>.
//   pika:h3-flex       restyle, character swap in words, or re-shoot from another angle
//   pika:h3-flex-swap  character swap; a Genjutsu take sends its SAM 3 silhouette video
// Comfy Cloud does not serve it, so it is only offered on LOCAL (your own ComfyUI).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBackend } from "../backend.js";
import { runFrames } from "../frames.js";
import { probe } from "../media.js";
import { fitTake, h3Frames, h3Size } from "./h3Cloud.js";
import type { GenerateJob, ModelOption, Provider, ProviderHooks } from "./types.js";

const base = {
  provider: "Your ComfyUI · open weights",
  qualities: ["480p", "768p"],
  maxSeconds: 15,
  inputMode: "reference-video",
} as const;

/** Prompts are written with @Video1 / @Image1; H3 reads <Video 1> / <Picture 1>. */
export const h3Tags = (prompt: string) => prompt.replace(/@video(\d+)/gi, "<Video $1>").replace(/@image(\d+)/gi, "<Picture $1>");

export const pikaH3: Provider = {
  id: "pika",
  label: "Pika H3 Flex",

  async models(): Promise<ModelOption[]> {
    const ready = currentBackend().target === "custom";
    const needs = ready ? undefined : "Runs on your own ComfyUI: switch Where it runs to LOCAL";
    return [
      { ...base, qualities: [...base.qualities], id: "pika:h3-flex", label: "Pika H3 Flex", badges: ["Video + audio", "Open weights"], available: ready, needs },
      { ...base, qualities: [...base.qualities], id: "pika:h3-flex-swap", label: "Pika H3 Flex · Character Swap", badges: ["No prep", "Open weights"], available: ready, needs },
    ];
  },

  async generate(job: GenerateJob, hooks: ProviderHooks) {
    // the take on H3's grid: 24 fps, 17n+5 frames, multiples of 32
    hooks.step?.("inputs", "running", "fitting the video to H3's frame grid");
    const src = await probe(job.clipPath);
    const seconds = Math.min(15, src.duration, job.duration || src.duration);
    const { width, height } = h3Size(src.width / src.height, job.quality);
    const dir = await mkdtemp(join(tmpdir(), "pika-h3-"));
    try {
      const take = join(dir, "take.mp4");
      await fitTake(job.clipPath, take, width, height, h3Frames(seconds));
      hooks.step?.("inputs", "done");
      const picture = job.characterPath ?? job.sheetPath;
      hooks.step?.("upload", "running");
      await runFrames(
        {
          model: "pika-h3",
          prompt: h3Tags(job.prompt),
          refs: picture ? [picture] : [],
          refVideo: { path: take, audio: src.hasAudio && job.sendAudio !== false },
          quality: job.quality,
          seconds,
          aspect: src.width / src.height,
          audio: true,
          seed: job.seed,
        },
        job.outPath,
        {
          ...hooks,
          progress: (p, m) => {
            if (p > 0.15) {
              hooks.step?.("upload", "done");
              hooks.step?.("generate", "running");
            }
            hooks.progress(p, m);
          },
        },
      );
      hooks.step?.("generate", "done");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
