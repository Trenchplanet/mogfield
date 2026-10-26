// The whole Comfy API catalog, sorted by what each model makes. Each model's
// published schema names its input and output media
// (x-comfy-router-input-modalities / -output-modalities); the schemas are
// cached in data/catalog.json by etag, so only new or changed models are read.
//
// runCatalogModel runs any video or image model in the catalog by filling its
// request from the schema (schemaFill.ts).

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Comfy, comfy } from "@comfyorg/sdk";
import { DATA_DIR } from "../config.js";
import { contentListBody, fillBody, findVideoUrl, isContentListSchema } from "./schemaFill.js";
import type { ProviderHooks } from "./types.js";

export type Media = "text" | "image" | "video" | "audio" | string;

export interface CatalogModel {
  id: string; // "kling/kling-v3"
  provider: string; // "kling"
  label: string; // "Kling V3"
  inputs: Media[];
  outputs: Media[];
  /** Why the Create forms cannot run it (it needs a source video, a mask…); absent when they can. */
  needs?: string;
}

const FILE = join(DATA_DIR, "catalog-v2.json");
type Cached = CatalogModel & { etag: string };
let cache = new Map<string, Cached>();
try {
  if (existsSync(FILE)) cache = new Map((JSON.parse(readFileSync(FILE, "utf8")) as Cached[]).map((m) => ({ ...m, label: labelOf(m.id) })).map((m) => [m.id, m]));
} catch {
  /* unreadable: read the schemas again */
}

const hasKey = () => !!process.env.COMFY_API_KEY?.trim();

const PROVIDERS: Record<string, string> = { higgsfield: "Higgsfield", runware: "Runware", wavespeed: "WaveSpeed", pruna: "Pruna", synclabs: "Sync", beeble: "Beeble",  bfl: "FLUX", byteplus: "BytePlus", bria: "Bria", moonvalley: "Moonvalley", kling: "Kling", veo: "Veo", wan: "Wan", pika: "Pika", luma: "Luma", luma_2: "Luma", runway: "Runway", xai: "Grok", veed: "Veed", heygen: "HeyGen", openai: "OpenAI", vertexai: "Google", fal: "fal", recraft: "Recraft", ideogram: "Ideogram", qwen: "Qwen", krea: "Krea" };
const WORDS: Record<string, string> = { ai: "AI", gpt: "GPT", ltx: "LTX", vto: "VTO", sfx: "SFX", r2v: "R2V", t2v: "T2V", i2v: "I2V", i2i: "I2I", t2i: "T2I", "3d": "3D" };
const KNOWN = /^(seedance|seedream|dreamina|flux|nano|gpt|gemini|grok|happyhorse|kling|wan|recraft|seed|veo|ray|photon|krea|ideogram|ltx|pika|moonvalley|fibo|bria|uni)/i;
/** Resellers of other makers' models: their name goes after the model's. */
const RESELLERS = new Set(["fal", "runware", "wavespeed", "higgsfield", "pika"]);

