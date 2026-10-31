// Pika H3 Flex: Pika's post-trained adapter (LoRA) for MiniMax H3, open
// weights, run as the ComfyUI workflows from the official templates:
//
//   workflows/backlot_pika_h3_t2v.json     the prompt alone
//   workflows/backlot_pika_h3_fl2va.json   a start frame, optionally an end frame
//   workflows/backlot_pika_h3_ref2va.json  up to 9 reference pictures
//
// It runs on Comfy Cloud or your own ComfyUI like every other workflow; the
// model files listed in workflows/README.md must be installed on that target.
// H3 always makes sound with the picture.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { findByTitle, workflowPath } from "./engines/comfy.js";
import { h3Frames, h3Size } from "./providers/h3Cloud.js";

type Node = { class_type: string; inputs: Record<string, unknown>; _meta: { title: string } };

/** MiniMaxH3ReferenceToVideo takes up to 9 reference images. */
export const PIKA_MAX_REFS = 9;

export function pikaGraph(i: {
  prompt: string;
  seconds: number;
  /** width / height */
  aspect: number;
  quality: string;
  seed?: number;
  startFrame?: string;
  endFrame?: string;
  /** reference pictures, used when there is no start frame */
  refs?: string[];
}): { graph: Record<string, Node>; outId: string; files: { id: string; path: string }[] } {
  const refs = i.startFrame ? [] : (i.refs ?? []).slice(0, PIKA_MAX_REFS);
  const kind = i.startFrame ? "fl2va" : refs.length ? "ref2va" : "t2v";
  const name = `backlot_pika_h3_${kind}`;
  const graph = JSON.parse(readFileSync(workflowPath(name), "utf8")) as Record<string, Node>;
  const one = (title: string) => {
    const id = findByTitle(graph, title)[0];
    if (!id) throw new Error(`workflows/${name}.json is missing the node titled ${title}`);
    return id;
  };
  const files: { id: string; path: string }[] = [];
  const h3 = graph[one("BL:h3")].inputs;
  Object.assign(h3, { prompt: i.prompt, length: h3Frames(Math.min(15, i.seconds)), ...h3Size(i.aspect, i.quality) });
  graph[one("BL:seed")].inputs.noise_seed = i.seed ?? Math.floor(Math.random() * 2 ** 31);

  const image = (id: string, path: string) => {
    graph[id].inputs.image = basename(path);
    files.push({ id, path });
  };
  if (kind === "fl2va") {
    image(one("BL:start-frame"), i.startFrame!);
    const end = one("BL:end-frame");
    if (i.endFrame) image(end, i.endFrame);
    else {
      delete graph[end];
      delete h3.last_frame;
    }
  } else if (kind === "ref2va") {
    // the template wires two pictures; keep the first as the pattern for the rest
    const first = one("BL:cast");
    delete graph[one("BL:cast-2")];
    for (const k of Object.keys(h3)) if (k.startsWith("ref_images.")) delete h3[k];
    let next = Math.max(...Object.keys(graph).map(Number)) + 1;
    refs.forEach((path, k) => {
      const id = k === 0 ? first : String(next++);
      if (k > 0) graph[id] = { class_type: "LoadImage", inputs: {}, _meta: { title: `BL:cast-${k + 1}` } };
      image(id, path);
      h3[`ref_images.ref_image_${k}`] = [id, 0];
    });
  }
  return { graph, outId: one("BL:output"), files };
}
