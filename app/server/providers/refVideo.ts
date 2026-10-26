// Reference-to-video partner nodes that take the whole take as a reference:
// Wan 3.0 Reference to Video and MiniMax H3 Reference to Video. The take goes
// in as Video 1 and the character (or style picture) as Image 1, so they can
// swap a character, restyle a shot or film it again from another angle.
// Runs as a ComfyUI workflow on Comfy Cloud or your own ComfyUI, and each take
// keeps its graph as <take>.workflow.json.

import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { currentBackend } from "../backend.js";
import { comfyClient, runGraph } from "../engines/comfy.js";
import type { GenerateJob, ModelOption, Provider, ProviderHooks } from "./types.js";

type Node = { class_type: string; inputs: Record<string, unknown>; _meta: { title: string } };

const hasKey = () => !!process.env.COMFY_API_KEY?.trim();

const MODELS: Omit<ModelOption, "available" | "needs">[] = [
  {
    id: "refv:wan3.0-video",
    label: "Wan 3.0",
    provider: "Comfy API · Wan",
    badges: ["Video + image refs"],
    qualities: ["480p", "720p", "1080p"],
    maxSeconds: 15,
    inputMode: "reference-video",
    // billed on output plus reference seconds
    pricing: { kind: "per-second", usd: { "480p": 0.0715, "720p": 0.143, "1080p": 0.286 }, videoIn: true },
  },
  {
    id: "refv:minimax-h3",
    label: "MiniMax H3",
    provider: "Comfy API · MiniMax",
    badges: ["Video + image refs"],
    qualities: ["768p", "2K"],
    maxSeconds: 15,
    inputMode: "reference-video",
    pricing: { kind: "per-second", usd: { "768p": 0.1287, "2K": 0.1859 }, videoIn: true },
  },
];

export interface RefVideoInput {
  /** wan3.0-video or minimax-h3 */
  model: string;
  /** Written with @Video1 / @Image1; H3 gets them as Video 1 / Image 1. */
  prompt: string;
  video: string;
  image?: string;
  quality: string;
  seconds: number;
  seed?: number;
}

/** The API-format graph, and which loader gets which local file. */
export function refVideoGraph(i: RefVideoInput): { graph: Record<string, Node>; outId: string; files: { id: string; field: string; path: string }[] } {
  const graph: Record<string, Node> = {};
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
  const video = load("LoadVideo", "file", i.video, "BL:video-1");
  const image = i.image ? load("LoadImage", "image", i.image, "BL:image-1") : undefined;
  const seed = i.seed ?? Math.floor(Math.random() * 2 ** 31);
  let gen: string;
  if (i.model === "minimax-h3") {
    gen = add(
      "MinimaxHailuo03ReferenceNode",
      {
        model: "MiniMax H3",
        "model.prompt": i.prompt.replace(/@(Video|Image)(\d+)/gi, (_m, kind: string, k: string) => `${kind[0].toUpperCase()}${kind.slice(1).toLowerCase()} ${k}`),
        "model.resolution": i.quality === "2K" ? "2K" : "768P",
        "model.ratio": "adaptive",
        "model.duration": Math.round(Math.min(15, Math.max(4, i.seconds))),
        "model.reference_videos.video_1": video,
        ...(image ? { "model.reference_images.image_1": image } : {}),
        seed,
        watermark: false,
      },
      "BL:refvideo",
    );
  } else {
    const quality = ["480p", "720p", "1080p"].includes(i.quality) ? i.quality : "720p";
    gen = add(
      "Wan3ReferenceToVideoApi",
      {
        model: i.model,
        "model.prompt": i.prompt,
        "model.resolution": quality.toUpperCase(),
        // the take's own shape
        "model.ratio": "adaptive",
        // reference video and output together stay within 30 s
        "model.duration": String(Math.round(Math.min(15, Math.max(2, i.seconds)))),
        "model.audio": false,
        "model.prompt_extend": true,
        "model.reference_videos.video1": video,
        ...(image ? { "model.reference_images.image1": image } : {}),
        seed,
        watermark: false,
      },
      "BL:refvideo",
    );
  }
  const outId = add("SaveVideo", { video: [gen, 0], filename_prefix: "mogfield/refvideo", format: "auto", "format.codec": "auto" }, "BL:output");
  return { graph, outId, files };
}

export const refVideo: Provider = {
  id: "refv",
  label: "Wan 3.0 and MiniMax H3 (reference video)",

  async models(): Promise<ModelOption[]> {
    return MODELS.map((m) => (hasKey() ? { ...m, available: true } : { ...m, available: false, needs: "Add COMFY_API_KEY to app/.env" }));
  },

  async generate(job: GenerateJob, hooks: ProviderHooks) {
    const key = process.env.COMFY_API_KEY?.trim();
    if (!key) throw new Error("Comfy API key missing: add COMFY_API_KEY to app/.env and restart");
    const label = job.model === "minimax-h3" ? "MiniMax H3" : "Wan 3.0";
    const { graph, outId, files } = refVideoGraph({
      model: job.model, prompt: job.prompt, video: job.clipPath, image: job.characterPath ?? job.sheetPath ?? undefined,
      quality: job.quality, seconds: job.duration, seed: job.seed,
    });
    await writeFile(job.outPath.replace(/\.mp4$/i, "") + ".workflow.json", JSON.stringify(graph, null, 2)).catch(() => {});
    const c = comfyClient();
    const wf = c.workflows.fromJson(structuredClone(graph));
    for (const f of files) wf.setInput(f.id, f.field, c.assets.fromFile(f.path));
    const local = currentBackend().target === "custom";
    console.log(`submit workflow ${label} reference video on ${local ? currentBackend().url : "Comfy Cloud"}: ${files.length} input file(s)`);
    hooks.progress(0.1, "Uploading the take");
    hooks.step?.("upload", "running", local ? "to your ComfyUI" : "to Comfy Cloud");
    let p = 0.15;
    await runGraph(
      wf,
      outId,
      job.outPath,
      {
        // partner nodes report little progress: keep the bar moving between their updates
        progress: (v) => hooks.progress((p = Math.max(p, 0.15 + v * 0.75)), "Generating"),
        message: (msg) => {
          if (/queue/i.test(msg)) hooks.step?.("queue", "running", msg);
          else hooks.step?.("generate", "running");
          hooks.progress(p, /queue/i.test(msg) ? msg : `${label} is generating`);
        },
        preview: () => {},
        signal: hooks.signal,
      },
      key,
    );
    hooks.progress(0.95, "Saved");
  },
};
