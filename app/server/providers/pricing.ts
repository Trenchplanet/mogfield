// Cost estimates for the Generate button, from Comfy's published partner
// node rates (docs.comfy.org/tutorials/partner-nodes/pricing, Oct 2026).
// Estimates only: the amount the API actually charges is authoritative.

import type { Quality } from "./types.js";

/** Comfy credits per US dollar (from the comfy.org pricing tables). */
export const CREDITS_PER_USD = 211;

export type Pricing =
  /** Seedance: credits per 1K video tokens, with video input. */
  | { kind: "seedance-tokens"; per1k: Partial<Record<Quality, number>> }
  /** US dollars per output second; videoIn: the reference take is billed by the second too. */
  | { kind: "per-second"; usd: Partial<Record<Quality, number>>; videoIn?: boolean };

const SHORT_SIDE: Record<Quality, number> = { "480p": 480, "720p": 720, "768p": 768, "1080p": 1080, "2K": 2048 };

/**
 * Seedance tokens ≈ (input video s + output video s) × width × height × fps / 1024.
 * Every reference video counts as input seconds, so keeping the background
 * (a second reference video) costs more.
 */
export function estimateUsd(p: Pricing | undefined, o: { seconds: number; quality: Quality; aspect: number; inputVideos: number }): number | null {
  if (!p) return null;
  if (p.kind === "per-second") {
    const usd = p.usd[o.quality];
    return usd === undefined ? null : usd * o.seconds * (p.videoIn ? 2 : 1);
  }
  const rate = p.per1k[o.quality];
  if (rate === undefined) return null;
  const short = SHORT_SIDE[o.quality];
  const [w, h] = o.aspect >= 1 ? [Math.round(short * o.aspect), short] : [short, Math.round(short / o.aspect)];
  const tokens = ((o.inputVideos + 1) * o.seconds * w * h * 24) / 1024;
  return ((tokens / 1000) * rate) / CREDITS_PER_USD;
}

export function formatUsd(usd: number): string {
  return usd < 0.1 ? "<$0.10" : `~$${usd.toFixed(2)}`;
}
