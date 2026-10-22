import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENJUTSU_DIR } from "./config.js";
import { comfyClient, findByTitle, loadGraph } from "./engines/comfy.js";
import { exec, probe } from "./media.js";
import type { PersonBox, ShotPick, StepState } from "./shared.js";

const MEDIA_HELPER = join(import.meta.dirname, "genjustsu_media.py");

export interface PreparationHooks {
  progress: (progress: number, message: string) => void;
  /** Checklist updates: a named step (see PREPARATION_STEPS) and an optional live note. */
  step?: (key: string, state: StepState, note?: string) => void;
  signal?: AbortSignal;
}

export interface PreparationResult {
  sourcePath: string;
  seedanceInputPath: string;
  seedanceInputUrl: string;
  depthPath: string;
  depthUrl: string;
  maskUrl: string;
  overlayUrl: string;
  compositeUrl: string;
  manifestHash: string;
  duration: number;
}

async function runComfyWorkflow(input: {
  name: string;
  files: Array<{ title: string; field: string; path: string }>;
  values: Array<{ title: string; field: string; value: unknown }>;
  outputs: Array<{ title: string; path: string; label: string }>;
  progress: { start: number; end: number };
  message: string;
  /** Checklist step this workflow belongs to. */
  step: string;
  /** Change the graph before it is sent (e.g. add box prompts). */
  edit?: (graph: Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>) => void;
}, hooks: PreparationHooks): Promise<void> {
  if (!process.env.COMFY_API_KEY?.trim() && !process.env.COMFY_BASE_URL?.trim()) {
    throw new Error("Genjustsu preparation needs a Comfy API key or a configured ComfyUI endpoint. Set COMFY_API_KEY in app/.env for Comfy Cloud, or COMFY_BASE_URL for your own ComfyUI.");
  }
  const c = comfyClient();
  const graph = await loadGraph(input.name);
  input.edit?.(graph as never);
  const outputIds = input.outputs.map(({ title, label }) => {
    const id = findByTitle(graph, title)[0];
    if (!id) throw new Error(`workflows/${input.name}.json is missing the ${label} output node (${title}).`);
    return { id, ...input.outputs.find((o) => o.title === title)! };
  });
  const wf = c.workflows.fromJson(structuredClone(graph));
  for (const binding of input.files) {
    for (const id of findByTitle(graph, binding.title)) wf.setInput(id, binding.field, c.assets.fromFile(binding.path));
  }
  for (const binding of input.values) {
    for (const id of findByTitle(graph, binding.title)) wf.setInput(id, binding.field, binding.value);
  }

  hooks.progress(input.progress.start, input.message);
  hooks.step?.(input.step, "running", "uploading to Comfy");
  const job = await c.submit(wf, { signal: hooks.signal });
  hooks.step?.(input.step, "running", "waiting for Comfy");
  try {
    for await (const ev of job.events(hooks.signal)) {
      if (ev.kind === "progress") {
        const progress = input.progress.start + (input.progress.end - input.progress.start) * Math.max(0, Math.min(1, ev.value));
        hooks.progress(progress, ev.currentNodeClass ? `Comfy · ${ev.currentNodeClass}` : input.message);
        hooks.step?.(input.step, "running", "running on Comfy");
      }
      if (ev.kind === "statusChange" && ev.status === "queued" && ev.queuePosition != null) {
        hooks.progress(input.progress.start + 0.01, `Comfy · queued (#${ev.queuePosition})`);
        hooks.step?.(input.step, "running", `Comfy queue #${ev.queuePosition}`);
      }
      if (ev.kind === "statusChange" && ["succeeded", "failed", "canceled", "expired"].includes(ev.status)) break;
    }
  } catch (error) {
    if (hooks.signal?.aborted) throw error;
  }
  // Comfy has finished computing; collecting the outputs can take a while on a busy queue
  hooks.step?.(input.step, "running", "Comfy finished · downloading result");
  await job.result(hooks.signal);

  const save = async (outputId: string, path: string, label: string) => {
    const files = job.getOutputs(outputId);
    const output = files.find((item) => /video|audio|mp4|wav|flac/.test(item.contentType)) ?? files[0];
    if (!output) throw new Error(`Comfy finished without a ${label} output.`);
    await output.toFile(path);
  };
  await Promise.all(outputIds.map(({ id, path, label }) => save(id, path, label)));
}

