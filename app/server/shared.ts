// Types and camera presets shared by server and web. Keep in sync with
// nodes/comfyui-backlot/backlot/ops.py (PRESETS, LENSES).

export const CAMERA_PRESETS = [
  "static",
  "dolly_in",
  "dolly_out",
  "truck_left",
  "truck_right",
  "orbit_left",
  "orbit_right",
  "crane_up",
  "crane_down",
  "push_tilt_up",
  "handheld",
] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];

export const LENSES = {
  "18mm wide": { focal: 18, squeeze: 1, tstop: 2.8 },
  "24mm": { focal: 24, squeeze: 1, tstop: 2.0 },
  "35mm": { focal: 35, squeeze: 1, tstop: 1.8 },
  "50mm": { focal: 50, squeeze: 1, tstop: 1.4 },
  "85mm portrait": { focal: 85, squeeze: 1, tstop: 1.4 },
  "40mm anamorphic": { focal: 40, squeeze: 2, tstop: 2.3 },
  "75mm anamorphic": { focal: 75, squeeze: 2, tstop: 2.3 },
} as const;
export type LensName = keyof typeof LENSES;

/** Re-shoot viewpoints: where the new camera stands, in words the video model follows. */
export const RESHOOT_ANGLES = {
  orbit_left: { label: "Orbit left", hint: "Circle round to the left", camera: "the camera slowly orbits about 90 degrees to the left around the main subject, ending on their other side" },
  orbit_right: { label: "Orbit right", hint: "Circle round to the right", camera: "the camera slowly orbits about 90 degrees to the right around the main subject, ending on their other side" },
  low_angle: { label: "Low angle", hint: "Hero shot from the ground", camera: "the camera sits low near the ground and looks up at the main subject, a heroic low-angle shot" },
  high_angle: { label: "High angle", hint: "Looking down from above", camera: "the camera is raised high above head height and looks down at the main subject at about 45 degrees" },
  overhead: { label: "Top-down", hint: "Straight down from above", camera: "the camera looks straight down on the scene from directly above, a top-down bird's-eye view" },
  closeup: { label: "Close-up", hint: "Tight on the subject", camera: "a tight close-up on the main subject's face and upper body, shallow depth of field" },
  wide: { label: "Wide", hint: "Pull back to show the place", camera: "a wide establishing shot from further back that shows the whole place around the main subject" },
  behind: { label: "From behind", hint: "Over the shoulder", camera: "the camera is behind the main subject, looking over their shoulder in the direction they face" },
  profile: { label: "Side profile", hint: "Square to their side", camera: "the camera is square to the main subject's side, a clean side-profile view" },
  drone: { label: "Drone", hint: "Rising aerial pull-back", camera: "an aerial drone shot that starts above the main subject and rises and pulls back to reveal the surroundings" },
} as const;
export type ReshootAngle = keyof typeof RESHOOT_ANGLES;

/** 16:9 A/B export: where the original (a) and the result (b) sit in the 1920x1080
 *  frame. Portrait takes stand side by side full height; landscape takes get two
 *  16:9 panes. The browser draws the labels at the same boxes. */
export const AB_LAYOUT = {
  portrait: { a: { x: 350, y: 56, w: 600, h: 920 }, b: { x: 970, y: 56, w: 600, h: 920 } },
  landscape: { a: { x: 20, y: 260, w: 930, h: 523 }, b: { x: 970, y: 260, w: 930, h: 523 } },
} as const;

