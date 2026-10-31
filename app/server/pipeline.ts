import { reshootCamera, type ReshootAngle, type ReshootView } from "./shared.js";
// Mogfield's automatic Recast: video + characters in, video out. No prompt
// from the user — every step below is our logic.
//
//   take ─▶ depth map ─▶ motion measurement ─┐
//   characters ─▶ reference sheet ───────────┼─▶ prompt ─▶ provider ─▶ video
//                                            ┘

import { existsSync } from "node:fs";
import { join } from "node:path";
import { RENDER_DIR } from "./config.js";
import { depthPath, generateDepth } from "./depth.js";
import { analyzeMotion } from "./motion.js";
import { restoreSourceAudio } from "./media.js";
import { providerFor, type Quality } from "./providers/index.js";
import { buildH3SwapPrompt, buildMiniMaxH3Prompt, buildPromptPack, buildTextOnlyPrompt } from "./seedance.js";
import { buildSheet } from "./sheet.js";

/** Most reference video, in seconds, Seedance accepts in one request (all videos together). */
export const SEEDANCE_REFERENCE_SECONDS = 15;

const ORDINAL = ["first", "second", "third", "fourth"];

/** The user's @mentions point at their characters in order (@image1 = first
 *  character). The model sees one combined sheet, so name them by position on
 *  it; @video means the user's own video (with a prepared take, the one
 *  reference video). Unknown mentions are left as typed. */
export function mentionsToWords(text: string, characters: number, video = "the original video"): string {
  return text
    .replace(/@image(\d+)/gi, (m, n) => {
      const k = Number(n) - 1;
      return k >= 0 && k < characters ? `the ${ORDINAL[k] ?? `#${k + 1}`} character on the reference sheet` : m;
    })
    .replace(/@video\d*/gi, video);
}

export interface PipelineInput {
  renderId: string;
  clipId: string;
  clipPath: string;
  clipUrl: string;
  width: number;
  height: number;
  duration: number;
  characters: { path: string; url: string; label: string }[];
  scene?: string;
  keepBackground: boolean;
  background?: string;
  model: string;
  quality: Quality;
  draftPreview?: boolean;
  preparedVideoPath?: string;
  preparedVideoUrl?: string;
  preparedAudioPath?: string;
  preparedDepthPath?: string;
  preparedDepthUrl?: string;
  /** MiniMax H3 character swap: H3_LORAS id. */
  lora?: string;
  seed?: number;
  /** false: no depth map; the original video is the reference. */
  useDepth?: boolean;
  /** false: the model gets a silent video. */
  sendAudio?: boolean;
  /** Style swap: restyle the whole shot after the first reference image. */
  restyle?: boolean;
  /** Re-shoot from another camera angle (RESHOOT_ANGLES key). */
  reshoot?: ReshootAngle;
  /** Re-shoot from a free viewpoint (the 3D angle picker); overrides the preset's camera words. */
  reshootView?: ReshootView;
  /** Visual style for the whole shot. */
  style?: string;
  outPath: string;
}

export interface PipelineHooks {
  progress: (p: number, message: string) => void;
  /** Checklist updates for the progress screen (keys from SEEDANCE_STEPS). */
  step?: (key: string, state: "running" | "done", note?: string) => void;
  signal?: AbortSignal;
}

// overall progress budget per stage
const STAGES = { depth: [0, 0.3], motion: [0.3, 0.33], sheet: [0.33, 0.36], generate: [0.36, 1] } as const;
const span = (stage: keyof typeof STAGES, p: number) => STAGES[stage][0] + (STAGES[stage][1] - STAGES[stage][0]) * Math.max(0, Math.min(1, p));

