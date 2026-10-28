import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import {
  APP_DIR, DATA_DIR, ENGINE, EXAMPLES_DIR, GENJUTSU_DIR, TRIM_DIR, LUT_DIR, MAX_UPLOAD_MB, PORT, REEL_DIR, RENDER_CAP, RENDER_DIR, REPO_URL, UPLOAD_DIR, WORKFLOW_DIR,
} from "./config.js";
import { depthPath, generateDepth } from "./depth.js";
import { prepareGenjustsu, preparationUrls, readWavSamples, sameSamples, sourceAudioSamples, verifyPreparation, type PreparationResult } from "./genjustsu.js";
import { adoptLegacyPreparations, loadPreparations, persistPreparation, type SourceCandidate } from "./preparationStore.js";
import { exportWorkflow, type ExportRequest } from "./workflowExport.js";
import { agentRoutes } from "./agent.js";
import { OwnedMap, onPurged, ownerOf, PER_VISITOR, runAs, sweepExpired } from "./scope.js";
import { failRunning, finishAll, H3_STEPS, makeSteps, PREPARATION_STEPS, REFV_STEPS, SEEDANCE_STEPS, setStep } from "./steps.js";
import { describeStyle, editCharacterPhoto, fluxCard, geminiImage, makeCharacterSheet, nearestRatio, SHEET_MODEL, type SheetSize } from "./characters.js";
import { catalogModel, catalogModels, runCatalogModel } from "./providers/catalog.js";
import { downloadLink } from "./links.js";
import { checkBackend, currentBackend, loadBackend, saveBackend, type Backend } from "./backend.js";
import { isFrameModel, listTakes, startExtend, startFramesTake, startTake } from "./t2v.js";

// the backend picked in the app (data/backend.json) wins over the .env default
loadBackend();
import { analyzeMotion } from "./motion.js";
import { buildPromptPack } from "./seedance.js";
import { runRecast } from "./pipeline.js";
import { listModels, providerFor } from "./providers/index.js";
import { comfyCast, comfyEngine } from "./engines/comfy.js";
import { previewEngine } from "./engines/preview.js";
import type { Engine } from "./engines/types.js";
import { exec, ffmpegWithProgress, normalise, poster, probe, restoreSourceAudio, trimVideo } from "./media.js";
import { AB_LAYOUT, FRAME_MODELS, snapSeconds, RESHOOT_ANGLES, T2V_ASPECTS, type T2vAspect,
  ASPECTS, CAMERA_PRESETS, H3_LORAS, LENSES, linkSource, type CastCard, type Clip, type DepthJob, type Preparation, type Render, type RenderEvent, type RenderParams, type ReshootView,
} from "./shared.js";

const engine: Engine = ENGINE === "comfy" ? comfyEngine : previewEngine;
const app = new Hono();

// Public demo: each visitor only ever sees their own uploads, takes and projects (see scope.ts).
if (PER_VISITOR) {
  app.use("*", async (c, next) => {
    let vid = getCookie(c, "mf_vid");
    if (!vid || !/^[0-9a-f]{24}$/.test(vid)) {
      vid = randomBytes(12).toString("hex");
      setCookie(c, "mf_vid", vid, { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 30 });
    }
    // another visitor's file or record does not exist as far as this visitor can tell
    for (const token of c.req.path.match(/(?<![0-9a-f])[0-9a-f]{8}(?![0-9a-f])/g) ?? []) {
      const owner = ownerOf(token);
      if (owner && owner !== vid) return c.json({ error: "not found" }, 404);
    }
    // pointing the shared server at another ComfyUI is the owner's call, not a visitor's
    if (c.req.path === "/api/backend" && c.req.method !== "GET") return c.json({ error: "not available on the public demo" }, 403);
    await runAs(vid, next);
    if (c.req.path.startsWith("/api/")) c.res.headers.set("Cache-Control", "private, no-store");
    else if (c.req.path.startsWith("/media/")) c.res.headers.set("Cache-Control", "private, max-age=3600");
  });
}

/** A failed call to Comfy / yt-dlp. Not 502: Cloudflare replaces 502 responses with its own
 *  page, so the visitor would only see "HTTP 502" instead of the reason. */
function upstreamError(c: Context, e: unknown) {
  const message = (e as Error).message ?? String(e);
  const credits = /not have enough credits|insufficient.credits/i.test(message);
  return c.json({ error: credits ? `${message} Top up the credits on your Comfy account, then try again.` : message }, credits ? 402 : 500);
}

// ---------------------------------------------------------------- clips

const clips = new OwnedMap<Clip & { path: string }>();

// ---------------------------------------------------------------- library index
// data/library.json keeps what the files alone cannot: video names, image
// references and which ones are saved characters.

const LIBRARY_FILE = join(DATA_DIR, "library.json");
type LibraryIndex = { clips: Record<string, { name: string; createdAt: number }>; images: (CastCard & { path: string })[]; renders: Render[] };
let library: LibraryIndex = { clips: {}, images: [], renders: [] };
async function loadLibrary() {
  try {
    library = { clips: {}, images: [], renders: [], ...JSON.parse(await readFile(LIBRARY_FILE, "utf8")) };
  } catch {
    /* first run */
  }
}
let saveTimer: NodeJS.Timeout | null = null;
function saveLibrary() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    library.images = casts.all();
    // every take, so the queue still shows failed and interrupted ones after a restart
    library.renders = renders.all().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
    void writeFile(LIBRARY_FILE, JSON.stringify(library, null, 2)).catch((e) => console.error("library save failed:", e));
  }, 200);
}

async function registerClip(id: string, name: string, path: string, sample: boolean) {
  const info = await probe(path);
  const posterPath = join(UPLOAD_DIR, `${id}.jpg`);
  if (!existsSync(posterPath)) await poster(path, posterPath, Math.min(0.5, info.duration / 2));
  const meta = library.clips[id];
  const clip = {
    id, name: meta?.name ?? name, path, sample,
    createdAt: meta?.createdAt ?? (sample ? 0 : (await stat(path)).mtimeMs),
    url: sample ? `/examples/clips/${basename(path)}` : `/media/uploads/${basename(path)}`,
    poster: `/media/uploads/${id}.jpg`,
    width: info.width, height: info.height, duration: info.duration, fps: info.fps,
    depthUrl: existsSync(depthPath(id)) ? `/media/depth/${id}.mp4` : undefined,
  };
  clips.set(id, clip);
  return clip;
}

async function loadSamples() {
  if (!existsSync(EXAMPLES_DIR)) return;
  for (const f of (await readdir(EXAMPLES_DIR)).sort()) {
    if (!/\.(mp4|mov|webm)$/i.test(f)) continue;
    const id = `sample-${f.replace(/\.[^.]+$/, "")}`;
    try {
      await registerClip(id, f.replace(/\.[^.]+$/, "").replaceAll(/[-_]/g, " "), join(EXAMPLES_DIR, f), true);
    } catch (e) {
      console.warn(`skipping sample ${f}:`, (e as Error).message);
    }
  }
}

async function loadUploads() {
  for (const f of await readdir(UPLOAD_DIR)) {
    // image references from before the library index existed
    const m = /^cast-([0-9a-f]{8})\.(png|jpe?g|webp)$/i.exec(f);
    if (m && !casts.has(m[1])) {
      const path = join(UPLOAD_DIR, f);
      casts.set(m[1], { id: m[1], kind: "character", prompt: "Reference", url: `/media/uploads/${f}`, engine: ENGINE, path, saved: false, createdAt: (await stat(path)).mtimeMs });
      saveLibrary();
      continue;
    }
    if (!f.endsWith(".mp4")) continue;
    const id = f.replace(/\.mp4$/, "");
    if (!clips.has(id)) await registerClip(id, "Your take", join(UPLOAD_DIR, f), false).catch(() => {});
  }
}

/** The part of a clip a render uses. A trim makes (and caches) a cut copy
 *  with its own id, and cuts an existing full-length depth map to match so
 *  the trimmed take does not need a second depth pass. */
async function sourceFor(clip: Clip & { path: string }, trim?: { start: number; end: number }) {
  if (!trim || (trim.start <= 0.05 && trim.end >= clip.duration - 0.05)) return { id: clip.id, path: clip.path, duration: clip.duration, offset: 0 };
  const id = `${clip.id}_t${Math.round(trim.start * 10)}_${Math.round(trim.end * 10)}`;
  const path = join(TRIM_DIR, `${id}.mp4`);
  if (!existsSync(path)) await trimVideo(clip.path, path, trim.start, trim.end);
  const full = depthPath(clip.id);
  const cut = depthPath(id);
  if (existsSync(full) && !existsSync(cut)) await trimVideo(full, cut, trim.start, trim.end, true);
  return { id, path, duration: trim.end - trim.start, offset: trim.start };
}

