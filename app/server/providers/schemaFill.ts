// Fills a partner model's request body from its published OpenAPI schema,
// so the Comfy provider never hard-codes a model's field names. Fields are
// matched by name and type; anything required that we cannot fill is an
// error that names the field, instead of a silent bad request.

export interface FillValues {
  prompt: string;
  negative?: string;
  videoUrl?: string;
  /** More reference videos after videoUrl (content-list models only). */
  extraVideoUrls?: string[];
  imageUrls: string[];
  /** Reference audio clips (content-list models only). */
  audioUrls?: string[];
  quality?: string; // app resolution label, mapped to each model's API resolution
  duration?: number; // seconds
  aspect?: number; // width / height
  fps?: number;
}

type Schema = {
  $ref?: string;
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
};
type Doc = { paths?: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>>; components?: { schemas?: Record<string, Schema> } };

function resolve(doc: Doc, s: Schema | undefined, depth = 0): Schema | undefined {
  if (!s || depth > 8) return s;
  if (s.$ref) {
    const name = s.$ref.split("/").pop()!;
    return resolve(doc, doc.components?.schemas?.[name], depth + 1);
  }
  if (s.allOf?.length) {
    const merged: Schema = { type: "object", properties: {}, required: [] };
    for (const part of s.allOf) {
      const r = resolve(doc, part, depth + 1);
      Object.assign(merged.properties!, r?.properties ?? {});
      merged.required!.push(...(r?.required ?? []));
    }
    return merged;
  }
  const alt = s.anyOf ?? s.oneOf;
  if (alt?.length && !s.type) {
    // prefer the non-null branch
    return resolve(doc, alt.find((a) => (resolve(doc, a, depth + 1)?.type ?? "") !== "null") ?? alt[0], depth + 1);
  }
  return s;
}

/** The JSON request schema of the model's POST operation. */
export function requestSchema(doc: Doc): Schema | undefined {
  for (const ops of Object.values(doc.paths ?? {})) {
    const body = ops.post?.requestBody?.content?.["application/json"]?.schema;
    if (body) return resolve(doc, body);
  }
  return undefined;
}

const isStr = (s?: Schema) => s?.type === "string";
const isNum = (s?: Schema) => s?.type === "number" || s?.type === "integer";
const isStrArr = (doc: Doc, s?: Schema) => s?.type === "array" && isStr(resolve(doc, s.items));

