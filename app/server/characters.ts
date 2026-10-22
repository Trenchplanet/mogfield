// Character maker: one photo in, a clean character reference sheet out,
// made by Nano Banana 2.1 (Gemini image) through the Comfy API.
//
// The sheet is what Recast hands the video model as its reference.

import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { comfy } from "@comfyorg/sdk";

export const SHEET_MODEL = process.env.MOGFIELD_SHEET_MODEL?.trim() || "vertexai/gemini-nano-banana-2.1";
export type SheetSize = "1K" | "2K";

export const SHEET_PROMPT = `Use the attached image only as a non-identifying appearance reference for an original fictional character; do not reproduce a real person's identity or celebrity likeness.

Character design reference sheet of an original fictional character. Professional multi-view model sheet layout on clean white background.

Include: full-body front view, full-body 3/4 view, full-body side profile, close-up face front, close-up face 3/4, and close-up face side.

Same exact character across every panel with perfect consistency in face, hair, skin tone, outfit, and proportions. Neutral expression, studio lighting, highly detailed, sharp focus.

Create photorealistic quality, like an iPhone photo: real skin texture with pores and fine detail, natural imperfections, true-to-life lighting and colors. No plastic, waxy, airbrushed, CGI or 3D-render look.

Faces are shown clean: no overlays, meshes, grids or markings on any panel.

Top of the sheet has a bold white banner with black text: "ORIGINAL CHARACTER REFERENCE SHEET - FICTIONAL DESIGN".

Clean professional character design board style, technical layout, no real person, no celebrity likeness, pure original fictional character.`;

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

type Part = { text?: string; inlineData?: { mimeType: string; data: string }; fileData?: { fileUri: string } };

/** One Nano Banana call: images + instruction in, one image written to outPath. */
async function nanoBanana(images: string[], text: string, aspectRatio: string, size: SheetSize, outPath: string, signal?: AbortSignal): Promise<void> {
  if (!process.env.COMFY_API_KEY?.trim()) throw new Error("The character studio needs COMFY_API_KEY in app/.env");
  const parts: Part[] = [];
  for (const path of images) parts.push({ inlineData: { mimeType: MIME[extname(path).toLowerCase()] ?? "image/png", data: (await readFile(path)).toString("base64") } });
  parts.push({ text });
  const result = await comfy.models.run(
    SHEET_MODEL,
    { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio, imageSize: size } } },
    { signal },
  );
  if (result.kind === "binary") {
    await writeFile(outPath, result.data);
    return;
  }
  const res = result.data as { candidates?: { content?: { parts?: Part[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
  if (res.promptFeedback?.blockReason) throw new Error(`The image model declined this picture (${res.promptFeedback.blockReason}).`);
  const out = res.candidates?.flatMap((c) => c.content?.parts ?? []) ?? [];
  const image = out.find((p) => p.inlineData?.data);
  if (image?.inlineData) {
    await writeFile(outPath, Buffer.from(image.inlineData.data, "base64"));
    return;
  }
  const url = out.find((p) => p.fileData?.fileUri)?.fileData?.fileUri;
  if (url) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`downloading the image failed: HTTP ${r.status}`);
    await writeFile(outPath, Buffer.from(await r.arrayBuffer()));
    return;
  }
  const said = out.map((p) => p.text).filter(Boolean).join(" ").slice(0, 200);
  throw new Error(`No image came back${res.candidates?.[0]?.finishReason ? ` (${res.candidates[0].finishReason})` : ""}${said ? `: ${said}` : ""}`);
}

export function makeCharacterSheet(photoPath: string, outPath: string, size: SheetSize = "2K", signal?: AbortSignal): Promise<void> {
  return nanoBanana([photoPath], SHEET_PROMPT, "16:9", size, outPath, signal);
}

const RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "4:5", "5:4"];
/** FLUX 3 on the Comfy API: the cast/set card when no ComfyUI of your own runs the
 *  open-weights FLUX 3 Image Klein workflow (Comfy Cloud has no Klein files). */
export const CAST_MODEL = process.env.MOGFIELD_CAST_MODEL?.trim() || "bfl/flux-3-image";

export async function fluxCard(prompt: string, outPath: string, aspectRatio = "3:4", signal?: AbortSignal): Promise<void> {
  if (!process.env.COMFY_API_KEY?.trim()) throw new Error("Character cards need COMFY_API_KEY in app/.env");
  // grounding off: an original character or set, not a web lookup
  const result = await comfy.models.run(CAST_MODEL, { prompt, aspect_ratio: aspectRatio, resolution: "1k", grounding: false }, { signal });
  if (result.kind === "binary") {
    await writeFile(outPath, result.data);
    return;
  }
  const url = (result.data as { result?: { sample?: string } }).result?.sample;
  if (!url) throw new Error(`${CAST_MODEL} returned no image`);
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`downloading the card failed: HTTP ${r.status}`);
  await writeFile(outPath, Buffer.from(await r.arrayBuffer()));
}

/** The image model's aspect ratio closest to width / height. */
export function nearestRatio(aspect: number) {
  const value = (r: string) => { const [w, h] = r.split(":").map(Number); return w / h; };
  return RATIOS.reduce((best, r) => (Math.abs(Math.log(value(r) / aspect)) < Math.abs(Math.log(value(best) / aspect)) ? r : best), "1:1");
}

/** Character studio: the photo with the chosen elements added; everything else stays. */
export function editCharacterPhoto(o: { photoPath: string; elements: string[]; note?: string; refPaths: string[]; aspect: number; outPath: string; signal?: AbortSignal }): Promise<void> {
  const refs = o.refPaths.length
    ? `\nThe ${o.refPaths.length > 1 ? `next ${o.refPaths.length} images are` : "second image is"} reference${o.refPaths.length > 1 ? "s" : ""} for the elements to add: copy their design, shape and colors onto the character.`
    : "";
  const list = [...o.elements, ...(o.note?.trim() ? [o.note.trim()] : [])].map((e) => `- ${e}`).join("\n");
  const text = `Edit the first image. Keep the same character: same face, expression, pose, body, framing, background and lighting. Add or change only the following:
${list}${refs}
Blend every change in naturally, with matching lighting, perspective and photo quality, so it looks like one untouched photo. Create photorealistic quality, like an iPhone photo: real skin texture with pores, natural imperfections and true-to-life lighting; no plastic, waxy, airbrushed or CGI look (unless a restyle above asks for one). Keep the whole character in frame. No text, labels or borders.`;
  return nanoBanana([o.photoPath, ...o.refPaths], text, nearestRatio(o.aspect), "2K", o.outPath, o.signal);
}
