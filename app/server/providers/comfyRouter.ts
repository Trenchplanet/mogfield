// Comfy API provider: partner video models (Seedance 2.5 and others) through
// Comfy's model router, using the Comfy SDK and COMFY_API_KEY.
//
// Inputs are uploaded to Comfy Cloud and passed as signed URLs; the request
// body is filled from each model's published schema (see schemaFill.ts).

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { exec } from "../media.js";
import { Comfy, comfy } from "@comfyorg/sdk";
import { contentListBody, fillBody, findVideoUrl, isContentListSchema, miniMaxH3Body, seedanceText } from "./schemaFill.js";
import { runSeedanceWorkflow, useSeedanceWorkflow } from "./seedanceWorkflow.js";
import type { FinalizeDraftJob, GenerateJob, ModelOption, Provider, ProviderHooks } from "./types.js";

// Curated Comfy Router video models. Seedance accepts reference media; LTX is
// text-only; MiniMax H3 accepts text and optional character image references.
const CURATED: Omit<ModelOption, "available" | "needs" | "provider">[] = [
  { id: "comfy:byteplus/dreamina-seedance-2-5-260628", label: "Seedance 2.5", badges: ["Top"], qualities: ["480p", "720p", "1080p"], maxSeconds: 30, pricing: { kind: "seedance-tokens", per1k: { "480p": 1.931, "720p": 1.931, "1080p": 2.112 } } },
  { id: "comfy:byteplus/dreamina-seedance-2-0-260128", label: "Seedance 2.0", badges: [], qualities: ["480p", "720p"], maxSeconds: 15, pricing: { kind: "seedance-tokens", per1k: { "480p": 1.297, "720p": 1.297 } } },
  { id: "comfy:byteplus/dreamina-seedance-2-0-fast-260128", label: "Seedance 2.0 Fast", badges: ["Cheapest"], qualities: ["480p", "720p"], maxSeconds: 15, pricing: { kind: "seedance-tokens", per1k: { "480p": 0.996, "720p": 0.996 } } },
  { id: "comfy:byteplus/dreamina-seedance-2-0-mini", label: "Seedance 2.0 Mini", badges: [], qualities: ["480p", "720p"], maxSeconds: 15, pricing: { kind: "seedance-tokens", per1k: { "480p": 0.649, "720p": 0.649 } } },
  { id: "comfy:ltx/ltx-2-5-fast", label: "LTX 2.5 Fast", badges: ["Text-to-video"], qualities: ["720p", "1080p"], maxSeconds: 20, inputMode: "text-only" },
  { id: "comfy:ltx/ltx-2-5-pro", label: "LTX 2.5 Pro", badges: ["Text-to-video"], qualities: ["720p", "1080p"], maxSeconds: 20, inputMode: "text-only" },
  { id: "comfy:minimax/minimax-h3", label: "MiniMax H3", badges: ["Video + audio"], qualities: ["768p", "2K"], maxSeconds: 15, inputMode: "text-image" },
];

const hasKey = () => !!process.env.COMFY_API_KEY?.trim();

// Which curated models this account can reach. The catalog walk takes ~10 s,
// so it runs in the background and the list is served from the last result.
let catalog: { at: number; ids: Set<string> } | null = null;
let walking: Promise<void> | null = null;
function refreshCatalog() {
  // a walk that stalls (network drop, the Mac sleeping) must not hold the model picker forever
  walking ??= Promise.race([
    (async () => {
      const ids = new Set<string>();
      for await (const m of comfy.models.list()) ids.add(m.id);
      catalog = { at: Date.now(), ids };
    })(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the Comfy model list did not answer within 45 s")), 45_000).unref()),
  ]).finally(() => (walking = null));
  return walking;
}

/** A Comfy Cloud client for uploads, even when COMFY_BASE_URL points at a local ComfyUI. */
function cloudClient(): Comfy {
  const saved = process.env.COMFY_BASE_URL;
  delete process.env.COMFY_BASE_URL;
  try {
    return new Comfy({ clientInfo: "mogfield/0.1" });
  } finally {
    if (saved !== undefined) process.env.COMFY_BASE_URL = saved;
  }
}

function draftTaskId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const id = (data as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : undefined;
}

function refusalMessage(error: unknown): Error {
  const e = error as { message?: unknown; errorType?: unknown; requestId?: unknown };
  // the full upstream answer goes to the server log: the short message alone cannot say which input was refused
  try {
    console.error("comfy error detail:", JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})).slice(0, 4000));
  } catch {
    /* not serialisable */
  }
  const request = typeof e?.requestId === "string" ? ` Comfy request ID: ${e.requestId}.` : "";
  if (e?.errorType === "content_policy_violation") {
    return new Error(`Comfy refused this request under its content policy. The app did not retry or alter the request; Comfy decides what it accepts.${request}`);
  }
  // keep the error bucket and request ID so a failure can be traced with Comfy
  const message = error instanceof Error ? error.message : String(e?.message ?? error);
  const bucket = typeof e?.errorType === "string" && e.errorType ? ` [${e.errorType}]` : "";
  return bucket || request ? new Error(`${message}${bucket}${request}`) : error instanceof Error ? error : new Error(message);
}