const publicClip = ({ path: _p, ...c }: Clip & { path: string }): Clip => c;

app.get("/api/clips", (c) => c.json([...clips.values()].map(publicClip)));

app.post("/api/clips", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: "send a video as multipart field 'file'" }, 400);
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return c.json({ error: `max upload is ${MAX_UPLOAD_MB} MB` }, 413);
  const id = randomUUID().slice(0, 8);
  const raw = join(UPLOAD_DIR, `${id}.raw${extname(file.name) || ".mov"}`);
  await writeFile(raw, Buffer.from(await file.arrayBuffer()));
  const out = join(UPLOAD_DIR, `${id}.mp4`);
  try {
    await normalise(raw, out);
  } catch (e) {
    return c.json({ error: `could not read that video: ${(e as Error).message.slice(0, 200)}` }, 400);
  } finally {
    await rm(raw, { force: true });
  }
  library.clips[id] = { name: file.name.replace(/\.[^.]+$/, "") || "Your video", createdAt: Date.now() };
  saveLibrary();
  const clip = await registerClip(id, library.clips[id].name, out, false);
  return c.json(publicClip(clip));
});

// A TikTok / Instagram / X link: download it and treat it like an upload.
app.post("/api/clips/link", async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => ({}) as { url?: string });
  const src = linkSource(String(body.url ?? ""));
  if (!src) return c.json({ error: "paste a TikTok, Instagram or X video link" }, 400);
  let dl: Awaited<ReturnType<typeof downloadLink>>;
  try {
    dl = await downloadLink(src.url);
  } catch (e) {
    return upstreamError(c, new Error(`could not download from ${src.name}: ${(e as Error).message}`));
  }
  const id = randomUUID().slice(0, 8);
  const out = join(UPLOAD_DIR, `${id}.mp4`);
  try {
    await normalise(dl.path, out);
  } catch (e) {
    return c.json({ error: `could not read that video: ${(e as Error).message.slice(0, 200)}` }, 400);
  } finally {
    await rm(dl.dir, { recursive: true, force: true });
  }
  library.clips[id] = { name: dl.title, createdAt: Date.now() };
  saveLibrary();
  const clip = await registerClip(id, dl.title, out, false);
  return c.json(publicClip(clip));
});

// ---------------------------------------------------------------- depth maps

const depthJobs = new OwnedMap<DepthJob>();
const depthBus = new EventEmitter();
depthBus.setMaxListeners(0);

app.post("/api/clips/:id/depth", (c) => {
  const id = c.req.param("id");
  const clip = clips.get(id);
  if (!clip) return c.json({ error: "unknown clip" }, 404);
  const cur = depthJobs.get(id);
  if (cur?.status === "running") return c.json(cur);
  const job: DepthJob = { clipId: id, status: "running", progress: 0, message: "Starting depth" };
  depthJobs.set(id, job);
  const emitDepth = () => depthBus.emit(id, { ...job });
  void generateDepth(clip.path, id, {
    progress: (p, m) => {
      job.progress = p;
      job.message = m;
      emitDepth();
    },
  })
    .then(() => {
      job.status = "succeeded";
      job.progress = 1;
      job.message = "Depth ready";
      job.url = `/media/depth/${id}.mp4?v=${Date.now()}`;
      clip.depthUrl = job.url;
    })
    .catch((e: Error) => {
      job.status = "failed";
      job.error = e.message;
      job.message = "Depth failed";
      console.error(`depth ${id} failed:`, e);
    })
    .finally(emitDepth);
  return c.json(job);
});

app.get("/api/clips/:id/depth/events", (c) => {
  const id = c.req.param("id");
  const job = depthJobs.get(id);
  if (!job) return c.json({ error: "no depth job" }, 404);
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: JSON.stringify(job) });
    if (job.status !== "running") return;
    await new Promise<void>((resolve) => {
      let last = 0;
      const on = (j: DepthJob) => {
        const now = Date.now();
        if (j.status === "running" && now - last < 150) return; // throttle progress
        last = now;
        const w = stream.writeSSE({ data: JSON.stringify(j) });
        // let the final message flush before the stream closes
        if (j.status !== "running") void w.finally(done);
      };
      const done = () => {
        depthBus.off(id, on);
        resolve();
      };
      depthBus.on(id, on);
      stream.onAbort(done);
    });
  });
});

// ---------------------------------------------------------------- Genjustsu preparation

interface PreparationState extends Preparation {
  sourcePath: string;
  result?: PreparationResult;
}
const preparations = new OwnedMap<PreparationState>();
const preparationBus = new EventEmitter();
preparationBus.setMaxListeners(0);
const publicPreparation = (state: PreparationState): Preparation => {
  const { sourcePath: _sourcePath, result: _result, ...visible } = state;
  return visible;
};
const preparationArtifacts: Record<string, (result: PreparationResult) => string> = {
  "seedance-input.mp4": (r) => r.seedanceInputPath,
  "depth-color.mp4": (r) => r.depthPath,
  "mask-preview.mp4": (r) => join(GENJUTSU_DIR, r.seedanceInputUrl.split("/").at(-2)!, "mask-preview.mp4"),
  "mask-overlay.mp4": (r) => join(GENJUTSU_DIR, r.seedanceInputUrl.split("/").at(-2)!, "mask-overlay.mp4"),
  "composite-silent.mp4": (r) => join(GENJUTSU_DIR, r.seedanceInputUrl.split("/").at(-2)!, "composite-silent.mp4"),
};
function emitPreparation(state: PreparationState) {
  preparationBus.emit(state.id, publicPreparation(state));
}
/** Emit and save to disk (status changes, approval, dismissal). */
function savePreparation(state: PreparationState) {
  emitPreparation(state);
  void persistPreparation(GENJUTSU_DIR, state);
}
function sameTrim(a?: { start: number; end: number }, b?: { start: number; end: number }) {
  return (!a && !b) || (!!a && !!b && Math.abs(a.start - b.start) < 0.051 && Math.abs(a.end - b.end) < 0.051);
}

app.post("/api/preparations", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { clipId?: unknown; trim?: { start?: unknown; end?: unknown }; segmentPrompt?: unknown; people?: unknown; peopleAt?: unknown; shots?: unknown };
  const clip = typeof body.clipId === "string" ? clips.get(body.clipId) : undefined;
  if (!clip) return c.json({ error: "unknown clip" }, 404);
  const segmentPrompt = String(body.segmentPrompt ?? "person").trim().slice(0, 120);
  if (!segmentPrompt) return c.json({ error: "enter the subject to segment, such as person" }, 400);
  const bounded = (v: unknown, fallback: number) => typeof v === "number" && Number.isFinite(v) ? Math.min(clip.duration, Math.max(0, v)) : fallback;
  const start = bounded(body.trim?.start, 0);
  const end = Math.min(bounded(body.trim?.end, clip.duration), start + 30);
  const trim = end - start >= 1 && (start > 0.05 || end < clip.duration - 0.05) ? { start, end } : undefined;
  const selectedDuration = trim ? trim.end - trim.start : Math.min(clip.duration, 30);
  if (selectedDuration < 4) return c.json({ error: "Seedance preparation needs at least 4 seconds of source video." }, 400);
  // picked people: up to 4 boxes in 0–1 frame coordinates, drawn at peopleAt seconds into the take
  const unit = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : NaN);
  const people = (Array.isArray(body.people) ? body.people : []).slice(0, 4).map((b) => {
    const r = b as Record<string, unknown>;
    const x = unit(r.x), y = unit(r.y);
    return { x, y, w: Math.min(unit(r.w), 1 - x), h: Math.min(unit(r.h), 1 - y) };
  }).filter((b) => [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w >= 0.02 && b.h >= 0.02);
  const boxes = (list: unknown) => (Array.isArray(list) ? list : []).slice(0, 4).map((b) => {
    const r = b as Record<string, unknown>;
    const x = unit(r.x), y = unit(r.y);
    return { x, y, w: Math.min(unit(r.w), 1 - x), h: Math.min(unit(r.h), 1 - y) };
  }).filter((b) => [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w >= 0.02 && b.h >= 0.02);
  // per-shot picks (seconds into the take): a takes with cuts gets one box prompt per shot
  const seconds = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(selectedDuration, Math.max(0, v)) : NaN);
  const shots = (Array.isArray(body.shots) ? body.shots : []).slice(0, 40).map((x) => {
    const r = x as Record<string, unknown>;
    const start = seconds(r.start), end = seconds(r.end);
    return { start, end, at: Math.min(end, Math.max(start, seconds(r.at))), people: boxes(r.people) };
  }).filter((x) => [x.start, x.end, x.at].every(Number.isFinite) && x.end > x.start);
  if (Array.isArray(body.shots) && !shots.some((x) => x.people.length)) return c.json({ error: "box the person in at least one shot" }, 400);
  const peopleAt = people.length && typeof body.peopleAt === "number" && Number.isFinite(body.peopleAt) ? Math.min(selectedDuration, Math.max(0, body.peopleAt)) : 0;
  const id = randomUUID().slice(0, 8);
  const state: PreparationState = {
    id, clipId: clip.id, trim, segmentPrompt: shots.length ? `picked in ${shots.filter((x) => x.people.length).length} shot(s)` : people.length ? `${people.length} picked ${people.length > 1 ? "people" : "person"}` : segmentPrompt, ...(shots.length ? { shots } : people.length ? { people, peopleAt } : {}), status: "queued", progress: 0,
    message: "Queued for preparation", approved: false, sourcePath: clip.path,
    createdAt: Date.now(), steps: makeSteps(PREPARATION_STEPS),
  };
  preparations.set(id, state);
  savePreparation(state);
  void (async () => {
    try {
      state.status = "running";
      state.message = "Starting preparation";
      savePreparation(state);
      const src = await sourceFor(clip, trim);
      state.sourcePath = src.path;
      const result = await prepareGenjustsu({ id, sourcePath: src.path, segmentPrompt, ...(shots.length ? { shots } : people.length ? { people, peopleAt } : {}) }, {
        progress: (progress, message) => {
          state.progress = Math.max(0, Math.min(1, progress));
          state.message = message;
          emitPreparation(state);
        },
        step: (key, stepState, note) => {
          if (setStep(state.steps, key, stepState, note)) emitPreparation(state);
        },
      });
      state.result = result;
      state.manifestHash = result.manifestHash;
      state.seedanceInputUrl = result.seedanceInputUrl;
      state.depthUrl = result.depthUrl;
      state.maskUrl = result.maskUrl;
      state.overlayUrl = result.overlayUrl;
      state.compositeUrl = result.compositeUrl;
      state.duration = result.duration;
      state.status = "ready";
      state.progress = 1;
      state.message = "Prepared · review the prepared video before approval";
      finishAll(state.steps);
    } catch (error) {
      state.status = "failed";
      state.error = (error as Error).message.slice(0, 600);
      state.message = "Preparation failed";
      failRunning(state.steps);
      console.error(`preparation ${id} failed:`, error);
    }
    savePreparation(state);
  })();
  return c.json(publicPreparation(state), 202);
});