/** "veo/veo-3.1-fast-generate-001" → "Veo 3.1 Fast", "byteplus/dreamina-seedance-2-0-260128" → "Dreamina Seedance 2.0" */
export function labelOf(id: string): string {
  const [provider, model = provider] = id.split("/");
  const brand = PROVIDERS[provider] ?? provider[0].toUpperCase() + provider.slice(1);
  const parts = model.replace(new RegExp(`^${provider}[-_]`), "").split(/[-_]/).filter(Boolean);
  // drop release dates and API version tags: 260128, 001, generate
  while (parts.length > 1 && /^(\d{6}|0\d\d|generate)$/.test(parts[parts.length - 1])) parts.pop();
  const words: string[] = [];
  for (const w of parts.filter((w) => w !== "generate")) {
    const prev = words[words.length - 1];
    // "2", "0" → "2.0"
    if (/^\d$/.test(w) && prev && /^\d+(\.\d+)?$/.test(prev) && !prev.includes(".")) words[words.length - 1] = `${prev}.${w}`;
    else words.push(WORDS[w.toLowerCase()] ?? (/^v\d/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  }
  const name = words.join(" ");
  const branded = KNOWN.test(name) || name.toLowerCase().startsWith(brand.toLowerCase()) ? name : `${brand} ${name}`;
  return RESELLERS.has(provider) && !branded.toLowerCase().startsWith(brand.toLowerCase()) ? `${branded} · ${brand}` : branded;
}

function modalities(doc: unknown, key: string): Media[] {
  const m = new RegExp(`"x-comfy-router-${key}-modalities":(\\[[^\\]]*\\])`).exec(JSON.stringify(doc));
  try {
    return m ? (JSON.parse(m[1]) as Media[]) : [];
  } catch {
    return [];
  }
}

const loadedFromDisk = cache.size > 0;
let walking: Promise<void> | null = null;

/** A dry fill of the schema with a prompt and one picture: what is left over is what Create cannot give. */
function needsOf(id: string, doc: unknown): string | undefined {
  if (id.startsWith("vertexai/")) return undefined; // runs through geminiImage
  if (isContentListSchema(doc as never)) return undefined;
  try {
    const f = fillBody(doc as never, { prompt: "x", imageUrls: ["https://example.com/a.png"], quality: "720p", duration: 5, aspect: 16 / 9 });
    if (!f.missing.length) return undefined;
    const m = f.missing.join(" ").toLowerCase();
    return /video/.test(m) ? "Needs a source video" : /mask/.test(m) ? "Needs a mask" : /audio|lang|dub/.test(m) ? "Needs audio" : `Needs ${f.missing.join(", ")}`;
  } catch {
    return "Not a JSON request: not supported here";
  }
}
let readyAt = 0;

/** Reads the catalog and any schema whose etag changed. Runs in the background. */
function refresh(): Promise<void> {
  walking ??= (async () => {
    const listed: { id: string; schema_etag?: string }[] = [];
    for await (const m of comfy.models.list()) listed.push(m as { id: string; schema_etag?: string });
    const todo = listed.filter((m) => cache.get(m.id)?.etag !== (m.schema_etag ?? ""));
    // a few at a time: 260 schemas one by one take minutes
    let next = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < todo.length) {
          const m = todo[next++];
          try {
            const s = await comfy.models.schema(m.id);
            cache.set(m.id, { id: m.id, provider: m.id.split("/")[0], label: labelOf(m.id), inputs: modalities(s.document, "input"), outputs: modalities(s.document, "output"), needs: needsOf(m.id, s.document), etag: m.schema_etag ?? "" });
          } catch {
            /* skipped this round; tried again on the next refresh */
          }
        }
      }),
    );
    const ids = new Set(listed.map((m) => m.id));
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    readyAt = Date.now();
    await writeFile(FILE, JSON.stringify([...cache.values()], null, 1)).catch(() => {});
  })().finally(() => (walking = null));
  return walking;
}