async function submitAndSave(model: string, body: Record<string, unknown>, outPath: string, hooks: ProviderHooks): Promise<unknown> {
  try {
    hooks.progress(0.15, "Queued");
    hooks.step?.("queue", "running", "sent to Comfy Router");
    const result = await comfy.models.subscribe(model, body, {
      signal: hooks.signal,
      timeoutMs: 20 * 60_000,
      onQueueUpdate: (u) => {
        const status = String(u.status);
        if (status === "IN_QUEUE") {
          hooks.progress(0.15, u.queuePosition != null ? `In queue (#${u.queuePosition})` : "In queue");
          hooks.step?.("queue", "running", u.queuePosition != null ? `queue #${u.queuePosition}` : undefined);
        } else if (status === "IN_PROGRESS") {
          hooks.progress(0.5, "Generating");
          hooks.step?.("generate", "running");
        }
      },
    });

    hooks.progress(0.9, "Downloading result");
    hooks.step?.("finish", "running", "downloading the video");
    if (result.kind === "binary") {
      await writeFile(outPath, result.data);
      return undefined;
    }
    const url = findVideoUrl(result.data);
    if (!url) throw new Error(`${model} finished but returned no video URL`);
    const res = await fetch(url, { signal: hooks.signal });
    if (!res.ok) throw new Error(`downloading the result failed: HTTP ${res.status}`);
    await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    return result.data;
  } catch (error) {
    throw refusalMessage(error);
  }
}

/** A new video from a prompt and up to 4 reference images (no source video):
 *  Seedance's content-list request with text + reference_image items. */
export async function generateFromPrompt(
  o: { model: string; prompt: string; imagePaths: string[]; quality: string; seconds: number; aspect: number; audio: boolean; outPath: string },
  hooks: ProviderHooks,
): Promise<void> {
  if (!hasKey()) throw new Error("Comfy API key missing: add COMFY_API_KEY to app/.env and restart");
  if (useSeedanceWorkflow(o.model)) {
    const text = seedanceText({ prompt: o.prompt, imageUrls: o.imagePaths });
    return runSeedanceWorkflow({ model: o.model, text, videos: [], images: o.imagePaths, audios: [], quality: o.quality, aspect: o.aspect, duration: o.seconds, audio: o.audio }, o.outPath, hooks);
  }
  hooks.progress(0.05, "Reading model inputs");
  const schema = await comfy.models.schema(o.model);
  if (schema.unchanged) throw new Error("unexpected cached schema");
  if (!isContentListSchema(schema.document as never)) throw new Error(`${o.model} does not take a prompt with reference images`);
  hooks.progress(0.1, o.imagePaths.length ? "Uploading reference images" : "Sending the prompt");
  const cloud = cloudClient();
  const imageUrls: string[] = [];
  for (const path of o.imagePaths) imageUrls.push((await cloud.assets.fromFile(path).getDownloadUrl()).url);
  const body = contentListBody(schema.document as never, { prompt: o.prompt, imageUrls, quality: o.quality, duration: o.seconds, aspect: o.aspect });
  if ("generate_audio" in body) body.generate_audio = o.audio;
  console.log(`submit ${o.model}: text${imageUrls.length ? `, ${imageUrls.length} reference image(s)` : ""} · resolution=${String(body.resolution ?? "-")} ratio=${String(body.ratio ?? "-")} duration=${String(body.duration ?? "-")}`);
  const sources = new Map(imageUrls.map((u, i) => [u, o.imagePaths[i]]));
  const readable = JSON.stringify({ model: o.model, body }, (_, v) => (typeof v === "string" && sources.has(v) ? `file:${sources.get(v)}` : v), 2);
  await writeFile(o.outPath.replace(/\.mp4$/i, "") + ".request.json", readable).catch(() => {});
  await submitAndSave(o.model, body, o.outPath, hooks);
}

