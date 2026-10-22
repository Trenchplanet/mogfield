import type { Pricing } from "./pricing.js";

// A provider turns (depth video + reference sheet + prompt) into a video.
// Add one by implementing Provider and listing it in ./index.ts.

export type Quality = "480p" | "720p" | "768p" | "1080p" | "2K";

export interface ModelOption {
  id: string; // "<provider>:<model>", stable across restarts
  label: string;
  provider: string; // provider label shown in the picker
  badges: string[]; // "Top", "Open weights", …
  qualities: Quality[];
  /** Longest clip the model accepts, in seconds. */
  maxSeconds: number;
  /** Published rates for the cost estimate; absent = runs on your own GPU. */
  pricing?: Pricing;
  /** Whether the model consumes reference media or generates from text alone. */
  inputMode?: "reference-video" | "text-only" | "text-image";
  available: boolean;
  needs?: string; // why it is unavailable, in plain words
  /** LoRAs this model can load, and whether each is on the account. */
  loras?: { id: string; label: string; by: string; url: string; installed: boolean }[];
}

export interface GenerateJob {
  model: string; // the provider's own model id (after the "<provider>:" prefix)
  clipPath: string;
  depthPath: string;
  sheetPath: string | null;
  /** The original (trimmed) footage, sent as a second reference to keep the background. */
  originalPath?: string;
  prompt: string;
  negative: string;
  quality: Quality;
  duration: number;
  aspect: number;
  outPath: string;
  /** Genjustsu-prepared clip: SAM/depth composite with +3-semitone vocals. */
  preparedVideoPath?: string;
  /** The prepared clip's +3-semitone vocal stem (WAV), for MOGFIELD_PREP_AUDIO=separate. */
  preparedAudioPath?: string;
  /** Colored depth reference paired with the prepared video. */
  preparedDepthPath?: string;
  /** Request a Seedance 2.5 draft instead of a final render. */
  draftPreview?: boolean;
  /** MiniMax H3 character swap: H3_LORAS id. */
  lora?: string;
  /** The character image itself (H3 swap uses it directly when there is one character). */
  characterPath?: string;
  seed?: number;
  /** false: send a silent video, no audio reference. */
  sendAudio?: boolean;
}

export interface FinalizeDraftJob {
  model: string;
  draftTaskId: string;
  outPath: string;
}

export interface ProviderHooks {
  progress: (p: number, message: string) => void;
  /** Checklist updates for the progress screen (keys from SEEDANCE_STEPS). */
  step?: (key: string, state: "running" | "done", note?: string) => void;
  signal?: AbortSignal;
}

export interface Provider {
  id: string;
  label: string;
  models(): Promise<ModelOption[]>;
  generate(job: GenerateJob, hooks: ProviderHooks): Promise<void | { draftTaskId?: string }>;
  finalizeDraft?(job: FinalizeDraftJob, hooks: ProviderHooks): Promise<void>;
}
