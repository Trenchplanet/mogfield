import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(here, "..", "..");
export const APP_DIR = resolve(here, "..");
// app/.env holds keys such as COMFY_API_KEY (gitignored)
try {
  process.loadEnvFile(join(APP_DIR, ".env"));
} catch {
  /* no .env */
}

export const DATA_DIR = resolve(process.env.BACKLOT_DATA_DIR ?? join(APP_DIR, "data"));
export const UPLOAD_DIR = join(DATA_DIR, "uploads");
export const RENDER_DIR = join(DATA_DIR, "renders");
export const REEL_DIR = join(DATA_DIR, "reels");
export const TRIM_DIR = join(DATA_DIR, "trims");
export const GENJUTSU_DIR = resolve(process.env.BACKLOT_PRIVATE_DIR ?? join(APP_DIR, ".private-data"), "genjustsu");
export const EXAMPLES_DIR = join(ROOT, "examples", "clips");
export const WORKFLOW_DIR = join(ROOT, "workflows");
export const LUT_DIR = join(ROOT, "nodes", "comfyui-backlot", "luts");

for (const d of [UPLOAD_DIR, RENDER_DIR, REEL_DIR, TRIM_DIR]) mkdirSync(d, { recursive: true });

/**
 * "comfy"   - render through the Comfy SDK. COMFY_BASE_URL picks the target:
 *             a local ComfyUI behind comfy-api-proxy, or a Comfy API deployment.
 * "preview" - no GPU: an ffmpeg finishing pass that approximates camera, lens
 *             and grade so the UI is fully usable while you build.
 */
export let ENGINE: "comfy" | "preview" =
  (process.env.BACKLOT_ENGINE as "comfy" | "preview" | undefined) ??
  (process.env.COMFY_BASE_URL ? "comfy" : "preview");

/** Point the Comfy SDK at Comfy Cloud (url undefined) or at your own ComfyUI.
 *  The SDK reads COMFY_BASE_URL when a client is created, so callers must drop
 *  cached clients afterwards (see resetComfyClient). */
export function setComfyTarget(url: string | undefined) {
  if (url) process.env.COMFY_BASE_URL = url;
  else delete process.env.COMFY_BASE_URL;
  ENGINE = (process.env.BACKLOT_ENGINE as "comfy" | "preview" | undefined) ?? (url ? "comfy" : "preview");
}

// In dev the web app owns PORT (Vite); the API listens on BACKLOT_PORT.
export const PORT = Number(process.env.BACKLOT_PORT ?? (process.env.NODE_ENV === "production" ? process.env.PORT ?? 8787 : 8787));
/** Max renders per visitor IP per day; 0 disables the cap. */
export const RENDER_CAP = Number(process.env.BACKLOT_RENDER_CAP ?? 0);
export const MAX_UPLOAD_MB = Number(process.env.BACKLOT_MAX_UPLOAD_MB ?? 200);
export const REPO_URL = process.env.BACKLOT_REPO_URL ?? "github.com/Trenchplanet/mogfield";
/** yt-dlp fetches TikTok / Instagram / X links. Instagram usually needs cookies from a logged-in browser. */
export const YTDLP = process.env.BACKLOT_YTDLP ?? "yt-dlp";
export const YTDLP_COOKIES_FROM_BROWSER = process.env.BACKLOT_YTDLP_COOKIES_FROM_BROWSER ?? "";
export const YTDLP_COOKIES = process.env.BACKLOT_YTDLP_COOKIES ?? "";
