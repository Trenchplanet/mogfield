import { comfyRouter } from "./comfyRouter.js";
import { comfyWorkflow } from "./comfyWorkflow.js";
import { h3Cloud } from "./h3Cloud.js";
import { pikaH3 } from "./pikaH3.js";
import { refVideo } from "./refVideo.js";
import type { ModelOption, Provider } from "./types.js";

// Order = order in the model picker; the first available model is the default.
// Add new providers (fal, BytePlus, …) here.
export const PROVIDERS: Provider[] = [pikaH3, h3Cloud, comfyRouter, refVideo, comfyWorkflow];

export async function listModels(): Promise<ModelOption[]> {
  const lists = await Promise.all(PROVIDERS.map((p) => p.models().catch(() => [] as ModelOption[])));
  return lists.flat();
}

export function providerFor(modelId: string): { provider: Provider; model: string } | null {
  const i = modelId.indexOf(":");
  if (i < 0) return null;
  const provider = PROVIDERS.find((p) => p.id === modelId.slice(0, i));
  return provider ? { provider, model: modelId.slice(i + 1) } : null;
}

export type { ModelOption, Provider, Quality } from "./types.js";
