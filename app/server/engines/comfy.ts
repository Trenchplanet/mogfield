// The GPU engine: runs the API-format workflows in /workflows through the
// Comfy SDK. COMFY_BASE_URL decides where: a local ComfyUI behind
// comfy-api-proxy, or a Comfy API deployment (COMFY_API_KEY for the latter).
//
// Workflows are bound by node title, not node id, so a workflow can be
// re-exported from ComfyUI without touching this file. Give nodes these
// titles (right click > Title in ComfyUI) before File > Export (API):
//
//   BL:video       LoadVideo            file        <- the take
//   BL:cast        LoadImage            image       <- cast/set reference
//   BL:prompt      any text encoder     text        <- prompt
//   BL:seed        any sampler/noise    seed / noise_seed
//   BL:camera      BacklotCameraRig     preset, strength
//   BL:lens        BacklotLensKit       lens, f_stop, focus, focus_end, halation, grain, seed
//   BL:grade       BacklotGradeLUT      lut, strength
//   BL:letterbox   BacklotLetterbox     aspect
//   BL:output      SaveVideo / SaveImage - the node whose output we download

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Comfy, type Workflow } from "@comfyorg/sdk";
import { WORKFLOW_DIR } from "../config.js";
import type { RenderParams } from "../shared.js";
import type { Engine, EngineHooks } from "./types.js";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;

let client: Comfy | null = null;
export function comfyClient(): Comfy {
  client ??= new Comfy({ clientInfo: "backlot/0.1" });
  return client;
}

/** Forget the cached client so the next call follows a changed COMFY_BASE_URL. */
export function resetComfyClient() {
  client = null;
}

export function workflowPath(name: string) {
  return join(WORKFLOW_DIR, `${name}.json`);
}

export async function loadGraph(name: string): Promise<Graph> {
  const p = workflowPath(name);
  if (!existsSync(p)) throw new Error(`workflows/${name}.json is not installed yet - see workflows/README.md`);
  return JSON.parse(await readFile(p, "utf8"));
}

export function findByTitle(graph: Graph, tag: string): string[] {
  return Object.entries(graph)
    .filter(([, n]) => n._meta?.title?.trim().toUpperCase() === tag.toUpperCase())
    .map(([id]) => id);
}

/** Set `field` on every node titled `tag`, but only where that input exists
 *  and is a widget value (not a link), so a template's wiring is never broken. */
function bind(wf: Workflow, graph: Graph, tag: string, values: Record<string, unknown>) {
  for (const id of findByTitle(graph, tag)) {
    const inputs = graph[id].inputs;
    for (const [field, v] of Object.entries(values)) {
      if (v === undefined || !(field in inputs) || Array.isArray(inputs[field])) continue;
      wf.setInput(id, field, v);
    }
  }
}

/** Submit a workflow to the current target, follow it and save the output of
 *  node `outId`. `apiKey` authenticates partner nodes on your own ComfyUI. */
export async function runGraph(wf: Workflow, outId: string, outPath: string, hooks: EngineHooks, apiKey?: string): Promise<void> {
  const c = comfyClient();
  const job = await c.submit(wf, { apiKey, signal: hooks.signal });
  try {
    events: for await (const ev of job.events(hooks.signal)) {
      switch (ev.kind) {
        case "progress":
          hooks.progress(ev.value);
          if (ev.currentNodeClass) hooks.message(ev.currentNodeClass);
          break;
        case "preview":
          hooks.preview(ev.data, ev.contentType);
          break;
        case "statusChange":
          if (ev.status === "queued" && ev.queuePosition != null) hooks.message(`In queue (#${ev.queuePosition})`);
          if (["succeeded", "failed", "canceled", "expired"].includes(ev.status)) break events;
          break;
      }
    }
  } catch (e) {
    // the event stream is best-effort; result() below is authoritative
    if (hooks.signal?.aborted) throw e;
  }
  await job.result(hooks.signal);
  const outputs = job.getOutputs(outId);
  const video = outputs.find((o) => /video|mp4|webm/.test(o.contentType)) ?? outputs[0];
  if (!video) throw new Error("workflow finished without an output on BL:output");
  await video.toFile(outPath);
}

export const comfyEngine: Engine = {
  name: "comfy",
  async render(p: RenderParams, clipPath: string, outPath: string, hooks: EngineHooks, castPath?: string) {
    const c = comfyClient();
    const name = p.mode === "recast" ? "backlot_recast" : "backlot_direct";
    const graph = await loadGraph(name);
    const out = findByTitle(graph, "BL:output")[0];
    if (!out) throw new Error(`workflows/${name}.json has no node titled BL:output`);
    const wf = c.workflows.fromJson(structuredClone(graph));

    for (const id of findByTitle(graph, "BL:video")) wf.setInput(id, "file", c.assets.fromFile(clipPath));
    if (castPath) for (const id of findByTitle(graph, "BL:cast")) wf.setInput(id, "image", c.assets.fromFile(castPath));
    bind(wf, graph, "BL:prompt", { text: p.prompt });
    bind(wf, graph, "BL:seed", { seed: p.seed, noise_seed: p.seed });
    bind(wf, graph, "BL:camera", { preset: p.camera, strength: p.cameraStrength, seed: p.seed });
    bind(wf, graph, "BL:lens", { lens: p.lens, f_stop: p.fStop, focus: p.focus, focus_end: p.focusEnd, halation: p.halation, grain: p.grain, seed: p.seed });
    bind(wf, graph, "BL:grade", { lut: p.lut === "none" ? "none" : p.lut, strength: p.lutStrength });
    bind(wf, graph, "BL:letterbox", { aspect: p.aspect });

    hooks.message("Sending to GPU");
    await runGraph(wf, out, outPath, hooks);
  },
};

/** FLUX Klein cast/set reference via workflows/backlot_cast.json. */
export async function comfyCast(prompt: string, seed: number, outPath: string): Promise<void> {
  const c = comfyClient();
  const graph = await loadGraph("backlot_cast");
  const out = findByTitle(graph, "BL:output")[0];
  if (!out) throw new Error("workflows/backlot_cast.json has no node titled BL:output");
  const wf = c.workflows.fromJson(structuredClone(graph));
  bind(wf, graph, "BL:prompt", { text: prompt });
  bind(wf, graph, "BL:seed", { seed, noise_seed: seed });
  const job = await c.run(wf);
  const img = job.getOutputs(out)[0];
  if (!img) throw new Error("cast workflow returned no image");
  await img.toFile(outPath);
}