/** Switch the SAM 3 segment node to box mode: SAM3CreateBox per person → SAM3CombineBoxes. */
export function addPeopleBoxes(graph: Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>, people: PersonBox[], frame: number) {
  const seg = Object.keys(graph).find((id) => graph[id]._meta?.title?.trim().toUpperCase() === "BL:SEGMENT");
  if (!seg) throw new Error("workflows/backlot_genjustsu_sam.json is missing the BL:segment node.");
  const combine = "bl_people";
  graph[combine] = { class_type: "SAM3CombineBoxes", inputs: {}, _meta: { title: "Picked people" } };
  people.slice(0, 5).forEach((b, i) => {
    const id = `bl_person_${i + 1}`;
    graph[id] = { class_type: "SAM3CreateBox", inputs: { center_x: b.x + b.w / 2, center_y: b.y + b.h / 2, width: b.w, height: b.h, is_positive: true }, _meta: { title: `Person ${i + 1}` } };
    graph[combine].inputs[`box_${i + 1}`] = [id, 0];
  });
  Object.assign(graph[seg].inputs, { prompt_mode: "box", text_prompt: "", positive_boxes: [combine, 0], frame_idx: Math.max(0, frame) });
}

/** SAM 3 shot by shot: each shot's depth frames get their own box prompts (tracking
 *  cannot follow a person through a hard cut), shots without boxes get an empty
 *  mask, and the masks are joined back into one video frame for frame. */
async function segmentShots(shots: ShotPick[], colorDepth: string, maskVideo: string, dir: string, hooks: PreparationHooks) {
  const fps = 24;
  const depth = await probe(colorDepth);
  const total = Math.round(depth.duration * fps);
  const parts = shots
    .map((s) => ({ ...s, f0: Math.max(0, Math.round(s.start * fps)), f1: Math.min(total, Math.round(s.end * fps)) }))
    .filter((s) => s.f1 > s.f0)
    .sort((a, b) => a.f0 - b.f0);
  // every frame belongs to exactly one shot: fill gaps with empty shots
  const filled: typeof parts = [];
  let at = 0;
  for (const s of parts) {
    if (s.f0 > at) filled.push({ start: at / fps, end: s.f0 / fps, at: at / fps, people: [], f0: at, f1: s.f0 });
    const f0 = Math.max(s.f0, at);
    if (s.f1 > f0) filled.push({ ...s, f0 });
    at = Math.max(at, s.f1);
  }
  if (at < total) filled.push({ start: at / fps, end: total / fps, at: at / fps, people: [], f0: at, f1: total });

  const tracked = filled.filter((s) => s.people.length).length;
  let done = 0;
  hooks.step?.("sam", "running", `${tracked} shot(s) with people to track`);
  hooks.progress(0.5, `Comfy · SAM 3 on ${tracked} shot(s)`);
  const masks = await Promise.all(
    filled.map(async (s, i) => {
      const n = s.f1 - s.f0;
      const mask = join(dir, `shot-${i + 1}-mask.mp4`);
      if (!s.people.length) {
        await exec("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=black:size=${depth.width}x${depth.height}:rate=${fps}`, "-frames:v", String(n), "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "18", mask]);
        return { mask, n };
      }
      const clip = join(dir, `shot-${i + 1}-depth.mp4`);
      await exec("ffmpeg", ["-y", "-v", "error", "-i", colorDepth, "-vf", `trim=start_frame=${s.f0}:end_frame=${s.f1},setpts=PTS-STARTPTS`, "-an", "-r", String(fps), "-c:v", "libx264", "-crf", "16", clip]);
      await runComfyWorkflow({
        name: "backlot_genjustsu_sam",
        files: [{ title: "BL:video", field: "file", path: clip }],
        values: [],
        edit: (graph) => addPeopleBoxes(graph, s.people, Math.min(n - 1, Math.max(0, Math.round(s.at * fps) - s.f0))),
        outputs: [{ title: "BL:mask-output", path: mask, label: `SAM mask video for shot ${i + 1}` }],
        progress: { start: 0.5, end: 0.5 },
        message: `Comfy · SAM 3 tracking shot ${i + 1}`,
        step: "sam",
      }, { ...hooks, progress: () => {} });
      done++;
      hooks.progress(0.5 + (0.22 * done) / tracked, `Comfy · SAM 3 · ${done} of ${tracked} shot(s) tracked`);
      return { mask, n };
    }),
  );
  // join: each part scaled to the depth size and held to exactly its own frame count
  const inputs = masks.flatMap((m) => ["-i", m.mask]);
  const chains = masks.map((m, i) => `[${i}:v]scale=${depth.width}:${depth.height},setsar=1,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop=${m.n},trim=end_frame=${m.n},setpts=PTS-STARTPTS[v${i}]`);
  const filter = `${chains.join(";")};${masks.map((_, i) => `[v${i}]`).join("")}concat=n=${masks.length}:v=1:a=0[out]`;
  await exec("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-r", String(fps), "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", maskVideo]);
}