function nearestEnum(values: unknown[], target: number, parse: (v: unknown) => number) {
  let best = values[0];
  let bestD = Infinity;
  for (const v of values) {
    const d = Math.abs(parse(v) - target);
    if (Number.isFinite(d) && d < bestD) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

const ratio = (v: unknown) => {
  const m = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/.exec(String(v));
  return m ? Number(m[1]) / Number(m[2]) : Number.NaN;
};
const pixels = (v: unknown) => {
  const m = /(\d{3,4})\s*p/i.exec(String(v));
  return m ? Number(m[1]) : Number.NaN;
};
const dimensions = (v: unknown) => {
  const m = /^(\d{3,4})\s*x\s*(\d{3,4})$/i.exec(String(v));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
};

function nearestResolution(values: unknown[], quality: string, aspect: number): unknown {
  const targetShortSide = pixels(quality);
  const candidates = values.flatMap((value) => {
    const size = dimensions(value);
    return size ? [{ value, size }] : [];
  });
  if (!candidates.length || !Number.isFinite(targetShortSide)) return nearestEnum(values, targetShortSide, pixels);
  const targetAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  let best = candidates[0].value;
  let bestDistance = Infinity;
  for (const { value, size } of candidates) {
    const shortSide = Math.min(size.width, size.height);
    const candidateAspect = size.width / size.height;
    const distance = Math.abs(Math.log(shortSide / targetShortSide)) + 2 * Math.abs(Math.log(candidateAspect / targetAspect));
    if (distance < bestDistance) {
      best = value;
      bestDistance = distance;
    }
  }
  return best;
}

function fillValue(doc: Doc, name: string, s: Schema, v: FillValues, used: Set<string>): unknown {
  const n = name.toLowerCase();
  if (n.includes("negative")) return isStr(s) && v.negative ? v.negative : undefined;
  if ((n === "prompt" || n === "text" || n.endsWith("_prompt") || n === "description") && isStr(s)) return v.prompt;
  if (n === "generate_audio" && s.type === "boolean") return !!v.audioUrls?.length;
  if (n === "fps" && isNum(s) && v.fps) return s.type === "integer" ? Math.round(v.fps) : v.fps;
  if (n.includes("video")) {
    if (!v.videoUrl) return undefined;
    if (isStr(s)) return v.videoUrl;
    if (isStrArr(doc, s)) return [v.videoUrl];
    return undefined;
  }
  if (n.includes("image")) {
    if (!v.imageUrls.length) return undefined;
    if (isStrArr(doc, s)) return v.imageUrls;
    if (isStr(s)) return v.imageUrls[0];
    return undefined;
  }
  if ((n.includes("resolution") || n === "quality") && v.quality) {
    if (s.enum?.length) return n.includes("resolution")
      ? nearestResolution(s.enum, v.quality, v.aspect ?? 16 / 9)
      : nearestEnum(s.enum, pixels(v.quality), pixels);
    if (isStr(s)) return v.quality;
    return undefined;
  }
  if ((n.includes("duration") || n === "seconds" || n === "length") && v.duration) {
    if (s.enum?.length) return nearestEnum(s.enum, v.duration, Number);
    if (isNum(s)) {
      let d = v.duration;
      if (s.minimum !== undefined) d = Math.max(s.minimum, d);
      if (s.maximum !== undefined) d = Math.min(s.maximum, d);
      return s.type === "integer" ? Math.round(d) : d;
    }
    if (isStr(s)) return String(Math.round(v.duration));
    return undefined;
  }
  if (n.includes("aspect") && v.aspect && s.enum?.length) return nearestEnum(s.enum, v.aspect, ratio);
  void used;
  return undefined;
}

export interface FillResult {
  body: Record<string, unknown>;
  missing: string[];
  filled: string[];
}

export function fillBody(doc: Doc, values: FillValues): FillResult {
  const root = requestSchema(doc);
  if (!root?.properties) throw new Error("model schema has no JSON request body");
  const missing: string[] = [];
  const filled: string[] = [];
  const walk = (s: Schema, path: string, depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(s.properties ?? {})) {
      const p = resolve(doc, raw);
      if (!p) continue;
      const full = path ? `${path}.${name}` : name;
      if (p.type === "object" && p.properties && depth < 3) {
        const inner = walk(p, full, depth + 1);
        if (Object.keys(inner).length) out[name] = inner;
        else if (s.required?.includes(name)) missing.push(full);
        continue;
      }
      const val = fillValue(doc, name, p, values, new Set());
      if (val !== undefined) {
        out[name] = val;
        filled.push(full);
      } else if (s.required?.includes(name)) {
        if (p.default !== undefined) out[name] = p.default;
        else missing.push(full);
      }
    }
    return out;
  };
  const body = walk(root, "", 0);
  return { body, missing, filled };
}

/** BytePlus (Seedance/Dreamina) takes a typed `content` list instead of
 *  named fields: one text item, then media items tagged with a role. */
export function isContentListSchema(doc: Doc): boolean {
  const root = requestSchema(doc);
  const content = resolve(doc, root?.properties?.content);
  const item = resolve(doc, content?.items);
  const type = resolve(doc, item?.properties?.type);
  return content?.type === "array" && !!type?.enum?.includes("video_url") && !!resolve(doc, item?.properties?.role)?.enum?.includes("reference_video");
}

/** Seedance's prompt with the references named in words, numbered in the order
 *  they are sent (the API has no tag syntax for references). */
export function seedanceText(v: Pick<FillValues, "prompt" | "negative" | "videoUrl" | "extraVideoUrls" | "imageUrls" | "audioUrls">): string {
  const videos = [v.videoUrl, ...(v.extraVideoUrls ?? [])].filter((u): u is string => !!u);
  const words = (t: string) =>
    t
      .replace(/@video(\d+)/g, (_, n) => (videos.length > 1 ? `reference video ${n}` : "the reference video"))
      .replace(/@image(\d+)/g, (_, n) => (v.imageUrls.length > 1 ? `reference image ${n}` : "the reference image"));
  // Seedance infers the task type from the prompt; an audio clip the prompt never
  // mentions can be read as an audio edit and fails the task, so say what it is for
  const audioLine = v.audioUrls?.length
    ? `\n\nThe reference audio is the main person's voice for this shot, in sync with ${videos.length ? "the reference video" : "the timeline"}: match their mouth and lip movements to it.`
    : "";
  return words(`${v.prompt}${audioLine}${v.negative ? `\n\nAvoid: ${v.negative}.` : ""}`);
}

/** The Seedance ratio nearest to a width/height aspect. */
export function nearestRatio(options: string[], aspect: number): string {
  return nearestEnum(options.filter((e) => e !== "adaptive"), aspect, ratio) as string;
}

export function contentListBody(doc: Doc, v: FillValues): Record<string, unknown> {
  const root = requestSchema(doc)!;
  const props = root.properties ?? {};
  const videos = [v.videoUrl, ...(v.extraVideoUrls ?? [])].filter((u): u is string => !!u);
  const text = seedanceText(v);
  const content: Record<string, unknown>[] = [{ type: "text", text }];
  for (const url of videos) content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
  for (const url of v.imageUrls) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  for (const url of v.audioUrls ?? []) content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
  const body: Record<string, unknown> = { content };
  const res = resolve(doc, props.resolution);
  if (res?.enum?.length && v.quality) body.resolution = nearestEnum(res.enum, pixels(v.quality), pixels);
  const ratioS = resolve(doc, props.ratio);
  if (ratioS?.enum?.length && v.aspect) body.ratio = nearestEnum(ratioS.enum.filter((e) => e !== "adaptive"), v.aspect, ratio);
  if (props.duration && v.duration) body.duration = Math.max(4, Math.floor(v.duration + 0.05)); // never longer than the reference video
  // a voice reference on a silent-output task is contradictory; the app swaps the original audio back in afterwards
  if (props.generate_audio) body.generate_audio = !!v.audioUrls?.length;
  if (props.watermark) body.watermark = false;
  return body;
}

/** MiniMax H3 uses a text/image content list plus a distinct ratio/resolution schema. */
export function miniMaxH3Body(v: FillValues): Record<string, unknown> {
  const ratios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
  const targetAspect = Number.isFinite(v.aspect) && (v.aspect ?? 0) > 0 ? v.aspect! : 16 / 9;
  const nearestRatio = ratios.reduce((best, candidate) =>
    Math.abs(Math.log(ratio(candidate) / targetAspect)) < Math.abs(Math.log(ratio(best) / targetAspect)) ? candidate : best,
  );
  const content: Record<string, unknown>[] = [{ type: "text", text: v.prompt.trim() }];
  for (const url of v.imageUrls) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  return {
    content,
    duration: Math.max(4, Math.min(15, Math.round(v.duration ?? 5))),
    ratio: nearestRatio,
    resolution: v.quality === "2K" || v.quality === "1080p" ? "2K" : "768P",
  };
}

/** Finds the generated video in a provider payload: a URL to an mp4/webm/mov. */
export function findVideoUrl(data: unknown): string | null {
  const seen = new Set<unknown>();
  let fallback: string | null = null;
  const visit = (x: unknown, key = ""): string | null => {
    if (x === null || x === undefined || seen.has(x)) return null;
    if (typeof x === "string") {
      if (/^https?:\/\//.test(x)) {
        if (/\.(mp4|webm|mov)(\?|$)/i.test(x)) return x;
        if (/video/i.test(key) && !fallback) fallback = x;
      }
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
  return visit(data) ?? fallback;
}
