// Video from a start frame and/or an end frame, as a ComfyUI workflow: load
// the frames -> Seedance First-Last-Frame, Wan 3.0 Image to Video, MiniMax H3
// First-Last-Frame or LTX 2.5 Image to Video -> Save Video. H3 and LTX 2.5
// also run from the prompt alone, through their text-to-video nodes. Pika H3
// Flex runs its own workflows (pika.ts), also from reference pictures. Runs on Comfy Cloud or your own ComfyUI like every other workflow,
// and each take keeps its graph as <take>.workflow.json.

import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { currentBackend } from "./backend.js";
import { comfyClient, runGraph } from "./engines/comfy.js";
import { pikaGraph } from "./pika.js";
import { nearestRatio } from "./providers/schemaFill.js";
import type { ProviderHooks } from "./providers/types.js";
import { FRAME_MODELS, snapSeconds, type FrameModel } from "./shared.js";

type Node = { class_type: string; inputs: Record<string, unknown>; _meta: { title: string } };

export interface FramesInput {
  model: FrameModel;
  prompt: string;
  startFrame?: string;
  endFrame?: string;
  quality: string;
  seconds: number;
  /** width / height of the frames, for models that ask for a ratio */
  aspect: number;
  audio: boolean;
  seed?: number;
  /** Pika H3 Flex: reference pictures, when there is no start frame */
  refs?: string[];
}

export function framesGraph(i: FramesInput): { graph: Record<string, Node>; outId: string; files: { id: string; path: string }[] } {
  const m = FRAME_MODELS[i.model];
  if (m.needsStart && !i.startFrame) throw new Error(`${m.label} needs a start frame`);
  if (!i.startFrame && !i.endFrame && !m.text) throw new Error(`${m.label} needs a start or end frame`);
  // H3 and LTX 2.5 take an end frame only together with a start frame
  if (m.text && i.endFrame && !i.startFrame) throw new Error(`${m.label} needs a start frame to go with the end frame`);
  if (i.model === "pika-h3") return pikaGraph({ ...i, seconds: snapSeconds(i.model, Math.min(m.max, Math.max(m.min, i.seconds))) });
  const graph: Record<string, Node> = {};
  const files: { id: string; path: string }[] = [];
  let n = 0;
  const add = (class_type: string, inputs: Record<string, unknown>, title: string) => {
    const id = String(++n);
    graph[id] = { class_type, inputs, _meta: { title } };
    return id;
  };
  const load = (path: string, title: string) => {
    const id = add("LoadImage", { image: basename(path) }, title);
    files.push({ id, path });
    return [id, 0];
  };
  const quality = (m.qualities as readonly string[]).includes(i.quality) ? i.quality : m.qualities[0];
  const seconds = snapSeconds(i.model, Math.min(m.max, Math.max(m.min, i.seconds)));
  const seed = i.seed ?? Math.floor(Math.random() * 2 ** 31);
  const first = i.startFrame ? load(i.startFrame, "BL:start-frame") : undefined;
  const last = i.endFrame ? load(i.endFrame, "BL:end-frame") : undefined;

  let gen: string;
  if (i.model === "h3") {
    const inputs: Record<string, unknown> = {
      model: m.node,
      "model.prompt": i.prompt,
      "model.resolution": quality === "2k" ? "2K" : "768P",
      "model.duration": seconds,
      seed,
      watermark: false,
    };
    if (first) {
      inputs.first_frame = first;
      if (last) inputs.last_frame = last;
      gen = add("MinimaxHailuo03FirstLastFrameNode", inputs, "BL:frames");
    } else {
      inputs["model.ratio"] = nearestRatio(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"], i.aspect);
      gen = add("MinimaxHailuo03TextToVideoNode", inputs, "BL:frames");
    }
  } else if (i.model.startsWith("ltx")) {
    // LTX names its size; the frame or the chosen aspect decides portrait or landscape
    const portrait = i.aspect < 1;
    const size = quality === "1080p" ? (portrait ? "1080x1920" : "1920x1080") : portrait ? "720x1280" : "1280x720";
    const inputs: Record<string, unknown> = {
      model: m.node,
      "model.duration": String(seconds),
      "model.resolution": size,
      "model.fps": "25",
      "model.generate_audio": i.audio,
      prompt: i.prompt,
      seed,
    };
    if (first) {
      inputs.image = first;
      if (last) inputs.last_frame = last;
      gen = add("LtxApi25ImageToVideo", inputs, "BL:frames");
    } else gen = add("LtxApi25TextToVideo", inputs, "BL:frames");
  } else if (i.model.startsWith("wan3")) {
    gen = add(
      "Wan3ImageToVideoApi",
      {
        model: m.node,
        "model.prompt": i.prompt,
        "model.resolution": quality.toUpperCase(),
        "model.ratio": "adaptive",
        "model.duration": String(seconds),
        "model.audio": i.audio,
        "model.prompt_extend": true,
        first_frame: first,
        ...(last ? { last_frame: last } : {}),
        seed,
        watermark: false,
      },
      "BL:frames",
    );
  } else {
    const inputs: Record<string, unknown> = {
      model: m.node,
      "model.prompt": i.prompt,
      "model.resolution": quality,
      "model.duration": seconds,
      "model.generate_audio": i.audio,
      seed,
      watermark: false,
    };
    if (i.model === "seedance-2-5") inputs["model.output_format"] = "mp4";
    else inputs["model.ratio"] = first || last ? "adaptive" : nearestRatio(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"], i.aspect);
    if (first) inputs.first_frame = first;
    if (last) inputs.last_frame = last;
    gen = add("ByteDance2FirstLastFrameNode", inputs, "BL:frames");
  }
  const outId = add("SaveVideo", { video: [gen, 0], filename_prefix: "mogfield/frames", format: "auto", "format.codec": "auto" }, "BL:output");
  return { graph, outId, files };
}

/** Run the graph on the current backend and save the video to outPath. */
export async function runFrames(i: FramesInput, outPath: string, hooks: ProviderHooks): Promise<void> {
  const key = process.env.COMFY_API_KEY?.trim();
  const local = currentBackend().target === "custom";
  // partner nodes always need the key; Pika's open-weights workflow only on Comfy Cloud
  if (!key && (i.model !== "pika-h3" || !local)) throw new Error("Comfy API key missing: add COMFY_API_KEY to app/.env and restart");
  const { graph, outId, files } = framesGraph(i);
  await writeFile(outPath.replace(/\.mp4$/i, "") + ".workflow.json", JSON.stringify(graph, null, 2)).catch(() => {});
  const c = comfyClient();
  const wf = c.workflows.fromJson(structuredClone(graph));
  for (const f of files) wf.setInput(f.id, "image", c.assets.fromFile(f.path));
  console.log(`submit workflow ${FRAME_MODELS[i.model].label} frames on ${local ? currentBackend().url : "Comfy Cloud"}: ${files.length} frame(s)`);
  hooks.progress(0.1, files.length ? "Uploading frames" : "Sending the workflow");
  let p = 0.15;
  await runGraph(
    wf,
    outId,
    outPath,
    {
      // partner nodes report little progress: keep the bar moving between their updates
      progress: (v) => hooks.progress((p = Math.max(p, 0.15 + v * 0.75)), "Generating"),
      message: (msg) => hooks.progress(p, /queue/i.test(msg) ? msg : `${FRAME_MODELS[i.model].label} is generating`),
      preview: () => {},
      signal: hooks.signal,
    },
    key,
  );
  hooks.progress(0.95, "Saved");
}