/** The exact audio extraction preparation hashes as `originalAudio`. */
function extractSourceAudio(source: string, wav: string) {
  return exec("ffmpeg", ["-y", "-v", "error", "-i", source, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", wav]);
}

/** The 16-bit samples of a PCM WAV (headers and tags ignored), or null. */
export async function readWavSamples(path: string): Promise<Int16Array | null> {
  try {
    const buf = await readFile(path);
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
    for (let at = 12; at + 8 <= buf.length; ) {
      const id = buf.toString("ascii", at, at + 4);
      const size = buf.readUInt32LE(at + 4);
      if (id === "data") {
        const data = buf.subarray(at + 8, Math.min(buf.length, at + 8 + size));
        return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~1)));
      }
      at += 8 + size + (size % 2);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Same audio? Equal length and every sample within 2 steps, so a different
 * ffmpeg build (AAC decoders round slightly differently) still matches while
 * a different clip never does.
 */
export function sameSamples(a: Int16Array, b: Int16Array): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 2) return false;
  return true;
}

/** A clip's audio as preparation extracts it, or null without audio. */
export async function sourceAudioSamples(source: string): Promise<Int16Array | null> {
  const dir = await mkdtemp(join(tmpdir(), "mogfield-fp-"));
  try {
    const wav = join(dir, "a.wav");
    await extractSourceAudio(source, wav);
    return await readWavSamples(wav);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Public URLs of a preparation's review videos. */
export function preparationUrls(id: string) {
  const base = "/media/genjustsu/" + id + "/";
  return {
    seedanceInputUrl: base + "seedance-input.mp4",
    depthUrl: base + "depth-color.mp4",
    maskUrl: base + "mask-preview.mp4",
    overlayUrl: base + "mask-overlay.mp4",
    compositeUrl: base + "composite-silent.mp4",
  };
}

function helper(args: string[]) {
  return exec(process.env.PYTHON_BIN?.trim() || "python3", [MEDIA_HELPER, ...args]);
}

async function sha(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Which file in a preparation folder each manifest entry hashes. */
export const MANIFEST_FILES: Record<string, string> = {
  normalizedSource: "original.mp4",
  originalAudio: "original-audio.wav",
  vocals: "vocals.wav",
  pitchedVocals: "vocals-plus3.wav",
  depth: "depth-color.mp4",
  binaryMasks: "mask-preview.mp4",
  maskOverlay: "mask-overlay.mp4",
  maskReport: "mask-review.json",
  composite: "composite-silent.mp4",
  seedanceInput: "seedance-input.mp4",
};

/**
 * Re-check a finished preparation against its manifest, so a review approval
 * still means "these exact files" after a restart. Returns what is wrong, or
 * null when every file and the manifest hash still match.
 */
export async function verifyPreparation(dir: string, manifestHash: string): Promise<string | null> {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  } catch {
    return "manifest.json is missing";
  }
  const { manifestHash: stored, reviewRequired: _reviewRequired, ...hashed } = manifest;
  if (stored !== manifestHash) return "manifest hash differs";
  if (createHash("sha256").update(JSON.stringify(hashed)).digest("hex") !== manifestHash) return "manifest was edited";
  for (const [key, file] of Object.entries(MANIFEST_FILES)) {
    const actual = await sha(join(dir, file)).catch(() => null);
    if (actual === null) return `${file} is missing`;
    if (actual !== hashed[key]) return `${file} changed`;
  }
  return null;
}

export async function prepareGenjustsu(input: {
  id: string;
  sourcePath: string;
  segmentPrompt: string;
  people?: PersonBox[];
  peopleAt?: number;
  shots?: ShotPick[];
}, hooks: PreparationHooks): Promise<PreparationResult> {
  if (!(await probe(input.sourcePath)).hasAudio) throw new Error("This workflow needs a source audio track for vocal separation and final audio restoration.");
  const rubberband = process.env.RUBBERBAND_BIN?.trim() || "rubberband";
  const dir = join(GENJUTSU_DIR, input.id);
  const masksDir = join(dir, "raw-masks");
  await mkdir(dir, { recursive: true });
  await mkdir(masksDir, { recursive: true });
  const original = join(dir, "original.mp4");
  const sourceAudio = join(dir, "original-audio.wav");
  const depthRaw = join(dir, "depth-gray.mp4");
  const colorDepth = join(dir, "depth-color.mp4");
  const maskVideo = join(dir, "sam-masks.mp4");
  const vocals = join(dir, "vocals.wav");
  const pitched = join(dir, "vocals-plus3.wav");
  const compositeSilent = join(dir, "composite-silent.mp4");
  const maskPreview = join(dir, "mask-preview.mp4");
  const maskOverlay = join(dir, "mask-overlay.mp4");
  const report = join(dir, "mask-review.json");
  const seedanceInput = join(dir, "seedance-input.mp4");

  hooks.step?.("normalize", "running");
  hooks.progress(0.02, "Normalizing source · 24 fps, max 960 px");
  await exec("ffmpeg", ["-y", "-v", "error", "-i", input.sourcePath, "-t", "30", "-vf", "scale='if(gt(iw,ih),min(960,iw),-2)':'if(gt(iw,ih),-2,min(960,ih))',fps=24,format=yuv420p", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-movflags", "+faststart", original]);
  const normalizedProbe = await probe(original);
  if (normalizedProbe.duration < 1 || normalizedProbe.duration > 30.5) throw new Error("Prepared video must be between 1 and 30 seconds.");
  hooks.progress(0.08, "Extracting original audio for Comfy separation");
  await extractSourceAudio(input.sourcePath, sourceAudio);

  await runComfyWorkflow({
    name: "backlot_genjustsu",
    files: [
      { title: "BL:video", field: "file", path: original },
      { title: "BL:audio", field: "audio", path: sourceAudio },
    ],
    // depth frames back at the normalized video's (even) size: H.264 refuses odd heights such as 512x1003
    values: [
      { title: "BL:depth-size", field: "width", value: normalizedProbe.width },
      { title: "BL:depth-size", field: "height", value: normalizedProbe.height },
    ],
    outputs: [
      { title: "BL:depth-output", path: depthRaw, label: "depth video" },
      { title: "BL:vocals-output", path: vocals, label: "separated vocal stem" },
    ],
    progress: { start: 0.12, end: 0.47 },
    message: "Comfy · depth estimation and vocal separation",
    step: "depth",
  }, hooks);
  hooks.progress(0.48, "Colorizing depth for SAM 3");
  await helper(["colorize", depthRaw, colorDepth]);
  if (input.shots?.length) await segmentShots(input.shots, colorDepth, maskVideo, dir, hooks);
  else
    await runComfyWorkflow({
      name: "backlot_genjustsu_sam",
      files: [{ title: "BL:video", field: "file", path: colorDepth }],
      values: input.people?.length ? [] : [{ title: "BL:segment", field: "text_prompt", value: input.segmentPrompt }],
      // picked people: one box prompt per person on the chosen frame, tracked both ways through the clip
      edit: input.people?.length ? (graph) => addPeopleBoxes(graph, input.people!, Math.round((input.peopleAt ?? 0) * 24)) : undefined,
      outputs: [{ title: "BL:mask-output", path: maskVideo, label: "SAM mask video" }],
      progress: { start: 0.5, end: 0.72 },
      message: "Comfy · SAM 3 tracking on the colored depth video",
      step: "sam",
    }, hooks);
  hooks.progress(0.73, "Extracting SAM 3 masks for review");
  await helper(["extract-mask-video", maskVideo, masksDir]);

  hooks.step?.("composite", "running");
  hooks.progress(0.77, "Compositing depth subject and preparing mask review");
  await helper(["composite", original, colorDepth, masksDir, compositeSilent, maskOverlay, maskPreview, report]);
  const duration = normalizedProbe.duration;
  hooks.step?.("pitch", "running");
  await exec(rubberband, ["--fine", "--pitch", "3", "--time", "1", vocals, pitched]).catch((e) => {
    throw new Error("Rubber Band is required for the +3 semitone vocal pass. Install it with `brew install rubberband`, or set RUBBERBAND_BIN. " + (e as Error).message.slice(0, 180));
  });
  hooks.step?.("package", "running");
  hooks.progress(0.9, "Embedding pitched vocals into the prepared video");
  await exec("ffmpeg", ["-y", "-v", "error", "-i", compositeSilent, "-i", pitched, "-map", "0:v:0", "-map", "1:a:0", "-t", duration.toFixed(3), "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", seedanceInput]);

  hooks.progress(0.97, "Hashing review artifacts");
  const manifest = {
    normalizedSource: await sha(original), originalAudio: await sha(sourceAudio), vocals: await sha(vocals), pitchedVocals: await sha(pitched),
    depth: await sha(colorDepth), binaryMasks: await sha(maskPreview), maskOverlay: await sha(maskOverlay),
    maskReport: await sha(report), composite: await sha(compositeSilent), seedanceInput: await sha(seedanceInput),
    segmentPrompt: input.segmentPrompt, ...(input.people?.length ? { people: input.people, peopleAt: input.peopleAt ?? 0 } : {}), ...(input.shots?.length ? { shots: input.shots } : {}), preparationProvider: "Comfy Cloud workflows · Depth Anything V2 · SAM 3 · audio separation",
  };
  const manifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...manifest, manifestHash, reviewRequired: true }, null, 2));
  await writeFile(join(dir, "audio-manifest.json"), JSON.stringify({ separation: "Comfy AudioSeparation", pitch_semitones: 3, final_audio: "complete original source soundtrack" }, null, 2));
  hooks.step?.("package", "done");
  hooks.progress(1, "Prepared · review the prepared video before generating");
  return {
    sourcePath: input.sourcePath,
    seedanceInputPath: seedanceInput,
    seedanceInputUrl: "/media/genjustsu/" + input.id + "/seedance-input.mp4",
    depthPath: colorDepth,
    depthUrl: "/media/genjustsu/" + input.id + "/depth-color.mp4",
    maskUrl: "/media/genjustsu/" + input.id + "/mask-preview.mp4",
    overlayUrl: "/media/genjustsu/" + input.id + "/mask-overlay.mp4",
    compositeUrl: "/media/genjustsu/" + input.id + "/composite-silent.mp4",
    manifestHash,
    duration,
  };
}