/** Every catalog model that makes the given media. `ready` is false while the first read runs. */
export function catalogModels(output: "video" | "image"): { ready: boolean; models: CatalogModel[] } {
  if (!hasKey()) return { ready: true, models: [] };
  if (!walking && Date.now() - readyAt > 30 * 60_000) void refresh().catch((e) => console.error("comfy catalog:", (e as Error).message));
  const models = [...cache.values()]
    .filter((m) => m.outputs.includes(output) && m.inputs.includes("text"))
    .map(({ etag: _etag, ...m }) => m)
    .sort((a, b) => Number(!!a.needs) - Number(!!b.needs) || a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
  // the first read fills the list one schema at a time: not ready until it is whole
  return { ready: readyAt > 0 || (loadedFromDisk && cache.size > 0), models };
}

export function catalogModel(id: string): CatalogModel | undefined {
  const m = cache.get(id);
  return m && { id: m.id, provider: m.provider, label: m.label, inputs: m.inputs, outputs: m.outputs, needs: m.needs };
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

/** Finds the generated picture in a provider payload: a URL to an image, or base64 image data. */
export function findImage(data: unknown): { url: string } | { base64: string } | null {
  const seen = new Set<unknown>();
  let fallback: string | null = null;
  const visit = (x: unknown, key = ""): { url: string } | { base64: string } | null => {
    if (x === null || x === undefined || seen.has(x)) return null;
    if (typeof x === "string") {
      if (/^https?:\/\//.test(x)) {
        if (/\.(png|jpe?g|webp)(\?|$)/i.test(x)) return { url: x };
        if (/image|sample|url|output/i.test(key) && !fallback) fallback = x;
      } else if (/b64|base64|data/i.test(key) && x.length > 1000 && /^[A-Za-z0-9+/=\s]+$/.test(x.slice(0, 200))) return { base64: x };
      else if (x.startsWith("data:image/")) return { base64: x.slice(x.indexOf(",") + 1) };
      return null;
    }
    if (typeof x !== "object") return null;
    seen.add(x);
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      const r = visit(v, Array.isArray(x) ? key : k);
      if (r) return r;
    }
    return null;
  };
  return visit(data) ?? (fallback ? { url: fallback } : null);
}

/** Any catalog video or image model: the request is filled from its schema. */
export async function runCatalogModel(
  o: { model: string; output: "video" | "image"; prompt: string; imagePaths: string[]; quality: string; seconds?: number; aspect: number; audio?: boolean; outPath: string },
  hooks: Pick<ProviderHooks, "progress"> & { signal?: AbortSignal },
): Promise<void> {
  if (!hasKey()) throw new Error("Comfy API key missing: add COMFY_API_KEY to app/.env and restart");
  hooks.progress(0.05, "Reading model inputs");
  const schema = await comfy.models.schema(o.model);
  const doc = schema.document as never;
  const takesImages = modalities(doc, "input").includes("image");
  const images = takesImages ? o.imagePaths : [];
  hooks.progress(0.1, images.length ? "Uploading pictures" : "Sending the prompt");
  const cloud = cloudClient();
  const imageUrls: string[] = [];
  for (const path of images) imageUrls.push((await cloud.assets.fromFile(path).getDownloadUrl()).url);
  const values = { prompt: o.prompt, imageUrls, quality: o.quality, duration: o.seconds, aspect: o.aspect };
  let body: Record<string, unknown>;
  if (isContentListSchema(doc)) body = contentListBody(doc, values);
  else {
    const filled = fillBody(doc, values);
    if (filled.missing.length) throw new Error(`${labelOf(o.model)} needs ${filled.missing.join(", ")}, which this form does not fill. Pick another model.`);
    body = filled.body;
  }
  if ("generate_audio" in body || o.audio === false) body.generate_audio = o.audio !== false;
  console.log(`submit ${o.model} (${o.output}): ${Object.keys(body).join(", ")}`);
  await writeFile(o.outPath.replace(/\.[^.]+$/, "") + ".request.json", JSON.stringify({ model: o.model, body }, null, 2)).catch(() => {});

  hooks.progress(0.15, "Queued");
  const result = await comfy.models.subscribe(o.model, body, {
    signal: hooks.signal,
    timeoutMs: 20 * 60_000,
    onQueueUpdate: (u) => {
      const status = String(u.status);
      if (status === "IN_QUEUE") hooks.progress(0.15, u.queuePosition != null ? `In queue (#${u.queuePosition})` : "In queue");
      else if (status === "IN_PROGRESS") hooks.progress(0.5, "Generating");
    },
  });
  hooks.progress(0.9, "Downloading result");
  if (result.kind === "binary") {
    await writeFile(o.outPath, result.data);
    return;
  }
  const found = o.output === "video" ? ((u) => (u ? { url: u } : null))(findVideoUrl(result.data)) : findImage(result.data);
  if (!found) throw new Error(`${labelOf(o.model)} finished but returned no ${o.output}`);
  if ("base64" in found) {
    await writeFile(o.outPath, Buffer.from(found.base64, "base64"));
    return;
  }
  const res = await fetch(found.url, { signal: hooks.signal });
  if (!res.ok) throw new Error(`downloading the result failed: HTTP ${res.status}`);
  await writeFile(o.outPath, Buffer.from(await res.arrayBuffer()));
}
