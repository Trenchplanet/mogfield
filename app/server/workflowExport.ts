// "Open in ComfyUI": the API-format graph a tool would run with the settings
// on screen, built by the same functions the jobs use. Load nodes carry
// placeholder file names (take.mp4, character.png, ...): drop the JSON onto
// ComfyUI, pick your own files in those nodes and queue it.

import { loadGraph } from "./engines/comfy.js";
import { editPrompt, SHEET_PROMPT } from "./characters.js";
import { framesGraph } from "./frames.js";
import { buildRefVideoPrompt } from "./pipeline.js";
import { seedanceText } from "./providers/schemaFill.js";
import { refVideoGraph } from "./providers/refVideo.js";
import { seedanceGraph, seedanceNodeModel } from "./providers/seedanceWorkflow.js";
import { FRAME_MODELS, RESHOOT_ANGLES, T2V_ASPECTS, type FrameModel, type ReshootAngle, type T2vAspect } from "./shared.js";
import { extendPrompt } from "./t2v.js";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }>;

export interface ExportRequest {
  tool: "create" | "extend" | "reshoot" | "restyle" | "swap" | "image";
  model?: string;
  prompt?: string;
  quality?: string;
  seconds?: number;
  aspect?: string;
  audio?: boolean;
  /** Create: whether a start / end frame is set, and how many reference images. */
  start?: boolean;
  end?: boolean;
  refs?: number;
  /** Swap / Restyle: how many character pictures. */
  characters?: number;
  angle?: string;
  style?: string;
  setting?: string;
  /** Character Swap Pro: direct (camera, lens, grade) or recast. */
  mode?: "direct" | "recast";
  /** Image: the elements to add to the photo. */
  elements?: string[];
}

const placeholders = (n: number, name: string) => Array.from({ length: n }, (_, k) => `${name}-${k + 1}.png`);

/** A whole-take tool on one model: Seedance, Wan 3.0 / MiniMax H3 reference video,
 *  the H3 swap workflow, or LTX 2.5 / H3 from text. */
async function takeGraph(model: string, r: ExportRequest, prompt: string, seconds: number, aspect: number): Promise<Graph> {
  const image = (r.characters ?? 1) > 0 ? "character.png" : undefined;
  const quality = r.quality ?? "720p";
  if (model.startsWith("h3:")) return (await loadGraph("backlot_h3_swap")) as Graph;
  if (model.startsWith("comfyui:")) return (await loadGraph("backlot_recast")) as Graph;
  if (model.startsWith("refv:")) return refVideoGraph({ model: model.slice(5), prompt, video: "take.mp4", image, quality, seconds }).graph;
  if (/ltx-2-5-(fast|pro)/.test(model) || /minimax-h3$/.test(model)) {
    const id: FrameModel = model.includes("ltx-2-5-pro") ? "ltx-2-5-pro" : model.includes("ltx") ? "ltx-2-5-fast" : "h3";
    return framesGraph({ model: id, prompt: prompt.replace(/@(Video|Image)1/g, "the source video"), quality, seconds, aspect, audio: true }).graph;
  }
  const text = seedanceText({ prompt: prompt.replace(/@Video/g, "@video").replace(/@Image/g, "@image"), videoUrl: "take.mp4", imageUrls: image ? [image] : [] });
  return seedanceGraph({ model: seedanceNodeModel(model) ? model : "seedance-2-0", text, videos: ["take.mp4"], images: image ? [image] : [], audios: [], quality, aspect, duration: seconds, audio: false }).graph;
}

export async function exportWorkflow(r: ExportRequest): Promise<{ name: string; graph: Graph }> {
  const prompt = (r.prompt ?? "").trim();
  const seconds = typeof r.seconds === "number" && Number.isFinite(r.seconds) ? r.seconds : 5;
  const aspect = r.aspect && r.aspect in T2V_ASPECTS ? T2V_ASPECTS[r.aspect as T2vAspect] : 9 / 16;
  const quality = r.quality ?? "720p";
  const frameModel = r.model && r.model in FRAME_MODELS ? (r.model as FrameModel) : "seedance-2-5";

  if (r.tool === "create") {
    const m = FRAME_MODELS[frameModel];
    if (r.start || r.end || m.text || m.needsStart) {
      const start = r.start || m.needsStart ? "start-frame.png" : undefined;
      return { name: "create", graph: framesGraph({ model: frameModel, prompt, startFrame: start, endFrame: r.end && (start || !m.text) ? "end-frame.png" : undefined, quality, seconds, aspect, audio: r.audio !== false }).graph };
    }
    const images = placeholders(Math.min(4, r.refs ?? 0), "reference");
    const text = seedanceText({ prompt, imageUrls: images });
    return { name: "create", graph: seedanceGraph({ model: frameModel, text, videos: [], images, audios: [], quality, aspect, duration: seconds, audio: r.audio !== false }).graph };
  }
  if (r.tool === "extend") {
    // the source video's last frame goes into the start frame
    return { name: "extend", graph: framesGraph({ model: frameModel, prompt: extendPrompt(prompt), startFrame: "last-frame.png", quality, seconds, aspect, audio: r.audio !== false }).graph };
  }
  if (r.tool === "image") {
    // photo -> Nano Banana 2.1 edit (the elements) -> Nano Banana 2.1 character board
    const banana = (text: string, image: [string, number], ratio: string, title: string) => ({
      class_type: "GeminiNanoBanana2V2",
      inputs: { prompt: text, model: "Gemini Nano Banana 2.1", "model.aspect_ratio": ratio, "model.resolution": "2K", "model.thinking_level": "MEDIUM", "model.images.image_1": image, seed: 42, response_modalities: "IMAGE" },
      _meta: { title },
    });
    const graph: Graph = {
      "1": { class_type: "LoadImage", inputs: { image: "photo.png" }, _meta: { title: "BL:photo" } },
      "2": banana(editPrompt(r.elements?.length ? r.elements : ["(the elements you pick)"], prompt, 0), ["1", 0], "auto", "BL:edit"),
      "3": banana(SHEET_PROMPT, ["2", 0], "16:9", "BL:board"),
      "4": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "mogfield/character" }, _meta: { title: "BL:output" } },
    };
    return { name: "image", graph };
  }
  const model = r.model ?? "";
  if (r.tool === "swap" && r.mode === "direct") return { name: "swap", graph: (await loadGraph("backlot_direct")) as Graph };
  const angle = r.angle && r.angle in RESHOOT_ANGLES ? (r.angle as ReshootAngle) : undefined;
  const text = buildRefVideoPrompt({
    characters: r.tool === "reshoot" ? 0 : Math.max(0, Math.min(4, r.characters ?? 1)),
    reshoot: r.tool === "reshoot" ? angle ?? "orbit_left" : undefined,
    style: r.style,
    setting: r.setting,
    keepScene: r.tool === "swap" && !r.setting,
    direction: prompt || undefined,
  });
  const characters = r.tool === "reshoot" ? 0 : r.characters ?? 1;
  return { name: r.tool, graph: await takeGraph(model, { ...r, characters }, text, Math.min(15, seconds), aspect) };
}