app.get("/api/preparations", (c) =>
  c.json([...preparations.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(publicPreparation)),
);

app.post("/api/preparations/:id/dismiss", (c) => {
  const state = preparations.get(c.req.param("id"));
  if (!state) return c.json({ error: "not found" }, 404);
  if (state.status === "queued" || state.status === "running") return c.json({ error: "still preparing" }, 409);
  state.dismissed = true;
  savePreparation(state);
  return c.json(publicPreparation(state));
});

app.get("/api/preparations/:id", (c) => {
  const state = preparations.get(c.req.param("id"));
  return state ? c.json(publicPreparation(state)) : c.json({ error: "not found" }, 404);
});

app.get("/api/preparations/:id/events", (c) => {
  const id = c.req.param("id");
  const state = preparations.get(id);
  if (!state) return c.json({ error: "not found" }, 404);
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: JSON.stringify(publicPreparation(state)) });
    if (state.status === "ready" || state.status === "failed") return;
    await new Promise<void>((resolve) => {
      const done = () => {
        preparationBus.off(id, on);
        resolve();
      };
      const on = (next: Preparation) => {
        const write = stream.writeSSE({ data: JSON.stringify(next) });
        if (next.status === "ready" || next.status === "failed") void write.finally(done);
      };
      preparationBus.on(id, on);
      // Re-emit the latest state after subscribing to close the connect race.
      emitPreparation(state);
      stream.onAbort(done);
    });
  });
});

app.post("/api/preparations/:id/approve", async (c) => {
  const state = preparations.get(c.req.param("id"));
  if (!state) return c.json({ error: "not found" }, 404);
  if (state.status !== "ready" || !state.result || !state.manifestHash) return c.json({ error: "preparation is not ready for review" }, 409);
  const body = await c.req.json().catch(() => ({})) as { manifestHash?: unknown };
  if (body.manifestHash !== state.manifestHash) return c.json({ error: "review approval does not match the current artifact manifest" }, 409);
  state.approved = true;
  state.message = "Prepared video approved";
  savePreparation(state);
  return c.json(publicPreparation(state));
});

/** Give preparations made before v1.0.1 their clip back so they show up as templates. */
async function adoptOlderPreparations() {
  const candidates: SourceCandidate[] = [...clips.values()].map((c) => ({ path: c.path, clipId: c.id }));
  for (const f of existsSync(TRIM_DIR) ? await readdir(TRIM_DIR) : []) {
    const m = /^(.+)_t(\d+)_(\d+)\.mp4$/.exec(f);
    if (m && clips.has(m[1])) candidates.push({ path: join(TRIM_DIR, f), clipId: m[1], trim: { start: Number(m[2]) / 10, end: Number(m[3]) / 10 } });
  }
  const adopted = await adoptLegacyPreparations(GENJUTSU_DIR, candidates, {
    fingerprint: sourceAudioSamples,
    folderPrint: (dir) => readWavSamples(join(dir, "original-audio.wav")),
    matches: sameSamples,
    verify: verifyPreparation,
    describe: async (id, dir, source, manifest) => {
      const urls = preparationUrls(id);
      const seedanceInputPath = join(dir, "seedance-input.mp4");
      const duration = (await probe(seedanceInputPath)).duration;
      const manifestHash = String(manifest.manifestHash);
      const steps = makeSteps(PREPARATION_STEPS);
      finishAll(steps);
      return {
        id, clipId: source.clipId, trim: source.trim, segmentPrompt: String(manifest.segmentPrompt ?? "person"),
        status: "ready", progress: 1, message: "Prepared · review the prepared video before approval", approved: false,
        manifestHash, ...urls, duration, createdAt: (await stat(join(dir, "manifest.json"))).mtimeMs, steps,
        sourcePath: source.path,
        result: { sourcePath: source.path, seedanceInputPath, depthPath: join(dir, "depth-color.mp4"), ...urls, manifestHash, duration },
      };
    },
  });
  for (const state of adopted) preparations.set(state.id, state as PreparationState);
  if (adopted.length) console.log(`adopted ${adopted.length} earlier preparation(s) as templates`);
}