export async function runRecast(i: PipelineInput, hooks: PipelineHooks) {
  const target = providerFor(i.model);
  if (!target) throw new Error(`unknown model ${i.model}`);
  hooks.step?.("inputs", "running");
  const option = (await target.provider.models()).find((m) => m.id === i.model);
  if (option && !option.available) throw new Error(`${option.label} is not connected yet: ${option.needs ?? "unavailable"}`);
  if (option && i.duration > option.maxSeconds + 0.5)
    throw new Error(`${option.label} makes up to ${option.maxSeconds} s. Trim your video to ${option.maxSeconds} s or less.`);
  if (target.provider.id === "h3") return runH3Swap(i, target, hooks);
  // Pika H3 Flex takes the take as <Video 1>: swap like H3, or restyle / re-shoot like the reference-video models
  if (target.provider.id === "pika") return target.model === "h3-flex-swap" ? runH3Swap(i, target, hooks) : runRefVideo(i, target, hooks);
  if (target.provider.id === "refv") return runRefVideo(i, target, hooks);
  const textOnlyLtx = target.provider.id === "comfy" && target.model.startsWith("ltx/ltx-2-5-");
  const miniMaxH3 = target.provider.id === "comfy" && target.model === "minimax/minimax-h3";

  // 1. depth map of the take (cached per clip), unless the user turned depth off
  const noDepth = i.useDepth === false && !i.preparedVideoPath;
  // Seedance rejects requests whose reference videos add up to more than ~15 s
  // ("invalid_input", observed Oct 2026), so a long take sends the depth map alone
  const seedance = target.provider.id === "comfy" && target.model.includes("seedance");
  const keepOriginal = i.keepBackground && (!seedance || i.duration * 2 <= SEEDANCE_REFERENCE_SECONDS + 0.05);
  if (i.keepBackground && !keepOriginal && !noDepth && !i.preparedVideoPath)
    hooks.step?.("inputs", "running", `background reference left out: Seedance takes at most ${SEEDANCE_REFERENCE_SECONDS} s of reference video in total`);
  const dPath = noDepth ? i.clipPath : depthPath(i.clipId);
  if (!noDepth && !existsSync(dPath)) {
    await generateDepth(i.clipPath, i.clipId, { progress: (p) => hooks.progress(span("depth", p), "Mapping depth"), signal: hooks.signal });
  }

  // 2. camera and subject motion, measured
  hooks.progress(span("motion", 0), "Measuring motion");
  const motion = await analyzeMotion(i.clipPath, noDepth ? undefined : dPath);

  // 3. reference sheet from the characters
  let sheetPath: string | null = null;
  const restyle = !!i.restyle && noDepth && !textOnlyLtx && !miniMaxH3 && i.characters.length > 0;
  // a style reference goes in as-is: putting a car or a set on a grey character sheet would only shrink it
  if (restyle) sheetPath = i.characters[0].path;
  else if (i.characters.length && !textOnlyLtx) {
    hooks.progress(span("sheet", 0), "Building reference sheet");
    sheetPath = join(RENDER_DIR, `${i.renderId}-sheet.png`);
    await buildSheet(i.characters.map((c) => c.path), sheetPath);
  }

  // 4. the prompt
  const mentions = (t?: string) => (t ? mentionsToWords(t, i.characters.length, i.preparedVideoPath ? "the reference video" : undefined) : t);
  const textOnlyMentions = (t?: string) =>
    t
      ?.replace(/@image(\d+)/gi, (_m, n) => {
        const label = i.characters[Number(n) - 1]?.label;
        return label ? `the character ${label}` : `character ${n}`;
      })
      .replace(/@video\d*/gi, "the camera and subject movement measured from the source clip");
  const pack = buildPromptPack({
    depthUrl: i.preparedVideoUrl ?? `/media/depth/${i.clipId}.mp4`,
    preparedVideo: !!i.preparedVideoPath,
    sourceVideo: noDepth,
    restyle,
    reshoot: noDepth ? i.reshoot : undefined,
    reshootView: noDepth ? i.reshootView : undefined,
    style: i.style,
    originalUrl: i.clipUrl,
    references: [],
    sheet: sheetPath ? { tag: "@image1", url: restyle ? i.characters[0].url : `/media/renders/${i.renderId}-sheet.png`, characters: Math.min(4, i.characters.length) } : undefined,
    scene: textOnlyLtx ? undefined : mentions(i.scene),
    background: textOnlyLtx ? undefined : keepOriginal ? undefined : mentions(i.background),
    keepBackground: i.preparedVideoPath || noDepth ? undefined : keepOriginal ? { tag: "@video2", url: i.clipUrl } : undefined,
    motion,
  });
  const duration = Math.min(option?.maxSeconds ?? 30, Math.max(4, Math.floor(i.duration + 0.05)));
  const textPrompt = textOnlyLtx
    ? buildTextOnlyPrompt({
        scene: textOnlyMentions(i.scene),
        background: i.keepBackground ? undefined : textOnlyMentions(i.background),
        characterLabels: i.characters.map((c) => c.label),
        motion,
        duration,
        aspect: i.width / i.height,
      })
    : miniMaxH3
      ? buildMiniMaxH3Prompt({
          scene: textOnlyMentions(i.scene),
          background: i.keepBackground ? undefined : textOnlyMentions(i.background),
          characterLabels: i.characters.map((c) => c.label),
          hasCharacterSheet: !!sheetPath,
          motion,
          duration,
          aspect: i.width / i.height,
        })
      : pack.prompt;

  // 5. the model
  let last: number = STAGES.generate[0];
  const result = await target.provider.generate(
    {
      model: target.model,
      clipPath: i.clipPath,
      depthPath: dPath,
      // a prepared take is the only video Seedance receives (no depth or original video)
      preparedVideoPath: i.preparedVideoPath,
      preparedAudioPath: i.preparedAudioPath,
      sendAudio: i.sendAudio,
      sheetPath,
      // without depth the original video is already the one reference (depthPath = clipPath)
      originalPath: i.preparedVideoPath || noDepth ? undefined : keepOriginal ? i.clipPath : undefined,
      prompt: textPrompt,
      negative: textOnlyLtx ? "" : pack.negative,
      quality: i.quality,
      duration,
      aspect: i.width / i.height,
      outPath: i.outPath,
      draftPreview: i.draftPreview,
    },
    {
      progress: (p, m) => {
        if (p >= 0) last = span("generate", p);
        hooks.progress(last, m);
      },
      step: hooks.step,
      signal: hooks.signal,
    },
  );
  if (miniMaxH3) hooks.step?.("finish", "running", "keeping MiniMax's generated audio");
  else {
    hooks.step?.("finish", "running", "putting your original audio back");
    await restoreSourceAudio(i.clipPath, i.outPath);
  }
  hooks.step?.("finish", "done");
  return { pack, draftTaskId: result && "draftTaskId" in result ? result.draftTaskId : undefined };
}

