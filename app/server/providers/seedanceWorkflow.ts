// Seedance as a ComfyUI workflow. The same API-format graph (load nodes ->
// ByteDance Seedance node -> Save Video) runs on Comfy Cloud and on your own
// ComfyUI; on both the partner node authenticates with your Comfy API key, which
// the SDK sends with the job as extra_data and never stores. Every take keeps
// its graph as <take>.workflow.json, ready to open in ComfyUI.
//
// MOGFIELD_SEEDANCE_VIA=router sends Seedance through the Comfy model router
// instead (the earlier path, still used for 2.5 drafts).

import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { currentBackend } from "../backend.js";
import { comfyClient, runGraph } from "../engines/comfy.js";
import { nearestRatio } from "./schemaFill.js";
import type { ProviderHooks } from "./types.js";

type Node = { class_type: string; inputs: Record<string, unknown>; _meta: { title: string } };
export type Graph = Record<string, Node>;

export interface SeedanceWorkflowInput {
  /** Comfy router model id, e.g. byteplus/dreamina-seedance-2-0-260128. */
  model: string;
  /** The final prompt, references already named in words (seedanceText). */
  text: string;
  /** Local files, in the order the prompt numbers them. */
  videos: string[];
  images: string[];
  audios: string[];
  quality: string;
  aspect: number;
  duration: number;
  audio: boolean;
  seed?: number;
  /** Seedance 2.5's task: "edit" keeps the reference video's own length, framing and cuts. Default auto. */
  taskType?: "auto" | "reference" | "edit";
}

const RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];

/** The Seedance node's model option for a router model id, and its resolutions. */
export function seedanceNodeModel(model: string): { key: string; resolutions: string[]; maxSeconds: number } | null {
  if (/seedance-2-5/.test(model)) return { key: "Seedance 2.5", resolutions: ["480p", "720p", "1080p"], maxSeconds: 30 };
  if (/seedance-2-0-fast/.test(model)) return { key: "Seedance 2.0 Fast", resolutions: ["480p", "720p"], maxSeconds: 15 };
  if (/seedance-2-0-mini/.test(model)) return { key: "Seedance 2.0 Mini", resolutions: ["480p", "720p"], maxSeconds: 15 };
  if (/seedance-2-0/.test(model)) return { key: "Seedance 2.0", resolutions: ["480p", "720p", "1080p", "4k"], maxSeconds: 15 };
  return null;
}

export function useSeedanceWorkflow(model: string): boolean {
  return (process.env.MOGFIELD_SEEDANCE_VIA ?? "workflow").trim().toLowerCase() !== "router" && !!seedanceNodeModel(model);
}

/** The API-format graph, and which loader gets which local file. */
export function seedanceGraph(i: SeedanceWorkflowInput): { graph: Graph; outId: string; files: { id: string; field: string; path: string }[] } {
  const m = seedanceNodeModel(i.model);
  if (!m) throw new Error(`${i.model} is not a Seedance model`);
  const graph: Graph = {};
  const files: { id: string; field: string; path: string }[] = [];
  let n = 0;
  const add = (class_type: string, inputs: Record<string, unknown>, title: string) => {
    const id = String(++n);
    graph[id] = { class_type, inputs, _meta: { title } };
    return id;
  };
  const load = (cls: string, field: string, path: string, title: string) => {
    const id = add(cls, { [field]: basename(path) }, title);
    files.push({ id, field, path });
    return [id, 0];
  };

  const resolution = m.resolutions.includes(i.quality) ? i.quality : m.resolutions[0];
  const inputs: Record<string, unknown> = {
    model: m.key,
    "model.prompt": i.text,
    "model.resolution": resolution,
    "model.ratio": nearestRatio(RATIOS, i.aspect),
    "model.duration": Math.min(m.maxSeconds, Math.max(4, Math.floor(i.duration + 0.05))),
    "model.generate_audio": i.audio,
    seed: i.seed ?? Math.floor(Math.random() * 2 ** 31),
    watermark: false,
  };
  if (m.key === "Seedance 2.5") inputs["model.output_format"] = "mp4";
  const media = i.videos.length + i.images.length + i.audios.length > 0;
  if (media) {
    i.videos.forEach((p, k) => (inputs[`model.reference_videos.video_${k + 1}`] = load("LoadVideo", "file", p, `BL:video-${k + 1}`)));
    i.images.forEach((p, k) => (inputs[`model.reference_images.image_${k + 1}`] = load("LoadImage", "image", p, `BL:image-${k + 1}`)));
    i.audios.forEach((p, k) => (inputs[`model.reference_audios.audio_${k + 1}`] = load("LoadAudio", "audio", p, `BL:audio-${k + 1}`)));
    if (m.key === "Seedance 2.5") inputs["model.task_type"] = i.taskType ?? "auto";
    // small or large takes are scaled to the model's pixel budget instead of refused (e.g. a 720x404 crop)
    if (i.videos.length) Object.assign(inputs, { "model.auto_upscale": true, "model.auto_downscale": true });
  }
  const gen = add(media ? "ByteDance2ReferenceNodeV2" : "ByteDance2TextToVideoNode", inputs, "BL:seedance");
  const outId = add("SaveVideo", { video: [gen, 0], filename_prefix: "mogfield/seedance", format: "auto", "format.codec": "auto" }, "BL:output");
  return { graph, outId, files };
}

/** Run the graph on the current backend (Comfy Cloud or your ComfyUI) and save the video to outPath. */
export async function runSeedanceWorkflow(i: SeedanceWorkflowInput, outPath: string, hooks: ProviderHooks): Promise<void> {
  const { graph, outId, files } = seedanceGraph(i);
  const local = currentBackend().target === "custom";
  const key = process.env.COMFY_API_KEY?.trim();
  if (!key) throw new Error("Comfy API key missing: add COMFY_API_KEY to app/.env and restart");
  await writeFile(outPath.replace(/\.mp4$/i, "") + ".workflow.json", JSON.stringify(graph, null, 2)).catch(() => {});
  const c = comfyClient();
  const wf = c.workflows.fromJson(structuredClone(graph));
  for (const f of files) wf.setInput(f.id, f.field, c.assets.fromFile(f.path));
  const label = graph[Object.keys(graph).find((id) => graph[id]._meta.title === "BL:seedance")!].inputs.model;
  console.log(`submit workflow ${String(label)} on ${local ? currentBackend().url : "Comfy Cloud"}: ${files.length} input file(s)`);
  hooks.progress(0.1, files.length ? "Uploading inputs" : "Sending the workflow");
  hooks.step?.("upload", "running", local ? "to your ComfyUI" : "to Comfy Cloud");
  let p = 0.15;
  await runGraph(
    wf,
    outId,
    outPath,
    {
      // partner nodes report little progress: keep the bar moving between their updates
      progress: (v) => hooks.progress((p = Math.max(p, 0.15 + v * 0.75)), "Generating"),
      message: (msg) => {
        if (/queue/i.test(msg)) hooks.step?.("queue", "running", msg);
        else hooks.step?.("generate", "running");
        hooks.progress(p, /ByteDance/.test(msg) ? "Seedance is generating" : msg);
      },
      preview: () => {},
      signal: hooks.signal,
    },
    // partner nodes need the key with the job on Comfy Cloud too ("Please login first" otherwise)
    key,
  );
  hooks.progress(0.95, "Saved");
}
