// MiniMax H3 character swap on Comfy Cloud (workflows/backlot_h3_swap.json):
// the take as <Video 1>, the character as <Picture 1>, an optional character
// swap LoRA on the Ref2VA model. No depth, motion or SAM preparation.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comfyClient, findByTitle, loadGraph } from "../engines/comfy.js";
import { exec, probe } from "../media.js";
import { H3_DEFAULT_LORA, H3_LORAS } from "../shared.js";
import type { GenerateJob, ModelOption, Provider, ProviderHooks } from "./types.js";

const FPS = 24;
const hasKey = () => !!process.env.COMFY_API_KEY?.trim();

// The account's LoRA list from Comfy Cloud, so an imported LoRA shows as installed.
let loraList: { at: number; names: string[] } | null = null;
async function accountLoras(): Promise<string[]> {
  if (loraList && Date.now() - loraList.at < 5 * 60_000) return loraList.names;
  const res = await fetch("https://cloud.comfy.org/api/object_info", { headers: { "X-API-Key": process.env.COMFY_API_KEY!.trim() }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Comfy Cloud answered HTTP ${res.status}`);
  const info = (await res.json()) as Record<string, { input: { required: { lora_name: [unknown, { options?: string[] }?] } } }>;
  const field = info.LoraLoaderModelOnly?.input.required.lora_name;
  const names = (Array.isArray(field?.[0]) ? (field[0] as string[]) : field?.[1]?.options) ?? [];
  loraList = { at: Date.now(), names };
  return names;
}

/** The account's file for a LoRA, wherever it was imported to. */
const findLora = (names: string[], file: string) => names.find((n) => n === file || n.endsWith(`/${file}`));

/** H3 makes 24 fps clips of 17k+5 frames; the same rounding as ComfyUI's own template. */
export function h3Frames(seconds: number) {
  const n = Math.max(5, Math.round(seconds * FPS));
  return n + ((5 - (n % 17)) % 17 + 17) % 17;
}

/** Output size near the quality's pixel budget, on the source aspect, in multiples of 32. */
export function h3Size(aspect: number, quality: string) {
  const megapixels = quality === "480p" ? 0.4 : 0.98;
  const height = Math.sqrt((megapixels * 1_000_000) / aspect);
  const round = (v: number) => Math.max(256, Math.round(v / 32) * 32);
  return { width: round(height * aspect), height: round(height) };
}

export const h3Cloud: Provider = {
  id: "h3",
  label: "MiniMax H3 (Comfy Cloud)",

  async models(): Promise<ModelOption[]> {
    const base: ModelOption = {
      id: "h3:minimax-h3-swap",
      label: "MiniMax H3 · Character Swap",
      provider: "Comfy Cloud · workflow",
      badges: ["LoRA", "No prep"],
      qualities: ["480p", "768p"],
      maxSeconds: 15,
      available: false,
    };
    if (!hasKey()) return [{ ...base, needs: "Add COMFY_API_KEY to app/.env" }];
    let names: string[];
    try {
      names = await accountLoras();
    } catch (e) {
      return [{ ...base, needs: `Comfy Cloud unreachable: ${(e as Error).message}` }];
    }
    const loras = H3_LORAS.map((l) => ({ id: l.id, label: l.label, by: l.by, url: l.url, installed: !l.file || !!findLora(names, l.file) }));
    return [{ ...base, available: true, loras }];
  },

  async generate(job: GenerateJob, hooks: ProviderHooks) {
    const character = job.characterPath ?? job.sheetPath;
    if (!character) throw new Error("Add a character: H3 character swap needs a picture of who to put in the video.");
    const lora = H3_LORAS.find((l) => l.id === (job.lora ?? H3_DEFAULT_LORA)) ?? H3_LORAS[0];
    let loraFile: string | undefined;
    if (lora.file) {
      loraFile = findLora(await accountLoras(), lora.file);
      if (!loraFile) throw new Error(`${lora.label} is not in your Comfy Cloud models yet. Import it in Comfy Cloud → Model Library → Import (${lora.url}), or pick "No LoRA".`);
    }

    // the take at 24 fps, cropped to the output size and cut to H3's frame grid
    hooks.step?.("inputs", "running", "fitting the video to H3's frame grid");
    const src = await probe(job.clipPath);
    const length = h3Frames(Math.min(15, src.duration));
    const { width, height } = h3Size(src.width / src.height, job.quality);
    const dir = await mkdtemp(join(tmpdir(), "h3-swap-"));
    try {
      const take = join(dir, "take.mp4");
      await exec("ffmpeg", [
        "-y", "-v", "error", "-i", job.clipPath, "-t", String(length / FPS),
        "-vf", `fps=${FPS},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`,
        "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-c:a", "aac", "-movflags", "+faststart", take,
      ]);
      hooks.step?.("inputs", "done");

      const graph = await loadGraph("backlot_h3_swap");
      const one = (title: string) => {
        const id = findByTitle(graph, title)[0];
        if (!id) throw new Error(`workflows/backlot_h3_swap.json is missing the node titled ${title}`);
        return id;
      };
      const h3 = one("BL:h3");
      const loraNode = one("BL:lora");
      if (loraFile) graph[loraNode].inputs.lora_name = loraFile;
      else {
        // no character LoRA: the sigma shift reads the turbo model directly
        graph[one("BL:model-out")].inputs.model = graph[loraNode].inputs.model;
        delete graph[loraNode];
      }
      // the take's own sound conditions the performance (mouth movement); H3's audio is replaced afterwards
      if (src.hasAudio) graph[h3].inputs["ref_video_audios.ref_video_audio_0"] = [one("BL:video-parts"), 1];
      Object.assign(graph[h3].inputs, { prompt: job.prompt, width, height, length });
      graph[one("BL:seed")].inputs.noise_seed = job.seed ?? Math.floor(Math.random() * 2 ** 31);

      const c = comfyClient();
      const wf = c.workflows.fromJson(structuredClone(graph));
      wf.setInput(one("BL:video"), "file", c.assets.fromFile(take));
      wf.setInput(one("BL:image"), "image", c.assets.fromFile(character));
      console.log(`submit h3 swap: ${width}x${height} · ${length} frames · lora=${loraFile ?? "none"} · source audio=${src.hasAudio ? "yes" : "no"}`);

      hooks.progress(0.1, "Uploading to Comfy Cloud");
      hooks.step?.("upload", "running");
      const run = await c.submit(wf, { signal: hooks.signal });
      hooks.step?.("upload", "done");
      hooks.step?.("queue", "running");
      try {
        for await (const ev of run.events(hooks.signal)) {
          if (ev.kind === "statusChange" && ev.status === "queued") {
            hooks.progress(0.15, ev.queuePosition != null ? `Comfy · queued (#${ev.queuePosition})` : "Comfy · queued");
            if (ev.queuePosition != null) hooks.step?.("queue", "running", `queue #${ev.queuePosition}`);
          }
          if (ev.kind === "progress") {
            hooks.step?.("queue", "done");
            hooks.step?.("generate", "running", ev.currentNodeClass ?? undefined);
            hooks.progress(0.2 + 0.7 * Math.max(0, Math.min(1, ev.value)), ev.currentNodeClass ? `H3 · ${ev.currentNodeClass}` : "H3 is generating");
          }
          if (ev.kind === "statusChange" && ["succeeded", "failed", "canceled", "expired"].includes(ev.status)) break;
        }
      } catch (error) {
        if (hooks.signal?.aborted) throw error;
      }
      await run.result(hooks.signal);
      hooks.step?.("generate", "done");
      hooks.step?.("finish", "running", "downloading the video");
      const files = run.getOutputs(one("BL:output"));
      const output = files.find((f) => /video|mp4/.test(f.contentType)) ?? files[0];
      if (!output) throw new Error("Comfy Cloud finished without a video output.");
      await output.toFile(job.outPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
