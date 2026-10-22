// ComfyUI workflow provider: LTX 2.5 (open weights) on your own GPU or a
// Comfy API deployment, through workflows/backlot_recast.json.

import { existsSync } from "node:fs";
import { ENGINE } from "../config.js";
import { comfyEngine, workflowPath } from "../engines/comfy.js";
import type { GenerateJob, ModelOption, Provider, ProviderHooks } from "./types.js";

export const comfyWorkflow: Provider = {
  id: "comfyui",
  label: "ComfyUI",

  async models(): Promise<ModelOption[]> {
    const hasWorkflow = existsSync(workflowPath("backlot_recast"));
    const ready = ENGINE === "comfy" && hasWorkflow;
    return [
      {
        id: "comfyui:ltx-2.5",
        label: "LTX 2.5",
        provider: "Your ComfyUI · open weights",
        badges: ["Your GPU"],
        qualities: ["480p", "720p"],
        maxSeconds: 10,
        available: ready,
        needs: ready ? undefined : ENGINE !== "comfy" ? "Set COMFY_BASE_URL to your ComfyUI (GPU)" : "workflows/backlot_recast.json missing",
      },
    ];
  },

  async generate(job: GenerateJob, hooks: ProviderHooks) {
    await comfyEngine.render(
      {
        clipId: "",
        mode: "recast",
        camera: "static",
        cameraStrength: 1,
        lens: "24mm",
        fStop: 2.8,
        focus: 0.7,
        focusEnd: -1,
        lut: "none",
        lutStrength: 0,
        grain: 0,
        halation: 0,
        aspect: "native",
        prompt: job.prompt,
        seed: Math.floor(Math.random() * 2 ** 31),
      },
      job.clipPath,
      job.outPath,
      { progress: (p) => hooks.progress(p, "Generating"), message: (m) => hooks.progress(-1, m), preview: () => {}, signal: hooks.signal },
      job.sheetPath ?? undefined,
    );
  },
};