/** H3 character swap: the take and the character go straight to the model —
 *  no depth map, motion measurement or SAM preparation. */
async function runH3Swap(i: PipelineInput, target: NonNullable<ReturnType<typeof providerFor>>, hooks: PipelineHooks) {
  if (!i.characters.length) throw new Error("Add a character: H3 character swap needs a picture of who to put in the video.");
  // one character goes in as-is; several share one sheet, left to right
  let sheetPath: string | null = null;
  if (i.characters.length > 1) {
    hooks.progress(0.03, "Building reference sheet");
    sheetPath = join(RENDER_DIR, `${i.renderId}-sheet.png`);
    await buildSheet(i.characters.map((c) => c.path), sheetPath);
  }
  const prompt = buildH3SwapPrompt({
    characters: Math.min(4, i.characters.length),
    sheet: !!sheetPath,
    silhouette: !!i.preparedVideoPath,
    direction: i.scene?.replace(/@image(\d+)/gi, (_m, n) => `character ${n}`).replace(/@video\d*/gi, "the source video"),
  });
  await target.provider.generate(
    {
      model: target.model,
      // the SAM 3 silhouette take when there is one; the original audio is restored from i.clipPath below
      clipPath: i.preparedVideoPath ?? i.clipPath,
      depthPath: "",
      sheetPath,
      characterPath: sheetPath ? undefined : i.characters[0].path,
      prompt,
      negative: "",
      quality: i.quality,
      duration: i.duration,
      aspect: i.width / i.height,
      outPath: i.outPath,
      lora: i.lora,
      seed: i.seed,
    },
    { progress: hooks.progress, step: hooks.step, signal: hooks.signal },
  );
  hooks.step?.("finish", "running", "putting your original audio back");
  await restoreSourceAudio(i.clipPath, i.outPath);
  hooks.step?.("finish", "done");
  return { pack: { prompt, negative: "", uploads: [], timeline: [] }, draftTaskId: undefined };
}