// Preparation intermediates contain private uploads and provider responses.
// Only these five review/generation videos are reachable through the public media route.
app.get("/media/genjustsu/:id/:file", async (c) => {
  const state = preparations.get(c.req.param("id"));
  const file = c.req.param("file");
  if (!state?.result || !Object.hasOwn(preparationArtifacts, file)) return c.notFound();
  const path = preparationArtifacts[file](state.result);
  const content = await readFile(path).catch(() => null);
  if (!content) return c.notFound();
  return c.body(content, 200, { "content-type": "video/mp4", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
});
app.use("/media/genjustsu/*", async (c) => c.notFound());

// ---------------------------------------------------------------- cast cards

const casts = new OwnedMap<CastCard & { path: string }>();

app.post("/api/cast", async (c) => {
  const body = await c.req.parseBody();
  const id = randomUUID().slice(0, 8);
  const kind: CastCard["kind"] = body.kind === "place" ? "place" : "character";
  if (body.file instanceof File) {
    const ext = extname(body.file.name).toLowerCase() || ".png";
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return c.json({ error: "png, jpg or webp only" }, 400);
    const path = join(UPLOAD_DIR, `cast-${id}${ext}`);
    await writeFile(path, Buffer.from(await body.file.arrayBuffer()));
    const card = { id, kind, prompt: String(body.prompt ?? body.file.name.replace(/\.[^.]+$/, "") ?? "Reference"), url: `/media/uploads/${basename(path)}`, engine: ENGINE, path, saved: body.saved === "true", createdAt: Date.now() };
    casts.set(id, card);
    saveLibrary();
    return c.json({ ...card, path: undefined });
  }
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return c.json({ error: "describe the character or set" }, 400);
  const path = join(UPLOAD_DIR, `cast-${id}.png`);
  try {
    // your own ComfyUI runs the open-weights FLUX 3 Image Klein workflow; Comfy Cloud has no Klein files, so FLUX 3 runs on the Comfy API
    if (ENGINE === "comfy") await comfyCast(prompt, Math.floor(Math.random() * 2 ** 31), path);
    else await fluxCard(prompt, path, kind === "place" ? "16:9" : "3:4", c.req.raw.signal);
  } catch (e) {
    return upstreamError(c, e);
  }
  const card = { id, kind, prompt, url: `/media/uploads/${basename(path)}`, engine: ENGINE, path, saved: false, createdAt: Date.now() };
  casts.set(id, card);
  saveLibrary();
  return c.json({ ...card, path: undefined });
});

const publicCast = ({ path: _p, ...c }: CastCard & { path: string }): CastCard => c;

app.get("/api/casts", (c) => c.json([...casts.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicCast)));

app.patch("/api/casts/:id", async (c) => {
  const card = casts.get(c.req.param("id"));
  if (!card) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.saved === "boolean") card.saved = b.saved;
  if (typeof b.name === "string" && b.name.trim()) card.prompt = b.name.trim().slice(0, 80);
  if (b.kind === "character" || b.kind === "place") card.kind = b.kind;
  saveLibrary();
  return c.json(publicCast(card));
});

// Character maker: photo in, Nano Banana character sheet out, saved as a character.
const SHEET_CAP = Number(process.env.MOGFIELD_SHEET_CAP ?? (RENDER_CAP > 0 ? 2 : 0));
const sheetCounts = new Map<string, number>();

app.post("/api/characters", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: "send a picture as multipart field 'file'" }, 400);
  const ext = extname(file.name).toLowerCase() || ".png";
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return c.json({ error: "png, jpg or webp only" }, 400);
  if (file.size > 20 * 1024 * 1024) return c.json({ error: "max 20 MB" }, 413);
  if (SHEET_CAP > 0) {
    const k = capKey(c);
    const n = sheetCounts.get(k) ?? 0;
    if (n >= SHEET_CAP) return c.json({ error: `Daily character limit reached (${SHEET_CAP}). Try again tomorrow or run MOGFIELD locally.` }, 429);
    sheetCounts.set(k, n + 1);
  }
  const size: SheetSize = body.size === "1K" ? "1K" : "2K";
  const name = String(body.name ?? "").trim().slice(0, 60) || file.name.replace(/\.[^.]+$/, "") || "Character";
  const now = Date.now();

  // keep the source photo in the library too
  const photoId = randomUUID().slice(0, 8);
  const photoPath = join(UPLOAD_DIR, `cast-${photoId}${ext}`);
  await writeFile(photoPath, Buffer.from(await file.arrayBuffer()));
  casts.set(photoId, { id: photoId, kind: "character", prompt: `${name} (photo)`, url: `/media/uploads/${basename(photoPath)}`, engine: ENGINE, path: photoPath, saved: false, createdAt: now });

  const id = randomUUID().slice(0, 8);
  const sheetPath = join(UPLOAD_DIR, `cast-${id}.png`);
  try {
    await makeCharacterSheet(photoPath, sheetPath, size, c.req.raw.signal);
  } catch (e) {
    saveLibrary();
    return upstreamError(c, e);
  }
  const card = { id, kind: "character" as const, prompt: name, url: `/media/uploads/${basename(sheetPath)}`, engine: ENGINE, path: sheetPath, saved: true, createdAt: now + 1 };
  casts.set(id, card);
  saveLibrary();
  return c.json(publicCast(card));
});

// ---------------------------------------------------------------- character studio
// photo + elements -> edited picture (repeatable) -> approved -> character board

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp"];
function studioCap(c: Context): string | null {
  if (SHEET_CAP <= 0) return null;
  const k = capKey(c);
  const n = sheetCounts.get(k) ?? 0;
  if (n >= SHEET_CAP) return `Daily character limit reached (${SHEET_CAP}). Try again tomorrow or run MOGFIELD locally.`;
  sheetCounts.set(k, n + 1);
  return null;
}

app.post("/api/studio/picture", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const name = String(one(body.name) ?? "").trim().slice(0, 60) || "Character";
  let elements: string[] = [];
  try {
    const raw = JSON.parse(String(one(body.elements) ?? "[]"));
    if (Array.isArray(raw)) elements = raw.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 200)).slice(0, 20);
  } catch { /* none */ }
  const note = String(one(body.note) ?? "").slice(0, 600);
  if (!elements.length && !note.trim()) return c.json({ error: "pick at least one element or describe a change" }, 400);
  const refs = (Array.isArray(body.ref) ? body.ref : body.ref ? [body.ref] : []).filter((f): f is File => f instanceof File).slice(0, 3);
  for (const f of refs) if (!IMAGE_EXT.includes(extname(f.name).toLowerCase() || ".png") || f.size > 20 * 1024 * 1024) return c.json({ error: "reference pictures: png, jpg or webp up to 20 MB" }, 400);

  // the picture to edit: a new upload, or an earlier photo / result by id
  let base = typeof one(body.baseId) === "string" ? casts.get(String(one(body.baseId))) : undefined;
  const file = one(body.file);
  if (!base && file instanceof File) {
    const ext = extname(file.name).toLowerCase() || ".png";
    if (!IMAGE_EXT.includes(ext)) return c.json({ error: "png, jpg or webp only" }, 400);
    if (file.size > 20 * 1024 * 1024) return c.json({ error: "max 20 MB" }, 413);
    const id = randomUUID().slice(0, 8);
    const path = join(UPLOAD_DIR, `cast-${id}${ext}`);
    await writeFile(path, Buffer.from(await file.arrayBuffer()));
    base = { id, kind: "character", prompt: `${name} (photo)`, url: `/media/uploads/${basename(path)}`, engine: ENGINE, path, saved: false, createdAt: Date.now() };
    casts.set(id, base);
    saveLibrary();
  }
  if (!base) return c.json({ error: "add a photo first" }, 400);
  const capped = studioCap(c);
  if (capped) return c.json({ error: capped }, 429);

  const refPaths: string[] = [];
  for (const f of refs) {
    const p = join(UPLOAD_DIR, `studio-ref-${randomUUID().slice(0, 8)}${extname(f.name).toLowerCase() || ".png"}`);
    await writeFile(p, Buffer.from(await f.arrayBuffer()));
    refPaths.push(p);
  }
  const id = randomUUID().slice(0, 8);
  const path = join(UPLOAD_DIR, `cast-${id}.png`);
  try {
    const dims = await probe(base.path).catch(() => ({ width: 1, height: 1 }));
    await editCharacterPhoto({ photoPath: base.path, elements, note, refPaths, aspect: dims.width / dims.height, outPath: path, signal: c.req.raw.signal });
  } catch (e) {
    return upstreamError(c, e);
  } finally {
    await Promise.all(refPaths.map((p) => rm(p, { force: true })));
  }
  const picture = { id, kind: "character" as const, prompt: `${name} (studio)`, url: `/media/uploads/${basename(path)}`, engine: ENGINE, path, saved: false, createdAt: Date.now() };
  casts.set(id, picture);
  saveLibrary();
  return c.json({ base: publicCast(base), picture: publicCast(picture) });
});

app.post("/api/studio/board", async (c) => {
  const b = await c.req.json().catch(() => ({})) as { pictureId?: string; name?: string; size?: string };
  const picture = b.pictureId ? casts.get(b.pictureId) : undefined;
  if (!picture) return c.json({ error: "pick the picture to turn into a board" }, 400);
  const capped = studioCap(c);
  if (capped) return c.json({ error: capped }, 429);
  const name = String(b.name ?? "").trim().slice(0, 60) || picture.prompt.replace(/\s*\((photo|studio)\)$/, "") || "Character";
  const id = randomUUID().slice(0, 8);
  const sheetPath = join(UPLOAD_DIR, `cast-${id}.png`);
  try {
    await makeCharacterSheet(picture.path, sheetPath, b.size === "1K" ? "1K" : "2K", c.req.raw.signal);
  } catch (e) {
    return upstreamError(c, e);
  }
  const card = { id, kind: "character" as const, prompt: name, url: `/media/uploads/${basename(sheetPath)}`, engine: ENGINE, path: sheetPath, saved: true, createdAt: Date.now() };
  casts.set(id, card);
  saveLibrary();
  return c.json(publicCast(card));
});

