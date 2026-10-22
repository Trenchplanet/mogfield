import type { RenderParams } from "../shared.js";

export interface EngineHooks {
  progress: (p: number) => void;
  message: (m: string) => void;
  /** Live preview frame from the sampler (JPEG/PNG bytes). */
  preview: (bytes: Uint8Array, contentType: string) => void;
  signal?: AbortSignal;
}

export interface Engine {
  name: "comfy" | "preview";
  render(p: RenderParams, clipPath: string, outPath: string, hooks: EngineHooks, castPath?: string): Promise<void>;
}