/** The take itself as @Video1 for Wan 3.0 / MiniMax H3 reference to video:
 *  a character swap, a restyle (in words, or after @Image1) or a re-shoot. */
export function buildRefVideoPrompt(o: { characters: number; restyle?: boolean; reshoot?: ReshootAngle; reshootView?: ReshootView; style?: string; setting?: string; direction?: string; keepScene?: boolean }): string {
  const extra = [o.style && `Visual style: ${o.style}`, o.setting && `Setting: ${o.setting}`, o.direction && `Direction: ${o.direction}`]
    .filter(Boolean)
    .map((x) => String(x).trim().replace(/([^.!?])$/, "$1."))
    .join(" ");
  const keep = "Keep the exact motion, timing, action and performance of @Video1 in one continuous take.";
  if (o.reshoot)
    return `The same moment as @Video1, filmed again from a new camera position: ${reshootCamera(o.reshoot, o.reshootView)}. Same people with the same faces, hair and clothes, same place, same lighting. ${keep} ${extra}`.trim();
  if (o.restyle) return `Restyle @Video1 in the look of @Image1: its people, world, colours and visual style. ${keep} Same framing and camera movement. ${extra}`.trim();
  if (!o.characters) return `Restyle @Video1 completely: new look for the people, the place and the picture. ${keep} Same framing and camera movement. ${extra}`.trim();
  // tested on Wan 3.0: without this the background of the picture slowly takes over the scene
  const scene = o.keepScene
    ? "Only the person changes: the place, background, other people, props, lighting and colours stay exactly as in @Video1 for the whole video. Take nothing from the background of @Image1. "
    : "";
  return `Completely replace the main person in @Video1 with the person from @Image1, exactly as they look in @Image1: face, hair, skin, body and clothing; nothing of the original person's look remains. Clothing @Image1 does not show is completed plainly so they are fully dressed. ${scene}${o.characters > 1 ? "@Image1 is a sheet of characters left to right; the most prominent person becomes the leftmost character, the next the second, and so on. " : ""}${keep} Same camera movement and framing as @Video1. ${extra}`.trim();
}

async function runRefVideo(i: PipelineInput, target: NonNullable<ReturnType<typeof providerFor>>, hooks: PipelineHooks) {
  if (!i.characters.length && !i.reshoot && !i.style) throw new Error(i.restyle ? "Add a picture to restyle after." : "Add a character: the character swap needs a picture of who to put in the video.");
  // one picture goes in as-is; several share one sheet, left to right
  let sheetPath: string | null = null;
  if (i.characters.length > 1 && !i.restyle) {
    hooks.progress(0.03, "Building reference sheet");
    sheetPath = join(RENDER_DIR, `${i.renderId}-sheet.png`);
    await buildSheet(i.characters.map((c) => c.path), sheetPath);
  }
  hooks.step?.("inputs", "done");
  const prompt = buildRefVideoPrompt({
    characters: Math.min(4, i.characters.length),
    restyle: i.restyle,
    reshoot: i.reshoot,
    reshootView: i.reshootView,
    style: i.style,
    setting: i.keepBackground ? undefined : i.background,
    keepScene: i.keepBackground,
    direction: i.scene?.replace(/@image(\d+)/gi, (_m, n) => `@Image${n}`).replace(/@video\d*/gi, "@Video1"),
  });
  await target.provider.generate(
    {
      model: target.model,
      clipPath: i.clipPath,
      depthPath: "",
      sheetPath,
      characterPath: sheetPath ? undefined : i.characters[0]?.path,
      prompt,
      negative: "",
      quality: i.quality,
      duration: i.duration,
      aspect: i.width / i.height,
      outPath: i.outPath,
      seed: i.seed,
    },
    { progress: hooks.progress, step: hooks.step, signal: hooks.signal },
  );
  hooks.step?.("finish", "running", "putting your original audio back");
  await restoreSourceAudio(i.clipPath, i.outPath);
  hooks.step?.("finish", "done");
  return { pack: { prompt, negative: "", uploads: [], timeline: [] }, draftTaskId: undefined };
}