app.delete("/api/casts/:id", async (c) => {
  const card = casts.get(c.req.param("id"));
  if (!card) return c.json({ error: "not found" }, 404);
  casts.delete(card.id);
  await rm(card.path, { force: true });
  saveLibrary();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- seedance prompt pack

app.post("/api/recast/pack", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const clip = clips.get(b.clipId);
  if (!clip) return c.json({ error: "unknown clip" }, 400);
  const dPath = depthPath(clip.id);
  if (!existsSync(dPath)) return c.json({ error: "generate the depth map first", needsDepth: true }, 409);
  const ids: string[] = Array.isArray(b.castIds) ? b.castIds.filter((x: unknown) => typeof x === "string") : [];
  const refs = ids.map((id) => casts.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
  // characters first, then places, numbered in that order
  const ordered = [...refs.filter((r) => r.kind === "character"), ...refs.filter((r) => r.kind === "place")];
  const motion = await analyzeMotion(clip.path, dPath);
  const pack = buildPromptPack({
    depthUrl: `/media/depth/${clip.id}.mp4`,
    originalUrl: clip.url,
    references: ordered.map((r, i) => ({ tag: `@image${i + 1}`, kind: r.kind, label: r.prompt, url: r.url })),
    scene: typeof b.prompt === "string" ? b.prompt.slice(0, 1500) : undefined,
    look: typeof b.look === "string" ? b.look.slice(0, 200) : undefined,
    keepBackground: b.keepBackground !== false ? { tag: "@video2", url: clip.url } : undefined,
    background: b.keepBackground === false && typeof b.background === "string" ? b.background.slice(0, 600) : undefined,
    motion,
  });
  return c.json(pack);
});

// ---------------------------------------------------------------- renders

const renders = new OwnedMap<Render>();
const bus = new EventEmitter();
bus.setMaxListeners(0);
let takeCounter = 0;
const queue: Array<() => Promise<void>> = [];
let running = false;

function emit(id: string, ev: RenderEvent) {
  bus.emit(id, ev);
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) await queue.shift()!().catch(() => {});
  running = false;
}

const capCounts = new Map<string, number>();
function capKey(c: Context) {
  // the LAST hop is the one our proxy (ngrok) added; earlier ones are client-supplied
  const ip = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() || c.req.header("x-real-ip") || "local";
  return `${new Date().toISOString().slice(0, 10)}:${ip}`;
}

function consumeRenderCap(c: Context): string | null {
  if (RENDER_CAP <= 0) return null;
  const k = capKey(c);
  const n = capCounts.get(k) ?? 0;
  if (n >= RENDER_CAP) return `Daily render cap reached (${RENDER_CAP}). Run MOGFIELD locally for unlimited videos.`;
  capCounts.set(k, n + 1);
  return null;
}

function validate(b: Partial<RenderParams>): RenderParams | string {
  if (!b.clipId || !clips.has(b.clipId)) return "unknown clip";
  if (!CAMERA_PRESETS.includes(b.camera as never)) return "unknown camera preset";
  if (!(b.lens! in LENSES)) return "unknown lens";
  if (b.aspect !== "native" && !ASPECTS.includes(b.aspect as never)) return "unknown aspect";
  if (b.lut && b.lut !== "none" && (!b.lut.endsWith(".cube") || b.lut.includes("/") || !existsSync(join(LUT_DIR, b.lut)))) return "unknown LUT";
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    clipId: b.clipId,
    mode: b.mode === "recast" ? "recast" : "direct",
    camera: b.camera!,
    cameraStrength: num(b.cameraStrength, 0, 3, 1),
    lens: b.lens!,
    fStop: num(b.fStop, 0.7, 22, 2),
    focus: num(b.focus, 0, 1, 0.7),
    focusEnd: num(b.focusEnd, -1, 1, -1),
    lut: b.lut ?? "none",
    lutStrength: num(b.lutStrength, 0, 1, 1),
    grain: num(b.grain, 0, 0.3, 0.035),
    halation: num(b.halation, 0, 1.5, 0.3),
    aspect: b.aspect!,
    castId: b.castId && casts.has(b.castId) ? b.castId : undefined,
    castIds: Array.isArray(b.castIds) ? b.castIds.filter((x): x is string => typeof x === "string" && casts.has(x)).slice(0, 4) : undefined,
    model: typeof b.model === "string" && /^[a-z0-9_-]+:[\w./ -]+$/i.test(b.model) ? b.model : undefined,
    quality: b.quality === "480p" || b.quality === "768p" || b.quality === "1080p" || b.quality === "2K" ? b.quality : "720p",
    keepBackground: b.keepBackground !== false,
    background: typeof b.background === "string" ? b.background.slice(0, 600) : undefined,
    trim: (() => {
      const dur = clips.get(b.clipId!)!.duration;
      const s = num(b.trim?.start, 0, dur, 0);
      const e = Math.min(num(b.trim?.end, 0, dur, dur), s + 30); // a window of at most 30 s
      return e - s >= 1 && (s > 0.05 || e < dur - 0.05) ? { start: s, end: e } : undefined;
    })(),
    prompt: typeof b.prompt === "string" ? b.prompt.slice(0, 1000) : undefined,
    preparationId: typeof b.preparationId === "string" && /^[a-f0-9]{8}$/i.test(b.preparationId) ? b.preparationId : undefined,
    lora: H3_LORAS.some((l) => l.id === b.lora) ? b.lora : undefined,
    useDepth: b.useDepth === false ? false : undefined,
    restyle: b.restyle === true && b.useDepth === false ? true : undefined,
    sendAudio: b.sendAudio === false ? false : undefined,
    reshoot: typeof b.reshoot === "string" && b.reshoot in RESHOOT_ANGLES ? b.reshoot : undefined,
    reshootView:
      typeof b.reshoot === "string" && b.reshoot in RESHOOT_ANGLES && b.reshootView && typeof b.reshootView === "object"
        ? {
            azimuth: Math.round(num((b.reshootView as ReshootView).azimuth, -180, 180, 0)),
            elevation: Math.round(num((b.reshootView as ReshootView).elevation, -30, 90, 0)),
            distance: Math.round(num((b.reshootView as ReshootView).distance, 0, 1, 0.5) * 100) / 100,
          }
        : undefined,
    style: typeof b.style === "string" && b.style.trim() ? b.style.trim().slice(0, 600) : undefined,
    seed: Math.floor(num(b.seed, 0, 2 ** 31 - 1, Math.random() * 2 ** 31)),
  };
}

app.post("/api/renders", async (c) => {
  const params = validate(await c.req.json().catch(() => ({})));
  if (typeof params === "string") return c.json({ error: params }, 400);
  // a re-shoot moves the camera, so the model gets the original video, never the depth map that would lock it
  if (params.reshoot) params.useDepth = false;
  const target = params.model ? providerFor(params.model) : null;
  // depth off: the model gets the original video, so there is nothing to prepare
  const needsPreparation = params.mode === "recast" && params.useDepth !== false && target?.provider.id === "comfy" && target.model.includes("seedance-2-5");
  const preparation = params.preparationId ? preparations.get(params.preparationId) : undefined;
  if (needsPreparation && (!preparation || preparation.status !== "ready" || !preparation.approved || !preparation.result))
    return c.json({ error: "Prepare the clip, review the full mask and prepared input, and approve the exact artifacts before generating." }, 409);
  if (needsPreparation && preparation && (preparation.clipId !== params.clipId || !sameTrim(preparation.trim, params.trim)))
    return c.json({ error: "This approved preparation belongs to a different clip or trim. Prepare and review the current take." }, 409);
  // H3 character swap may also use an approved preparation (the SAM 3 silhouette take) instead of the raw video
  const optionalPreparation = params.mode === "recast" && target?.provider.id === "h3";
  if (optionalPreparation && params.preparationId && (!preparation?.approved || !preparation.result || preparation.clipId !== params.clipId || !sameTrim(preparation.trim, params.trim)))
    return c.json({ error: "That preparation is not approved for this clip and trim." }, 409);
  if (!needsPreparation && !optionalPreparation && params.preparationId)
    return c.json({ error: "Genjustsu preparations can only be used with Comfy Seedance 2.5 or H3 character swap." }, 400);
  const capped = consumeRenderCap(c);
  if (capped) return c.json({ error: capped }, 429);
  const id = randomUUID().slice(0, 8);
  const r: Render = {
    id, params, status: "queued", progress: 0, message: "Queued", engine: ENGINE, createdAt: Date.now(), take: ++takeCounter,
    ...(target?.provider.id === "comfy" ? { steps: makeSteps(SEEDANCE_STEPS) } : target?.provider.id === "h3" ? { steps: makeSteps(H3_STEPS) } : target?.provider.id === "refv" ? { steps: makeSteps(REFV_STEPS) } : {}),
  };
  renders.set(id, r);
  saveLibrary(); // a queued take survives a restart (as interrupted) and shows in the queue
  const clip = clips.get(params.clipId)!;
  // resolved inside the job so a slow first cut does not block the request
  const cast = params.castId ? casts.get(params.castId) : undefined;
  // No Seedance draft mode: the quality picked (480p or higher) is what gets rendered.
  const out = join(RENDER_DIR, `${id}.mp4`);

  queue.push(async () => {
    r.status = "running";
    r.message = "Starting";
    emit(id, { type: "status", render: r });
    let lastPreview = 0;
    try {
      r.message = params.trim ? "Trimming" : r.message;
      const src = await sourceFor(clip, params.trim);
      if (params.model) {
        const result = await runRecast(
          {
            renderId: id,
            clipId: src.id,
            clipPath: src.path,
            clipUrl: clip.url,
            width: clip.width,
            height: clip.height,
            duration: src.duration,
            characters: (params.castIds ?? []).map((cid) => casts.get(cid)!).filter((c) => c && c.kind === "character").map((c) => ({ path: c.path, url: c.url, label: c.prompt })),
            scene: params.prompt,
            keepBackground: params.keepBackground !== false,
            background: params.background,
            model: params.model,
            quality: params.quality ?? "720p",
            preparedVideoPath: preparation?.result?.seedanceInputPath,
            preparedVideoUrl: preparation?.result?.seedanceInputUrl,
            preparedAudioPath: preparation?.result ? join(dirname(preparation.result.seedanceInputPath), "vocals-plus3.wav") : undefined,
            lora: params.lora,
            seed: params.seed,
            useDepth: params.useDepth,
            restyle: params.restyle,
            sendAudio: params.sendAudio,
            reshoot: params.reshoot,
            reshootView: params.reshootView,
            style: params.style,
            outPath: out,
          },
          {
            progress: (p, m) => {
              r.progress = p;
              r.message = m;
              emit(id, { type: "progress", progress: p, message: m });
            },
            step: (key, stepState, note) => {
              if (setStep(r.steps, key, stepState, note)) emit(id, { type: "status", render: r });
            },
          },
        );
        if (result.draftTaskId) {
          r.isDraft = true;
          r.draftTaskId = result.draftTaskId;
          r.draftUrl = `/media/renders/${id}-draft.mp4`;
          r.url = r.draftUrl;
        }
      } else await engine.render(params, src.path, out, {
        progress: (p) => {
          r.progress = p;
          emit(id, { type: "progress", progress: p, message: r.message });
        },
        message: (m) => {
          r.message = m;
          emit(id, { type: "progress", progress: r.progress, message: m });
        },
        preview: (bytes, type) => {
          const now = Date.now();
          if (now - lastPreview < 250) return; // throttle to ~4 fps
          lastPreview = now;
          emit(id, { type: "preview", dataUrl: `data:${type};base64,${Buffer.from(bytes).toString("base64")}` });
        },
      }, cast?.path);
      r.status = "succeeded";
      r.progress = 1;
      r.message = "Done";
      r.url = `/media/renders/${id}.mp4`;
      if (existsSync(join(RENDER_DIR, `${id}.workflow.json`))) r.workflowUrl = `/media/renders/${id}.workflow.json`;
      finishAll(r.steps);
    } catch (e) {
      r.status = "failed";
      r.error = (e as Error).message;
      r.message = "Failed";
      failRunning(r.steps);
      console.error(`render ${id} failed:`, e);
    }
    emit(id, { type: "status", render: r });
    saveLibrary();
  });
  void pump();
  return c.json(r);
});

