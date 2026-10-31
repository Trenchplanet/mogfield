// Pika H3 Flex in the Studio: the character sheet as a reference picture
// (workflows/backlot_pika_h3_ref2va.json), or the prompt alone without one
// (backlot_pika_h3_t2v.json). Like MiniMax H3 it does not see the take: the
// prompt carries the measured camera and subject motion, and it makes its own sound.
// Comfy Cloud does not serve it, so it is only offered on LOCAL (your own ComfyUI).

import { currentBackend } from "../backend.js";
import { runFrames } from "../frames.js";
import type { GenerateJob, ModelOption, Provider, ProviderHooks } from "./types.js";

export const pikaH3: Provider = {
  id: "pika",
  label: "Pika H3 Flex",

  async models(): Promise<ModelOption[]> {
    const ready = currentBackend().target === "custom";
    return [
      {
        id: "pika:h3-flex",
        label: "Pika H3 Flex",
        provider: "ComfyUI workflow · open weights",
        badges: ["Video + audio", "Open weights"],
        qualities: ["480p", "768p"],
        maxSeconds: 15,
        inputMode: "text-image",
        available: ready,
        needs: ready ? undefined : "Runs on your own ComfyUI: switch Where it runs to LOCAL",
      },
    ];
  },

  async generate(job: GenerateJob, hooks: ProviderHooks) {
    hooks.step?.("upload", "running", job.sheetPath ? "uploading the character sheet" : "no reference pictures");
    await runFrames(
      {
        model: "pika-h3",
        prompt: job.prompt,
        refs: job.sheetPath ? [job.sheetPath] : [],
        quality: job.quality,
        seconds: job.duration,
        aspect: job.aspect,
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
  },
};
