// Pika H3 Flex and director mode stay wired as the templates were: every input
// shape builds a graph whose links resolve, with the settings and titles the
// server binds; a director project exports one graph per shot.

import assert from "node:assert/strict";
import { test } from "node:test";
import { projectGraph } from "./agent.js";
import { quantOf } from "./director.js";
import { framesGraph } from "./frames.js";
import type { AgentProject } from "./shared.js";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta: { title: string } }>;
const base = { model: "pika-h3" as const, prompt: "a fox runs through snow", quality: "768p", seconds: 7, aspect: 9 / 16, audio: true, seed: 1 };

function links(g: Graph) {
  for (const [id, n] of Object.entries(g))
    for (const [k, v] of Object.entries(n.inputs))
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string") assert.ok(g[v[0]], `${id}.${k} points at missing node ${v[0]}`);
}
const titled = (g: Graph, t: string) => Object.values(g).find((n) => n._meta.title === t);

test("Pika: the template's sampler, model and LoRA are kept", () => {
  const shapes: [string, { startFrame?: string; refs?: string[] }, string, string][] = [
    ["t2v", {}, "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "pika_h3_flex_fl2va_v1_bf16.safetensors"],
    ["fl2va", { startFrame: "/x/a.png" }, "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "pika_h3_flex_fl2va_v1_bf16.safetensors"],
    ["ref2va", { refs: ["/x/r.png"] }, "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "pika_h3_flex_ref2va_v1_bf16.safetensors"],
  ];
  for (const [shape, extra, unet, lora] of shapes) {
    const { graph } = framesGraph({ ...base, ...extra });
    links(graph);
    assert.equal(titled(graph, "BL:unet")?.inputs.unet_name, unet, shape);
    assert.deepEqual([titled(graph, "BL:lora")?.inputs.lora_name, titled(graph, "BL:lora")?.inputs.strength_model], [lora, 1], shape);
    const sigmas = Object.values(graph).find((n) => n.class_type === "ManualSigmas");
    assert.equal(sigmas?.inputs.sigmas, "1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0", shape);
    assert.equal(Object.values(graph).find((n) => n.class_type === "KSamplerSelect")?.inputs.sampler_name, "lcm", shape);
    const h3 = titled(graph, "BL:h3")!.inputs;
    assert.equal(h3.prompt, base.prompt);
    // 7 s at 24 fps on the 17n+5 grid, 0.98 MP in multiples of 32
    assert.deepEqual([h3.length, h3.width, h3.height], [175, 736, 1312], shape);
    assert.ok(titled(graph, "BL:output"), shape);
  }
});

test("Pika: frames, references and the take reach the right inputs", () => {
  const start = framesGraph({ ...base, startFrame: "/x/a.png" });
  assert.ok("first_frame" in titled(start.graph, "BL:h3")!.inputs);
  assert.ok(!("last_frame" in titled(start.graph, "BL:h3")!.inputs), "no end frame: its input is removed");
  const both = framesGraph({ ...base, startFrame: "/x/a.png", endFrame: "/x/b.png" });
  assert.deepEqual(both.files.map((f) => f.path), ["/x/a.png", "/x/b.png"]);

  const refs = framesGraph({ ...base, refs: ["/x/1.png", "/x/2.png", "/x/3.png"] });
  links(refs.graph);
  const h3 = titled(refs.graph, "BL:h3")!.inputs;
  assert.deepEqual(Object.keys(h3).filter((k) => k.startsWith("ref_images.")), ["ref_images.ref_image_0", "ref_images.ref_image_1", "ref_images.ref_image_2"]);

  // Re-shoot / swap / Genjutsu: the take as <Video 1> with its sound, at the take's own length
  const take = framesGraph({ ...base, seconds: 6.3, refs: ["/x/c.png"], refVideo: { path: "/x/take.mp4", audio: true } });
  links(take.graph);
  const t = titled(take.graph, "BL:h3")!.inputs;
  assert.equal(t.length, 158);
  assert.ok(Array.isArray(t["ref_videos.ref_video_0"]) && Array.isArray(t["ref_video_audios.ref_video_audio_0"]));
  assert.deepEqual(take.files.find((f) => f.field === "file")?.path, "/x/take.mp4");
});

test("Director: a project exports every shot's workflow, each on its key frame", () => {
  const shot = (id: string, seconds: number) => ({ id, title: id, size: "WS", angle: "eye level", movement: "static", lens: "35mm", lighting: "soft", seconds, action: "a", sound: "rain", framePrompt: "f", videoPrompt: `v ${id}`, cast: [] });
  const p = {
    id: "p1", title: "Test", stage: "board", messages: [], castIds: [], createdAt: 0, updatedAt: 0,
    board: { title: "T", logline: "", style: "noir", aspect: "16:9", model: "pika-h3", quality: "480p", audio: true, characters: [], shots: [shot("a", 5), shot("b", 8)] },
  } as AgentProject;
  const g = projectGraph(p) as Graph;
  links(g);
  const saves = Object.values(g).filter((n) => n.class_type === "SaveVideo").map((n) => n.inputs.filename_prefix);
  assert.deepEqual(saves, ["mogfield/p1/shot-1", "mogfield/p1/shot-2"]);
  const loads = Object.values(g).filter((n) => n.class_type === "LoadImage").map((n) => n.inputs.image);
  assert.deepEqual(loads, ["agent-p1-a.png", "agent-p1-b.png"]);
  assert.ok(Object.values(g).every((n) => /^Shot [12] · /.test(n._meta.title)));
});

test("Director: quantizations are read from GGUF file names", () => {
  assert.equal(quantOf("gemma-4-12b-it-qat-q4_0.gguf"), "Q4_0");
  assert.equal(quantOf("Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf"), "Q4_K_P");
  assert.equal(quantOf("DeepSeek-V4.1-Flash-1017-GSQ-RCO-IQ1_M-00002-of-00004.gguf"), "IQ1_M");
  assert.equal(quantOf("README.md"), undefined);
});