app.post("/api/renders/:id/finalize", (c) => {
  const id = c.req.param("id");
  const r = renders.get(id);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.status !== "succeeded" || !r.isDraft || !r.draftTaskId || !r.params.model)
    return c.json({ error: "this render has no ready Seedance 2.5 draft to finalize" }, 409);
  const target = providerFor(r.params.model);
  if (!target?.provider.finalizeDraft) return c.json({ error: "the selected provider cannot finalize this draft" }, 400);
  const clip = clips.get(r.params.clipId);
  if (!clip) return c.json({ error: "the source clip is no longer available" }, 404);
  const capped = consumeRenderCap(c);
  if (capped) return c.json({ error: capped }, 429);

  const finalPath = join(RENDER_DIR, `${id}.mp4`);
  r.status = "queued";
  r.progress = 0;
  r.message = "Final render queued";
  r.error = undefined;
  emit(id, { type: "status", render: r });
  queue.push(async () => {
    r.status = "running";
    r.message = "Starting 1080p final";
    emit(id, { type: "status", render: r });
    try {
      const src = await sourceFor(clip, r.params.trim);
      await target.provider.finalizeDraft!({ model: target.model, draftTaskId: r.draftTaskId!, outPath: finalPath }, {
        progress: (p, message) => {
          r.progress = p;
          r.message = message;
          emit(id, { type: "progress", progress: p, message });
        },
      });
      await restoreSourceAudio(src.path, finalPath);
      r.status = "succeeded";
      r.progress = 1;
      r.message = "1080p final ready";
      r.url = `/media/renders/${id}.mp4`;
      r.isDraft = false;
      r.draftTaskId = undefined;
    } catch (e) {
      r.status = "failed";
      r.error = (e as Error).message;
      r.message = "Final render failed";
      console.error(`final render ${id} failed:`, e);
    }
    emit(id, { type: "status", render: r });
    saveLibrary();
  });
  void pump();
  return c.json(r);
});

app.get("/api/renders", (c) => c.json([...renders.values()].sort((a, b) => b.createdAt - a.createdAt)));
app.post("/api/renders/:id/dismiss", (c) => {
  const r = renders.get(c.req.param("id"));
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.status === "queued" || r.status === "running") return c.json({ error: "still generating" }, 409);
  r.dismissed = true;
  saveLibrary();
  return c.json(r);
});

app.get("/api/renders/:id", (c) => {
  const r = renders.get(c.req.param("id"));
  return r ? c.json(r) : c.json({ error: "not found" }, 404);
});

app.get("/api/renders/:id/events", (c) => {
  const id = c.req.param("id");
  const r = renders.get(id);
  if (!r) return c.json({ error: "not found" }, 404);
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: JSON.stringify({ type: "status", render: r } satisfies RenderEvent) });
    if (r.status === "succeeded" || r.status === "failed") return;
    await new Promise<void>((resolve) => {
      const on = (ev: RenderEvent) => {
        const w = stream.writeSSE({ data: JSON.stringify(ev) });
        if (ev.type === "status" && (ev.render.status === "succeeded" || ev.render.status === "failed")) void w.finally(done);
      };
      const done = () => {
        bus.off(id, on);
        resolve();
      };
      bus.on(id, on);
      stream.onAbort(done);
    });
  });
});

// ---------------------------------------------------------------- share reel

// 16:9 A/B: the original take and the finished render side by side, in sync, with
// the label overlay the browser drew (ffmpeg builds without drawtext are common).
app.post("/api/renders/:id/ab", async (c) => {
  const r = renders.get(c.req.param("id"));
  if (!r || r.status !== "succeeded") return c.json({ error: "render not ready" }, 400);
  const clip = clips.get(r.params.clipId);
  if (!clip) return c.json({ error: "the original video of this take is no longer in the library" }, 404);
  const b = (await c.req.json().catch(() => ({}))) as { overlay?: unknown };
  const m = /^data:image\/png;base64,(.+)$/.exec(String(b.overlay ?? ""));
  if (!m) return c.json({ error: "overlay PNG data URL required" }, 400);
  const overlay = join(REEL_DIR, `${r.id}-ab-overlay.png`);
  await writeFile(overlay, Buffer.from(m[1], "base64"));
  // the same section of the take the render was made from
  const src = await sourceFor(clip, r.params.trim);
  const after = join(RENDER_DIR, `${r.id}.mp4`);
  const dur = Math.min(src.duration, (await probe(after)).duration);
  const box = AB_LAYOUT[clip.width < clip.height ? "portrait" : "landscape"];
  const fit = (k: "a" | "b") => `scale=${box[k].w}:${box[k].h}:force_original_aspect_ratio=decrease,setsar=1,fps=24`;
  const at = (k: "a" | "b") => `x=${box[k].x + box[k].w / 2}-w/2:y=${box[k].y + box[k].h / 2}-h/2`;
  const filter = [
    `color=c=0x0b0b0d:s=1920x1080:r=24:d=${dur}[bg]`,
    `[0:v]trim=0:${dur},setpts=PTS-STARTPTS,${fit("a")}[a]`,
    `[1:v]trim=0:${dur},setpts=PTS-STARTPTS,${fit("b")}[b]`,
    `[bg][a]overlay=${at("a")}:shortest=1[t1]`,
    `[t1][b]overlay=${at("b")}:shortest=1[t2]`,
    `[t2][2:v]overlay=0:0:shortest=1,format=yuv420p[v]`,
  ].join(";");
  const out = join(REEL_DIR, `${r.id}-ab.mp4`);
  await ffmpegWithProgress(
    ["-i", src.path, "-i", after, "-loop", "1", "-i", overlay, "-filter_complex", filter, "-map", "[v]", "-map", "0:a?", "-t", String(dur),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out],
    dur, () => {},
  );
  return c.json({ url: `/media/reels/${r.id}-ab.mp4` });
});

