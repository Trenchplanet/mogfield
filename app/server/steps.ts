// Named progress steps for the checklist on the progress screens.
import type { JobStep, StepState } from "./shared.js";

export type StepDef = Pick<JobStep, "key" | "label" | "where">;

/** Preparation: what runs where, in order. */
export const PREPARATION_STEPS: StepDef[] = [
  { key: "normalize", label: "Normalize video and audio", where: "mac" },
  { key: "depth", label: "Depth map and vocal separation", where: "comfy" },
  { key: "sam", label: "Person mask (SAM 3)", where: "comfy" },
  { key: "composite", label: "Composite the masked take", where: "mac" },
  { key: "pitch", label: "Pitch vocals +3 semitones", where: "mac" },
  { key: "package", label: "Build the prepared video", where: "mac" },
];

/** A Seedance take through the Comfy API. */
export const SEEDANCE_STEPS: StepDef[] = [
  { key: "inputs", label: "Prepare inputs", where: "mac" },
  { key: "upload", label: "Upload to Comfy", where: "mac" },
  { key: "queue", label: "Waiting in the Seedance queue", where: "comfy" },
  { key: "generate", label: "Seedance is generating", where: "comfy" },
  { key: "finish", label: "Download and restore your audio", where: "mac" },
];

export const H3_STEPS: StepDef[] = [
  { key: "inputs", label: "Prepare video and character", where: "mac" },
  { key: "upload", label: "Upload to Comfy Cloud", where: "mac" },
  { key: "queue", label: "Waiting in the Comfy queue", where: "comfy" },
  { key: "generate", label: "H3 is generating", where: "comfy" },
  { key: "finish", label: "Download and restore your audio", where: "mac" },
];

/** Wan 3.0 / MiniMax H3 reference to video: the take and the picture go straight to the node. */
export const REFV_STEPS: StepDef[] = [
  { key: "inputs", label: "Prepare video and picture", where: "mac" },
  { key: "upload", label: "Upload to Comfy Cloud", where: "mac" },
  { key: "queue", label: "Waiting in the Comfy queue", where: "comfy" },
  { key: "generate", label: "The model is generating", where: "comfy" },
  { key: "finish", label: "Download and restore your audio", where: "mac" },
];

export function makeSteps(defs: StepDef[]): JobStep[] {
  return defs.map((d) => ({ ...d, state: "pending" as StepState }));
}

/**
 * Move one step to a new state. Starting a step finishes any earlier step that
 * was still running, so the checklist never shows two live steps. Returns
 * whether anything visible changed.
 */
export function setStep(steps: JobStep[] | undefined, key: string, state: StepState, note?: string, now = Date.now()): boolean {
  if (!steps) return false;
  const i = steps.findIndex((s) => s.key === key);
  if (i < 0) return false;
  const s = steps[i];
  const before = `${s.state}|${s.note ?? ""}`;
  if (state === "running") {
    for (const earlier of steps.slice(0, i)) {
      if (earlier.state === "running" || earlier.state === "pending") {
        earlier.state = "done";
        earlier.note = undefined;
        earlier.endedAt ??= now;
      }
    }
    if (s.state !== "running") s.startedAt = now;
    s.endedAt = undefined;
  } else if (state === "done" || state === "failed") {
    s.endedAt ??= now;
  }
  s.state = state;
  s.note = state === "running" ? note : state === "failed" ? note ?? s.note : undefined;
  return before !== `${s.state}|${s.note ?? ""}`;
}

/** Mark whichever step was running as failed (the job stopped there). */
export function failRunning(steps: JobStep[] | undefined, now = Date.now()) {
  const s = steps?.find((x) => x.state === "running");
  if (s) {
    s.state = "failed";
    s.endedAt = now;
  }
}

/** All steps done (used when a job finishes without reporting every step). */
export function finishAll(steps: JobStep[] | undefined, now = Date.now()) {
  for (const s of steps ?? []) {
    if (s.state !== "done") {
      s.state = "done";
      s.note = undefined;
      s.endedAt ??= now;
    }
  }
}