/** Text to video frame shapes, width / height. */
export const T2V_ASPECTS = { "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1, "3:4": 3 / 4, "4:3": 4 / 3, "21:9": 21 / 9 } as const;
export type T2vAspect = keyof typeof T2V_ASPECTS;

/** A Text to video take: a new shot from a prompt and optional reference images. */
export interface T2vTake {
  id: string;
  prompt: string;
  imageIds: string[];
  model: string;
  quality: string;
  seconds: number;
  aspect: T2vAspect;
  audio: boolean;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  message: string;
  url?: string;
  /** The ComfyUI workflow (API format) the take ran. */
  workflowUrl?: string;
  error?: string;
  createdAt: number;
}

export const ASPECTS = ["2.39", "1.85", "1.78", "0.5625"] as const;
/** "native" keeps the input video's own shape: no mattes. */
export type Aspect = (typeof ASPECTS)[number] | "native";

export type RenderMode = "direct" | "recast";

export interface RenderParams {
  clipId: string;
  mode: RenderMode;
  camera: CameraPreset;
  cameraStrength: number;
  lens: LensName;
  fStop: number;
  focus: number;
  focusEnd: number; // < 0 disables rack focus
  lut: string; // file name in luts/, or "none"
  lutStrength: number;
  grain: number;
  halation: number;
  aspect: Aspect;
  castId?: string; // recast: reference image
  castIds?: string[]; // recast pipeline: character references, in order
  model?: string; // recast pipeline: "<provider>:<model>" from /api/models
  quality?: "480p" | "720p" | "768p" | "1080p" | "2K";
  /** Use only [start, end) seconds of the take (at most 30 s). */
  trim?: { start: number; end: number };
  /** Recast: keep the original background (sends the original footage as a second reference). Default true. */
  keepBackground?: boolean;
  /** Recast with keepBackground off: what the new background should be. */
  background?: string;
  prompt?: string; // recast: scene / character description
  preparationId?: string; // approved Genjustsu preparation for Seedance 2.5
  /** MiniMax H3 character swap: an H3_LORAS id ("none" = base model only). */
  lora?: string;
  /** Recast: build a depth map (and allow SAM 3 prep). false = the model gets the original video. Default true. */
  useDepth?: boolean;
  /** false: send the model a silent video (the take's sound is put back afterwards). Default true. */
  sendAudio?: boolean;
  /** Style swap: restyle the whole shot after the reference image instead of swapping a person. Needs useDepth false. */
  restyle?: boolean;
  /** Restyle: the visual style for the whole shot (e.g. "claymation stop-motion"). */
  style?: string;
  /** Re-shoot: film the same moment again from a RESHOOT_ANGLES viewpoint. Needs useDepth false. */
  reshoot?: ReshootAngle;
  seed: number;
}

export interface Clip {
  id: string;
  name: string;
  url: string;
  poster: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  sample: boolean;
  depthUrl?: string;
  createdAt: number;
}

export interface DepthJob {
  clipId: string;
  status: "running" | "succeeded" | "failed";
  progress: number;
  message: string;
  url?: string;
  error?: string;
}

/** A person picked for SAM 3, as a box in 0–1 coordinates of the video frame (top-left origin). */
export interface PersonBox { x: number; y: number; w: number; h: number }
/** One shot of a take with cuts: its own box prompts, drawn `at` seconds into the take.
 *  No boxes = nobody to swap in this shot (an empty mask). */
export interface ShotPick { start: number; end: number; at: number; people: PersonBox[] }

export interface Preparation {
  id: string;
  clipId: string;
  trim?: { start: number; end: number };
  segmentPrompt: string;
  /** Picked people (box per person, in order); absent = SAM 3 masks everything matching segmentPrompt. */
  people?: PersonBox[];
  /** Per-shot box prompts for takes with cuts (SAM 3 cannot track through a hard cut). */
  shots?: ShotPick[];
  /** Seconds into the take where the boxes were drawn. */
  peopleAt?: number;
  status: "queued" | "running" | "ready" | "failed";
  progress: number;
  message: string;
  approved: boolean;
  manifestHash?: string;
  seedanceInputUrl?: string;
  depthUrl?: string;
  maskUrl?: string;
  overlayUrl?: string;
  compositeUrl?: string;
  duration?: number;
  error?: string;
  createdAt: number;
  /** Named steps with ticks for the progress checklist. */
  steps?: JobStep[];
  /** Hidden from the queue by the user. */
  dismissed?: boolean;
}

export type StepState = "pending" | "running" | "done" | "failed";

/** One line of a job's progress checklist. */
export interface JobStep {
  key: string;
  label: string;
  /** Where the work happens: on the Mac running MOGFIELD, or on Comfy Cloud. */
  where: "mac" | "comfy";
  state: StepState;
  startedAt?: number;
  endedAt?: number;
  /** Live detail, e.g. "Comfy queue #3" or "downloading result". */
  note?: string;
}

export interface CastCard {
  id: string;
  kind: "character" | "place";
  prompt: string; // display name / description
  url: string;
  engine: "comfy" | "preview";
  /** Saved to the library as a reusable character. */
  saved?: boolean;
  createdAt: number;
}

export interface PromptPack {
  prompt: string;
  negative: string;
  uploads: { tag: string; label: string; url: string }[];
  timeline: string[];
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Render {
  id: string;
  params: RenderParams;
  status: JobStatus;
  progress: number;
  message: string;
  url?: string;
  /** The ComfyUI workflow (API format) the take ran, when it ran as one. */
  workflowUrl?: string;
  /** Seedance 2.5 draft preview; can be promoted to a 1080p final. */
  isDraft?: boolean;
  draftTaskId?: string;
  draftUrl?: string;
  error?: string;
  engine: "comfy" | "preview";
  createdAt: number;
  take: number;
  /** Named steps with ticks for the progress checklist (Seedance takes). */
  steps?: JobStep[];
  /** Hidden from the queue by the user (finished or failed takes only). */
  dismissed?: boolean;
}

export type RenderEvent =
  | { type: "status"; render: Render }
  | { type: "progress"; progress: number; message: string }
  | { type: "preview"; dataUrl: string };

/** Smoothstep easing shared by every engine and the 3D path preview. */
export const ease = (t: number) => t * t * (3 - 2 * t);

export interface Pose {
  tx: number;
  ty: number;
  tz: number;
  yaw: number;
  pitch: number;
}

/** Same path the CameraRig node computes (handheld uses a fixed phase here). */
export function cameraPose(preset: CameraPreset, t: number, s = 1): Pose {
  const e = ease(Math.min(1, Math.max(0, t)));
  const p: Pose = { tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0 };
  switch (preset) {
    case "dolly_in": p.tz = 0.35 * s * e; break;
    case "dolly_out": p.tz = -0.3 * s * e; break;
    case "truck_left": p.tx = 0.12 * s * e; break;
    case "truck_right": p.tx = -0.12 * s * e; break;
    case "orbit_left": p.tx = 0.16 * s * e; p.yaw = -0.16 * s * e; break;
    case "orbit_right": p.tx = -0.16 * s * e; p.yaw = 0.16 * s * e; break;
    case "crane_up": p.ty = 0.12 * s * e; p.pitch = -0.04 * s * e; break;
    case "crane_down": p.ty = -0.12 * s * e; p.pitch = 0.04 * s * e; break;
    case "push_tilt_up": p.tz = 0.2 * s * e; p.pitch = 0.08 * s * e; break;
    case "handheld": {
      const sec = t * 4;
      p.yaw = 0.006 * s * (Math.sin(2 * Math.PI * 0.31 * sec + 1.1) + 0.5 * Math.sin(2 * Math.PI * 0.83 * sec + 2.3));
      p.pitch = 0.006 * s * (Math.sin(2 * Math.PI * 0.27 * sec + 0.4) + 0.5 * Math.sin(2 * Math.PI * 0.71 * sec + 4.0));
      p.tz = 0.01 * s * Math.sin(2 * Math.PI * 0.11 * sec + 5.2);
      break;
    }
  }
  return p;
}

// ---------------------------------------------------------------- links

/** Hosts a pasted link may point at. Short links (vm./vt.tiktok.com) redirect to a video. */
const SOURCES: { name: string; host: RegExp; path: RegExp }[] = [
  { name: "TikTok", host: /(^|\.)tiktok\.com$/i, path: /\/(video|photo|t)\/|^\/[A-Za-z0-9]+\/?$|\/@[^/]+\/video\// },
  { name: "Instagram", host: /(^|\.)instagram\.com$/i, path: /^\/(reels?|p|tv)\/|^\/[^/]+\/(reels?|p)\// },
  { name: "X", host: /(^|\.)(x|twitter)\.com$/i, path: /^\/[^/]+\/status\/\d+/ },
];

/** The platform a link belongs to, or null when it is not a TikTok / Instagram / X video link. */
export function linkSource(raw: string): { url: string; name: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const s = SOURCES.find((s) => s.host.test(u.hostname) && s.path.test(u.pathname));
  return s ? { url: u.toString(), name: s.name } : null;
}

/** The first TikTok / Instagram / X video link in some pasted or dropped text (share text often wraps it). */
export function findVideoLink(text: string): string | null {
  for (const m of text.matchAll(/https?:\/\/\S+/g)) if (linkSource(m[0])) return m[0];
  return null;
}

/** LoRAs for MiniMax H3 character swap on Comfy Cloud. `file` is matched against
 *  the account's LoRA list, so a model imported into a sub-folder still counts. */
export const H3_LORAS = [
  { id: "akatz-swap-v1.5", label: "Character Swap v1.5", by: "Akatz", file: "h3_character_swap_v1.5.safetensors", url: "https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA" },
  { id: "akatz-swap-v1", label: "Character Swap v1", by: "Akatz", file: "h3_character_swap_pro4500_1000.safetensors", url: "https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA" },
  { id: "none", label: "No LoRA (base H3)", by: "", file: "", url: "" },
] as const;
export const H3_DEFAULT_LORA = "akatz-swap-v1.5";