app.post("/api/reels", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = renders.get(b.renderId);
  if (!r || r.status !== "succeeded") return c.json({ error: "render not ready" }, 400);
  const clip = clips.get(r.params.clipId)!;
  const decode = (d: unknown) => {
    const m = /^data:image\/png;base64,(.+)$/.exec(String(d ?? ""));
    return m ? Buffer.from(m[1], "base64") : null;
  };
  const title = decode(b.titleCard);
  const end = decode(b.endCard);
  if (!title || !end) return c.json({ error: "titleCard and endCard PNG data URLs required" }, 400);
  const id = r.id;
  const tPath = join(REEL_DIR, `${id}-title.png`);
  const ePath = join(REEL_DIR, `${id}-end.png`);
  await writeFile(tPath, title);
  await writeFile(ePath, end);
  const after = join(RENDER_DIR, `${id}.mp4`);
  const out = join(REEL_DIR, `${id}.mp4`);
  const dur = Math.min(clip.duration, (await probe(after)).duration);
  const fit = "scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1,fps=24";
  const card = "scale=1080:1920,setsar=1,fps=24,format=yuv420p";
  const filter = [
    `[0:v]${card}[t]`,
    `[1:v]trim=0:${dur},setpts=PTS-STARTPTS,${fit}[b]`,
    `[2:v]trim=0:${dur},setpts=PTS-STARTPTS,${fit}[a]`,
    `[b][a]vstack,drawbox=x=0:y=957:w=1080:h=6:color=0x000000:t=fill,format=yuv420p[mid]`,
    `[3:v]${card}[e]`,
    `[t][mid][e]concat=n=3:v=1:a=0[out]`,
  ].join(";");
  await ffmpegWithProgress(
    ["-loop", "1", "-t", "1.6", "-i", tPath, "-i", clip.path, "-i", after, "-loop", "1", "-t", "2.4", "-i", ePath,
      "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", out],
    dur + 4, () => {},
  );
  return c.json({ url: `/media/reels/${id}.mp4` });
});

// ---------------------------------------------------------------- misc

app.get("/api/health", async (c) => {
  const workflows = existsSync(WORKFLOW_DIR) ? (await readdir(WORKFLOW_DIR)).filter((f) => f.endsWith(".json")) : [];
  let ffmpeg = true;
  let rubberBandConfigured = true;
  await exec("ffmpeg", ["-version"]).catch(() => (ffmpeg = false));
  await exec(process.env.RUBBERBAND_BIN?.trim() || "rubberband", ["--version"]).catch(() => (rubberBandConfigured = false));
  return c.json({
    engine: ENGINE, target: process.env.COMFY_BASE_URL ?? (ENGINE === "comfy" ? "https://cloud.comfy.org" : null), workflows, ffmpeg,
    renderCap: RENDER_CAP, repo: REPO_URL,
  preparation: { comfyConfigured: !!process.env.COMFY_API_KEY?.trim() || !!process.env.COMFY_BASE_URL?.trim(), rubberBandConfigured },
  });
});

app.get("/api/models", async (c) => c.json(await listModels()));

// Text to video: a new shot from a prompt and up to 4 reference images.
app.get("/api/t2v", (c) => c.json(listTakes()));
app.post("/api/t2v", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { prompt?: unknown; imageIds?: unknown; model?: unknown; quality?: unknown; seconds?: unknown; aspect?: unknown; audio?: unknown };
  const prompt = typeof b.prompt === "string" ? b.prompt.trim().slice(0, 6000) : "";
  if (!prompt) return c.json({ error: "describe the shot" }, 400);
  // a curated Seedance model, or any video model in the Comfy API catalog ("comfy:<provider>/<model>")
  const curated = (await listModels()).find((m) => m.id === b.model && m.available && /seedance/.test(m.id));
  const listed = !curated && typeof b.model === "string" ? catalogModel(b.model.replace(/^comfy:/, "")) : undefined;
  if (listed?.needs) return c.json({ error: `${listed.label}: ${listed.needs.toLowerCase()}, so it cannot run from Create` }, 400);
  const model = curated ?? (listed?.outputs.includes("video") ? { id: `comfy:${listed.id}`, qualities: ["480p", "720p", "1080p"], maxSeconds: 30 } : undefined);
  if (!model) return c.json({ error: "pick a video model that is available on your Comfy API account" }, 400);
  const quality = typeof b.quality === "string" && (model.qualities as string[]).includes(b.quality) ? b.quality : model.qualities[0];
  const seconds = typeof b.seconds === "number" && Number.isFinite(b.seconds) ? Math.round(Math.min(model.maxSeconds, Math.max(curated ? 4 : 1, b.seconds))) : 5;
  const aspect = typeof b.aspect === "string" && b.aspect in T2V_ASPECTS ? (b.aspect as T2vAspect) : "9:16";
  const images = (Array.isArray(b.imageIds) ? b.imageIds : []).filter((x): x is string => typeof x === "string").map((id) => casts.get(id)).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 4);
  const capped = consumeRenderCap(c);
  if (capped) return c.json({ error: capped }, 429);
  return c.json(startTake({ prompt, imageIds: images.map((i) => i.id), imagePaths: images.map((i) => i.path), model: model.id, quality, seconds, aspect, audio: b.audio !== false, catalog: !curated }));
});