export const comfyRouter: Provider = {
  id: "comfy",
  label: "Comfy API",

  async models(): Promise<ModelOption[]> {
    const base = CURATED.map((m) => ({
      ...m,
      provider: m.id.includes(":ltx/") ? "Comfy API · LTX" : m.id.includes(":minimax/") ? "Comfy API · MiniMax" : "Comfy API · BytePlus",
    }));
    if (!hasKey()) return base.map((m) => ({ ...m, available: false, needs: "Add COMFY_API_KEY to app/.env" }));
    if (!catalog) {
      try {
        await refreshCatalog();
      } catch (e) {
        return base.map((m) => ({ ...m, available: false, needs: `Comfy API unreachable: ${(e as Error).message}` }));
      }
    } else if (Date.now() - catalog.at > 10 * 60_000) void refreshCatalog().catch(() => {});
    const pinned = process.env.MOGFIELD_SEEDANCE_MODEL?.trim();
    return base.map((m, i) => {
      const id = i === 0 && pinned ? `comfy:${pinned}` : m.id;
      const listed = catalog!.ids.has(id.slice("comfy:".length));
      return { ...m, id, available: listed, needs: listed ? undefined : "Not available on your Comfy API account" };
    });
  },

  async generate(job: GenerateJob, hooks: ProviderHooks) {
    if (!hasKey()) throw new Error("Comfy API key missing: add COMFY_API_KEY to app/.env and restart");
    const model = job.model;

    hooks.progress(0.05, "Reading model inputs");
    const schema = await comfy.models.schema(model);
    if (schema.unchanged) throw new Error("unexpected cached schema");

    const textOnlyLtx = model.startsWith("ltx/ltx-2-5-");
    const miniMaxH3 = model === "minimax/minimax-h3";
    const noVideoInput = textOnlyLtx || miniMaxH3;
    hooks.progress(0.1, noVideoInput ? "Preparing text and image references" : "Uploading depth map and references");
    hooks.step?.("upload", "running", textOnlyLtx ? "no reference media for this model" : miniMaxH3 ? "uploading optional character image" : undefined);
    const cloud = cloudClient();
    // MOGFIELD_PREP_AUDIO decides how a prepared take's pitched vocals reach Seedance:
    //   embedded (default) audio track inside the prepared video
    //   separate           silent video + the vocal stem as a reference_audio item
    //   off                silent video, no audio sent
    const prepAudio = job.sendAudio === false ? "off" : (process.env.MOGFIELD_PREP_AUDIO ?? "embedded").trim().toLowerCase();
    let primaryVideoPath = job.preparedVideoPath ?? job.depthPath;
    const audioPaths: string[] = [];
    if (!noVideoInput && job.preparedVideoPath && (prepAudio === "separate" || prepAudio === "off")) {
      const silent = job.preparedVideoPath.replace(/\.mp4$/i, "") + ".silent.mp4";
      if (!existsSync(silent)) await exec("ffmpeg", ["-y", "-v", "error", "-i", job.preparedVideoPath, "-map", "0:v:0", "-c:v", "copy", "-an", "-movflags", "+faststart", silent]);
      primaryVideoPath = silent;
      if (prepAudio === "separate" && job.preparedAudioPath && existsSync(job.preparedAudioPath)) {
        // the separated stem can come back FLAC under a .wav name; Seedance takes only real wav or mp3
        const pcm = job.preparedAudioPath.replace(/\.[^./]+$/, "") + ".pcm.wav";
        if (!existsSync(pcm)) await exec("ffmpeg", ["-y", "-v", "error", "-i", job.preparedAudioPath, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", pcm]);
        audioPaths.push(pcm);
      }
    }

    // the ComfyUI workflow path: the same media, in the same order, as load nodes
    if (!miniMaxH3 && !textOnlyLtx && !job.draftPreview && useSeedanceWorkflow(model)) {
      const extra = job.preparedDepthPath ? [job.preparedDepthPath] : !job.preparedVideoPath && job.originalPath ? [job.originalPath] : [];
      const videos = [primaryVideoPath, ...extra];
      const images = job.sheetPath ? [job.sheetPath] : [];
      const text = seedanceText({ prompt: job.prompt, negative: job.negative, videoUrl: videos[0], extraVideoUrls: extra, imageUrls: images, audioUrls: audioPaths });
      await runSeedanceWorkflow({ model, text, videos, images, audios: audioPaths, quality: job.quality, aspect: job.aspect, duration: job.duration, audio: audioPaths.length > 0, seed: job.seed,
        // a prepared take is a swap inside that very video: edit it, so its length, framing and cuts stay
        taskType: job.preparedVideoPath ? "edit" : undefined }, job.outPath, hooks);
      return;
    }
    const audioUrls: string[] = [];
    for (const path of audioPaths) audioUrls.push((await cloud.assets.fromFile(path).getDownloadUrl()).url);
    const videoUrl = noVideoInput ? undefined : (await cloud.assets.fromFile(primaryVideoPath).getDownloadUrl()).url;
    const depthReferenceUrl = !noVideoInput && job.preparedDepthPath ? (await cloud.assets.fromFile(job.preparedDepthPath).getDownloadUrl()).url : undefined;
    const originalUrl = !noVideoInput && !job.preparedVideoPath && job.originalPath ? (await cloud.assets.fromFile(job.originalPath).getDownloadUrl()).url : undefined;
    const imageUrls = !textOnlyLtx && job.sheetPath ? [(await cloud.assets.fromFile(job.sheetPath).getDownloadUrl()).url] : [];
    const extraVideoUrls = depthReferenceUrl ? [depthReferenceUrl] : originalUrl ? [originalUrl] : [];

    const values = { prompt: job.prompt, negative: job.negative, videoUrl, extraVideoUrls, imageUrls, audioUrls, quality: job.quality, duration: job.duration, aspect: job.aspect, fps: 25 };
    let body: Record<string, unknown>;
    if (miniMaxH3) body = miniMaxH3Body(values);
    else if (isContentListSchema(schema.document as never)) body = contentListBody(schema.document as never, values);
    else {
      const filled = fillBody(schema.document as never, values);
      if (filled.missing.length) throw new Error(`${model} needs inputs Mogfield does not provide yet: ${filled.missing.join(", ")}`);
      body = filled.body;
    }

    const makeDraft = !!job.draftPreview && model.includes("seedance-2-5") && isContentListSchema(schema.document as never);
    if (makeDraft) {
      body.draft = true;
      body.resolution = "480p";
    }
    // one line per submission so the server log shows exactly what was sent (no links)
    const items = Array.isArray(body.content) ? (body.content as { type?: string; role?: string }[]).map((c) => (c.role ? `${c.type}/${c.role}` : c.type)).join(", ") : Object.keys(body).join(", ");
    console.log(`submit ${model}: ${items} · resolution=${String(body.resolution ?? "-")} duration=${String(body.duration ?? "-")}${job.preparedVideoPath ? ` · prep audio=${prepAudio}` : ""}`);
    // the exact body next to the render, with the short-lived signed links swapped for the local files they came from
    const sources = new Map<string, string>();
    if (videoUrl) sources.set(videoUrl, primaryVideoPath);
    if (depthReferenceUrl && job.preparedDepthPath) sources.set(depthReferenceUrl, job.preparedDepthPath);
    if (originalUrl && job.originalPath) sources.set(originalUrl, job.originalPath);
    if (imageUrls[0] && job.sheetPath) sources.set(imageUrls[0], job.sheetPath);
    if (audioUrls[0] && job.preparedAudioPath) sources.set(audioUrls[0], job.preparedAudioPath.replace(/\.[^./]+$/, "") + ".pcm.wav");
    const requestPath = job.outPath.replace(/\.mp4$/i, "") + ".request.json";
    const readable = JSON.stringify({ model, body }, (_, v) => (typeof v === "string" && sources.has(v) ? `file:${sources.get(v)}` : v), 2);
    await writeFile(requestPath, readable).catch(() => {});
    console.log(`  request saved: ${requestPath}`);
    const data = await submitAndSave(model, body, job.outPath, hooks);
    if (makeDraft) {
      const id = draftTaskId(data);
      if (!id) throw new Error("Comfy created a draft without returning its task ID; the draft cannot be finalized.");
      return { draftTaskId: id };
    }
  },

  async finalizeDraft(job: FinalizeDraftJob, hooks: ProviderHooks) {
    if (!job.model.includes("seedance-2-5")) throw new Error("Only Seedance 2.5 drafts can be finalized this way.");
    if (!hasKey()) throw new Error("Comfy API key missing: add COMFY_API_KEY to app/.env and restart");
    const body = {
      content: [{ type: "draft_task", draft_task: { id: job.draftTaskId } }],
      resolution: "1080p",
    };
    await submitAndSave(job.model, body, job.outPath, hooks);
  },
};