// Comfy API credits for the header: what is left after charges still pending. Cached for 20 s.
let credits: { at: number; body: unknown } | null = null;
app.get("/api/credits", async (c) => {
  const key = process.env.COMFY_API_KEY?.trim();
  if (!key) return c.json({ error: "no COMFY_API_KEY" }, 404);
  if (credits && Date.now() - credits.at < 20_000 && c.req.query("fresh") === undefined) return c.json(credits.body);
  try {
    const r = await fetch("https://api.comfy.org/customers/balance", { headers: { "X-API-KEY": key }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return c.json({ error: `Comfy answered HTTP ${r.status}` }, 502);
    const b = (await r.json()) as { effective_balance_cents?: number; prepaid_balance_cents?: number; pending_charges_cents?: number; cloud_credit_balance_cents?: number; currency?: string };
    const usd = (x?: number) => Math.round(x ?? 0) / 100;
    const body = { available: usd(b.effective_balance_cents), prepaid: usd(b.prepaid_balance_cents), pending: usd(b.pending_charges_cents), cloud: usd(b.cloud_credit_balance_cents), currency: b.currency ?? "usd" };
    credits = { at: Date.now(), body };
    return c.json(body);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// The whole Comfy API catalog: every model that makes a video or a picture from a prompt.
app.get("/api/catalog", (c) => c.json(catalogModels(c.req.query("output") === "image" ? "image" : "video")));

// Create Image: a prompt (+ up to 4 reference pictures) through any image model in the catalog.
app.post("/api/image", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { prompt?: unknown; model?: unknown; imageIds?: unknown; aspect?: unknown; quality?: unknown };
  const prompt = typeof b.prompt === "string" ? b.prompt.trim().slice(0, 4000) : "";
  if (!prompt) return c.json({ error: "describe the picture" }, 400);
  const id0 = typeof b.model === "string" && b.model ? b.model : SHEET_MODEL;
  const listed = catalogModel(id0);
  if (id0 !== SHEET_MODEL && !listed?.outputs.includes("image")) return c.json({ error: "pick an image model from the list" }, 400);
  if (listed?.needs) return c.json({ error: `${listed.label}: ${listed.needs.toLowerCase()}, so it cannot run from Create Image` }, 400);
  const images = (Array.isArray(b.imageIds) ? b.imageIds : []).filter((x): x is string => typeof x === "string").map((x) => casts.get(x)).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 4);
  const aspect = typeof b.aspect === "string" && b.aspect in T2V_ASPECTS ? T2V_ASPECTS[b.aspect as T2vAspect] : 1;
  const capped = studioCap(c);
  if (capped) return c.json({ error: capped }, 429);
  const id = randomUUID().slice(0, 8);
  const path = join(UPLOAD_DIR, `cast-${id}.png`);
  try {
    // Gemini image models take a contents/parts request the schema filler does not write
    if (id0.startsWith("vertexai/")) await geminiImage(id0, images.map((i) => i.path), prompt, nearestRatio(aspect), b.quality === "1K" ? "1K" : "2K", path, c.req.raw.signal);
    else await runCatalogModel({ model: id0, output: "image", prompt, imagePaths: images.map((i) => i.path), quality: typeof b.quality === "string" ? b.quality : "1080p", aspect, outPath: path }, { progress: () => {}, signal: c.req.raw.signal });
  } catch (e) {
    return upstreamError(c, e);
  }
  const card = { id, kind: "character" as const, prompt: `${prompt.replace(/\s+/g, " ").slice(0, 60)} (image)`, url: `/media/uploads/${basename(path)}`, engine: ENGINE, path, saved: true, createdAt: Date.now() };
  casts.set(id, card);
  saveLibrary();
  return c.json(publicCast(card));
});

// Restyle: a style picture turned into words for the Style box.
app.post("/api/style/describe", async (c) => {
  const body = await c.req.parseBody();
  if (!(body.file instanceof File) || !body.file.type.startsWith("image/")) return c.json({ error: "add a picture" }, 400);
  try {
    return c.json({ style: await describeStyle(Buffer.from(await body.file.arrayBuffer()), body.file.type) });
  } catch (e) {
    return upstreamError(c, e);
  }
});

const nearestAspect = (ratio: number) => (Object.keys(T2V_ASPECTS) as T2vAspect[]).reduce((best, k) => (Math.abs(T2V_ASPECTS[k] - ratio) < Math.abs(T2V_ASPECTS[best] - ratio) ? k : best), "9:16");

// Start / end frame video: a clip that starts on one picture and/or lands on another.
app.post("/api/frames", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { prompt?: unknown; startId?: unknown; endId?: unknown; model?: unknown; quality?: unknown; seconds?: unknown; aspect?: unknown; audio?: unknown };
  if (!isFrameModel(b.model)) return c.json({ error: "pick a model" }, 400);
  const card = (x: unknown) => (typeof x === "string" ? casts.get(x) : undefined);
  const start = card(b.startId);
  const end = card(b.endId);
  if (!start && !end && !FRAME_MODELS[b.model].text) return c.json({ error: "add a start frame or an end frame" }, 400);
  if (FRAME_MODELS[b.model].needsStart && !start) return c.json({ error: `${FRAME_MODELS[b.model].label} needs a start frame` }, 400);
  // H3 and LTX take an end frame only next to a start frame
  if (end && !start && FRAME_MODELS[b.model].text) return c.json({ error: `${FRAME_MODELS[b.model].label} needs a start frame to use an end frame` }, 400);
  const prompt = typeof b.prompt === "string" ? b.prompt.trim().slice(0, 6000) : "";
  if (!prompt) return c.json({ error: "describe what happens" }, 400);
  // with a frame the shape comes from the frame, so models that name their size get the right one
  const frame = start ?? end;
  const size = frame ? await probe(frame.path).catch(() => null) : null;
  const aspect = size ? nearestAspect(size.width / size.height) : typeof b.aspect === "string" && b.aspect in T2V_ASPECTS ? (b.aspect as T2vAspect) : "9:16";
  const capped = consumeRenderCap(c);
  if (capped) return c.json({ error: capped }, 429);
  return c.json(
    startFramesTake({
      prompt, model: b.model, quality: typeof b.quality === "string" ? b.quality : "720p",
      // the length that actually runs, so History shows it
      seconds: snapSeconds(b.model, Math.min(FRAME_MODELS[b.model].max, Math.max(FRAME_MODELS[b.model].min, typeof b.seconds === "number" ? b.seconds : 5))),
      aspect, audio: b.audio !== false,
      start: start && { id: start.id, path: start.path }, end: end && { id: end.id, path: end.path },
    }),
  );
});

// Extend: continue a take from its last frame, then join the two.
app.post("/api/extend", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { clipId?: unknown; takeId?: unknown; from?: unknown; prompt?: unknown; model?: unknown; quality?: unknown; seconds?: unknown; audio?: unknown };
  // the source: an uploaded video, or a finished take (an extended one continues from its joined video)
  let clip: { id: string; path: string; duration: number; width: number; height: number } | undefined = typeof b.clipId === "string" ? clips.get(b.clipId) : undefined;
  if (!clip && typeof b.takeId === "string") {
    const t = listTakes().find((x) => x.id === b.takeId && x.status === "succeeded");
    const url = t?.joinedUrl ?? t?.url;
    if (t && url) {
      const path = join(RENDER_DIR, basename(url));
      const pr = await probe(path).catch(() => null);
      if (pr) clip = { id: `take:${t.id}`, path, duration: pr.duration, width: pr.width, height: pr.height };
    }
  }
  if (!clip) return c.json({ error: "pick a video to extend" }, 400);
  if (!isFrameModel(b.model)) return c.json({ error: "pick a model" }, 400);
  const from = typeof b.from === "number" && Number.isFinite(b.from) ? Math.min(clip.duration, Math.max(0.2, b.from)) : clip.duration;
  const aspect = nearestAspect(clip.width / clip.height);
  const capped = consumeRenderCap(c);
  if (capped) return c.json({ error: capped }, 429);
  return c.json(
    startExtend({
      clipId: clip.id, clipPath: clip.path, from, prompt: typeof b.prompt === "string" ? b.prompt.trim().slice(0, 4000) : "", model: b.model,
      quality: typeof b.quality === "string" ? b.quality : "720p", seconds: typeof b.seconds === "number" ? b.seconds : 5, aspect, audio: b.audio !== false,
    }),
  );
});

// Where workflows run. GET checks the current choice; POST with test: true only
// checks the given one, without it the choice is saved and applied.
app.get("/api/backend", async (c) => c.json(await checkBackend(currentBackend())));
app.post("/api/backend", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { target?: unknown; url?: unknown; test?: unknown };
  const target = body.target === "custom" ? "custom" : "cloud";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (target === "custom" && !/^https?:\/\/[^\s/]+/i.test(url)) return c.json({ error: "enter your ComfyUI address, e.g. http://127.0.0.1:8189" }, 400);
  const next: Backend = target === "custom" ? { target, url } : { target };
  if (body.test === true) return c.json(await checkBackend(next));
  await saveBackend(next);
  return c.json(await checkBackend(currentBackend()));
});

app.get("/api/luts", async (c) => c.json((await readdir(LUT_DIR)).filter((f) => f.endsWith(".cube")).sort()));

// Open in ComfyUI: the graph a tool would run with the settings on screen
app.post("/api/workflow-export", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as ExportRequest;
  if (!["create", "extend", "reshoot", "restyle", "swap", "image"].includes(b.tool)) return c.json({ error: "unknown tool" }, 400);
  for (const k of ["prompt", "style", "setting"] as const) if (typeof b[k] === "string") b[k] = b[k].slice(0, 6000);
  try {
    return c.json(await exportWorkflow(b));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.get("/api/workflows/:name", async (c) => {
  const name = c.req.param("name").replace(/[^a-z0-9_-]/gi, "");
  const p = join(WORKFLOW_DIR, `${name}.json`);
  if (!existsSync(p)) return c.json({ error: "not installed" }, 404);
  return c.body(await readFile(p, "utf8"), 200, { "content-type": "application/json" });
});

// Agent mode (experimental): a director that storyboards, then films after each approval
agentRoutes(app, (id) => casts.get(id));

app.use("/luts/*", serveStatic({ root: LUT_DIR, rewriteRequestPath: (p) => p.replace(/^\/luts/, "") }));
app.use("/media/*", serveStatic({ root: DATA_DIR, rewriteRequestPath: (p) => p.replace(/^\/media/, "") }));
app.use("/examples/*", serveStatic({ root: join(EXAMPLES_DIR, "..", ".."), }));

// unknown API paths answer JSON, not the app page
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

if (process.env.NODE_ENV === "production") {
  const dist = join(APP_DIR, "dist");
  app.use("/*", serveStatic({ root: dist }));
  app.get("*", async (c) => c.html(await readFile(join(dist, "index.html"), "utf8")));
}

await loadLibrary();
for (const img of library.images) if (existsSync(img.path)) casts.set(img.id, { ...img, createdAt: img.createdAt ?? 0 });
for (const r of library.renders) {
  if (r.status === "succeeded") {
    if (existsSync(join(RENDER_DIR, `${r.id}${r.isDraft ? "-draft" : ""}.mp4`))) renders.set(r.id, r);
  } else if (r.status === "queued" || r.status === "running") {
    failRunning(r.steps);
    renders.set(r.id, { ...r, status: "failed", message: "Failed", error: "Interrupted: the server restarted before this take finished." });
  } else renders.set(r.id, r);
}
for (const { state, changed } of await loadPreparations(GENJUTSU_DIR, verifyPreparation)) {
  preparations.set(state.id, state as PreparationState);
  if (changed) {
    failRunning(state.steps);
    void persistPreparation(GENJUTSU_DIR, state);
  }
}
if (preparations.size) console.log(`restored ${preparations.size} preparation(s)`);
takeCounter = Math.max(0, ...[...renders.values()].map((r) => r.take));
await loadSamples();
await loadUploads();
await adoptOlderPreparations();
void listModels().catch(() => {}); // warm the model catalog before the first visitor
if (PER_VISITOR) {
  onPurged(saveLibrary);
  const sweep = () => void sweepExpired([UPLOAD_DIR, RENDER_DIR, REEL_DIR, TRIM_DIR, join(DATA_DIR, "depth"), GENJUTSU_DIR]).then((n) => n && console.log(`removed ${n} expired visitor item(s)`));
  setInterval(sweep, 30 * 60_000).unref();
  sweep();
}

serve({ fetch: app.fetch, port: PORT, hostname: process.env.BACKLOT_HOST }, () => {
  console.log(`MOGFIELD server on http://localhost:${PORT}  engine=${ENGINE}${ENGINE === "comfy" ? `  target=${process.env.COMFY_BASE_URL ?? "Comfy Cloud"}` : ""}`);
});
