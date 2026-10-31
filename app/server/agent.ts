// Agent mode (experimental): tell a director what you want to make. It answers
// in film language, asks what it needs to know, writes a storyboard and waits
// for approval at every paid step: storyboard -> key frames -> shots -> film.
//
// The director is Claude through the Comfy model router, on the same Comfy API
// key as everything else. Key frames are Nano Banana 2.1 with the cast as
// references; shots are the Video > Create workflow started on each frame.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { OwnedMap, onPurged } from "./scope.js";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Hono } from "hono";
import { comfy } from "@comfyorg/sdk";
import { storyboardFrame } from "./characters.js";
import { DATA_DIR, RENDER_DIR } from "./config.js";
import { concatShots } from "./media.js";
import {
  AGENT_FRAME_USD, FRAME_MODELS, T2V_ASPECTS, frameModelUsd, snapSeconds,
  type AgentBoard, type AgentProject, type AgentShot, type FrameModel, type T2vAspect,
} from "./shared.js";
import { listTakes, startFramesTake } from "./t2v.js";

export const AGENT_MODEL = process.env.MOGFIELD_AGENT_MODEL?.trim() || "anthropic/claude-sonnet-5-5";
const FILE = join(DATA_DIR, "agent.json");
const MAX_SHOTS = 12;

type CastLookup = (id: string) => { path: string; prompt: string } | undefined;

const projects = new OwnedMap<AgentProject>();
(() => {
  if (!existsSync(FILE)) return;
  try {
    for (const p of JSON.parse(readFileSync(FILE, "utf8")) as AgentProject[]) {
      // work that was running when the server stopped will not finish
      p.thinking = false;
      for (const s of p.board?.shots ?? []) if (s.frame?.status === "running") s.frame = { status: "failed", error: "Interrupted by a server restart" };
      if (p.film?.status === "running") p.film = { status: "failed", error: "Interrupted by a server restart" };
      for (const s of p.board?.shots ?? []) s.queued = false;
      projects.set(p.id, p);
    }
  } catch {
    /* unreadable: start empty */
  }
})();
const save = () => writeFile(FILE, JSON.stringify(projects.all(), null, 2)).catch(() => {});
onPurged(() => void save());
const touch = (p: AgentProject) => {
  p.updatedAt = Date.now();
  void save();
};

/* ------------------------------------------------------------------ the director */

const MODEL_NOTES = (Object.keys(FRAME_MODELS) as FrameModel[])
  .map((id) => {
    const m = FRAME_MODELS[id];
    const price = id === "pika-h3" ? "open weights on the user's own ComfyUI (LOCAL only), no per-clip price" : `about $${frameModelUsd(id, m.qualities[0], 5).toFixed(2)} for 5 s at ${m.qualities[0]}`;
    return `- "${id}": ${m.label}, ${m.min}-${m.max} s, qualities ${m.qualities.join("/")}, ${price}`;
  })
  .join("\n");

const SYSTEM = `You are the director and cinematographer inside MOGFIELD, an open-source AI film studio that runs on ComfyUI. The user tells you what they want to make; you turn it into a shot-by-shot storyboard that MOGFIELD will draw as key frames and then film, one video clip per shot, cut together in order.

You think and speak like a working film director and DP:
- Shot sizes: EWS, WS, MWS, MS, MCU, CU, ECU, insert. Coverage: establishing shot, master, over-the-shoulder, reverse, two-shot, cutaway, insert, POV.
- Angles: eye level, low angle, high angle, overhead / bird's-eye, worm's-eye, Dutch tilt.
- Movement: static, push in, pull out, pan, tilt, dolly, truck, tracking, crane / jib, handheld, Steadicam, orbit, whip pan, rack focus, dolly zoom.
- Lenses: 14-24mm wide, 35mm, 50mm normal, 85mm portrait, 135mm+ telephoto, anamorphic, macro; shallow vs deep depth of field.
- Light: key / fill / back light, motivated light, practicals, golden hour, blue hour, high-key, low-key, chiaroscuro, rim light, silhouette, neon, overcast soft light.
- Composition and grammar: rule of thirds, leading lines, symmetry, negative space, headroom, the 180-degree rule, eyeline match, match cut, smash cut, J / L cut, montage, pacing.
- Look: colour palette, grade, film stock and grain, era, genre references.
Use these terms naturally and briefly explain one when it helps the user.

How a conversation goes:
1. If the idea is too thin to storyboard (no subject, no feeling, no length or format), ask at most 3 short, concrete questions and offer sensible defaults. Never ask more than one round of questions: if the user says "you decide" or answers, write the storyboard.
2. Otherwise write the storyboard right away. Usually 3-6 shots; at most ${MAX_SHOTS}. Total length about what the user asked for (default 15-25 s).
3. When the user asks for changes, return the whole updated storyboard. Keep shots that did not change exactly as they were (same text), so their approved frames are kept.
4. You never generate anything yourself. MOGFIELD asks the user to approve the storyboard, then the key frames, then the filming, each with its price. Tell the user what the next approval is.

Writing the prompts:
- "framePrompt" is one still image: subject, action frozen mid-moment, setting, composition, shot size, angle, lens, light, colour. Present tense, 40-90 words, no camera movement words.
- "videoPrompt" is what happens in that shot from that first frame: the action and performance over the shot's seconds, the camera movement, and how the shot ends. 40-90 words.
- Every shot must END CLEANLY, ready for the cut: the action completes inside the shot and the last second is a settled frame with the subjects still in shot. Never end on a whip pan, a tilt up to the sky, the camera leaving the subject, an empty frame, smoke filling the screen or a character walking out. Plan each ending so it cuts naturally into the next shot (eyeline, direction of movement, match on action).
- Give action shots enough time: 4-6 s for a shot with real action, 3 s only for a quick insert.
- Repeat each character's look (face, hair, age, wardrobe) word for word in every prompt they appear in, and repeat the style, so every shot looks like the same film.
- Real people: only by the user's own pictures (the cast). Never name or imitate celebrities. No logos, no on-screen text unless asked.

Video models (pick one for the whole film; default "seedance-2-0-fast" at 480p for a cheap first cut unless the user wants quality; "pika-h3" only runs when the user's ComfyUI is set to LOCAL; every shot's seconds must fit the model):
${MODEL_NOTES}
Aspect ratios: ${Object.keys(T2V_ASPECTS).join(", ")} (default 9:16 for social, 16:9 or 21:9 for cinematic).

Answer with ONE JSON object and nothing else:
{
  "reply": "what you say to the user: short, warm, in plain words, 1-5 sentences",
  "questions": ["only when you need answers before storyboarding"],
  "storyboard": null or {
    "title": "...", "logline": "one sentence", "style": "the look in one sentence, repeated in prompts",
    "aspect": "9:16", "model": "seedance-2-0-fast", "quality": "480p", "audio": true,
    "characters": [{ "name": "...", "look": "face, hair, age, wardrobe", "cast": 1 }],
    "shots": [{ "title": "...", "size": "WS", "angle": "eye level", "movement": "slow push in", "lens": "35mm", "lighting": "...", "seconds": 5, "action": "...", "sound": "...", "framePrompt": "...", "videoPrompt": "...", "cast": [1] }]
  }
}
"cast" numbers point at the user's attached cast pictures (1 = the first); leave them out when no pictures are attached. Return "storyboard": null while you are only asking questions or chatting.`;

type DirectorAnswer = { reply?: string; questions?: unknown; storyboard?: unknown };

function parseAnswer(text: string): DirectorAnswer {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return { reply: text.trim() };
  try {
    return JSON.parse(text.slice(a, b + 1)) as DirectorAnswer;
  } catch {
    return { reply: text.slice(0, a).trim() || "I lost my notes there. Could you say that again?" };
  }
}

const str = (v: unknown, max = 600) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The director's storyboard, made safe: known model, lengths the model can make, at most 12 shots; unchanged shots keep their frames. */
function cleanBoard(raw: unknown, castIds: string[], prev?: AgentBoard): AgentBoard | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const model: FrameModel = typeof r.model === "string" && r.model in FRAME_MODELS ? (r.model as FrameModel) : prev?.model ?? "seedance-2-0-fast";
  const m = FRAME_MODELS[model];
  const quality = typeof r.quality === "string" && m.qualities.includes(r.quality) ? r.quality : m.qualities[0];
  const aspect: T2vAspect = typeof r.aspect === "string" && r.aspect in T2V_ASPECTS ? (r.aspect as T2vAspect) : prev?.aspect ?? "9:16";
  const cast = (v: unknown) => (Array.isArray(v) ? v.map((n) => castIds[Number(n) - 1]).filter((x): x is string => !!x) : []);
  const shots: AgentShot[] = (Array.isArray(r.shots) ? r.shots : []).slice(0, MAX_SHOTS).map((x) => {
    const s = (x ?? {}) as Record<string, unknown>;
    const shot: AgentShot = {
      id: randomUUID().slice(0, 8),
      title: str(s.title, 80) || "Shot",
      size: str(s.size, 40), angle: str(s.angle, 60), movement: str(s.movement, 80), lens: str(s.lens, 40), lighting: str(s.lighting, 160),
      seconds: snapSeconds(model, Math.min(m.max, Math.max(m.min, Number(s.seconds) || 5))),
      action: str(s.action), sound: str(s.sound, 200),
      framePrompt: str(s.framePrompt, 1200), videoPrompt: str(s.videoPrompt, 1200),
      cast: cast(s.cast),
    };
    // the same picture as before keeps its frame (and its approval)
    const same = prev?.shots.find((p) => p.framePrompt === shot.framePrompt && p.cast.join() === shot.cast.join());
    if (same) Object.assign(shot, { id: same.id, frame: same.frame, frameApproved: same.frameApproved, takeId: same.videoPrompt === shot.videoPrompt && same.seconds === shot.seconds ? same.takeId : undefined });
    return shot;
  });
  if (!shots.length) return undefined;
  const characters = (Array.isArray(r.characters) ? r.characters : []).slice(0, 12).map((x) => {
    const c = (x ?? {}) as Record<string, unknown>;
    return { name: str(c.name, 60), look: str(c.look, 400), castId: cast([c.cast])[0] };
  });
  return {
    title: str(r.title, 80) || "Untitled", logline: str(r.logline, 300), style: str(r.style, 400),
    aspect, model, quality, audio: r.audio !== false, characters, shots,
  };
}

async function direct(p: AgentProject, lookup: CastLookup) {
  const cast = p.castIds.map((id, i) => `${i + 1}. ${lookup(id)?.prompt ?? "a picture"}`).join("\n");
  const context = [
    p.castIds.length ? `Attached cast pictures:\n${cast}` : "No cast pictures attached.",
    p.board ? `Current storyboard (JSON):\n${JSON.stringify({ ...p.board, shots: p.board.shots.map(({ frame, frameApproved, takeId, id, ...s }) => ({ ...s, cast: s.cast.map((c) => p.castIds.indexOf(c) + 1) })) })}` : "No storyboard yet.",
    `Stage: ${p.stage}.`,
  ].join("\n\n");
  // the conversation so far, with the state of the project on the latest turn
  const messages = p.messages.slice(-24).map((m, i, all) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: i === all.length - 1 && m.role === "user" ? `${context}\n\n---\n\n${m.text}` : m.text,
  }));
  const res = await comfy.models.run(AGENT_MODEL, { max_tokens: 24000, system: SYSTEM, messages });
  const data = res.data as { content?: { type: string; text?: string }[]; stop_reason?: string };
  if (data.stop_reason === "max_tokens") throw new Error("the storyboard ran too long to finish; ask for fewer shots or shorter prompts");
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const answer = parseAnswer(text);
  const board = cleanBoard(answer.storyboard, p.castIds, p.board);
  if (board) {
    p.board = board;
    p.title = board.title;
    // a changed storyboard goes back for approval; drawn frames that still match are kept
    p.stage = "board";
    p.film = undefined;
  }
  p.messages.push({
    role: "agent",
    text: str(answer.reply, 4000) || (board ? "Here is the storyboard." : "Tell me more about what you want to make."),
    questions: Array.isArray(answer.questions) ? answer.questions.filter((q): q is string => typeof q === "string").slice(0, 3) : undefined,
    at: Date.now(),
  });
}

/* ------------------------------------------------------------------ frames, shots, film */

function framePrompt(b: AgentBoard, s: AgentShot): string {
  const people = b.characters.filter((c) => c.look && (s.framePrompt.includes(c.name) || s.cast.includes(c.castId ?? "-"))).map((c) => `${c.name}: ${c.look}.`).join(" ");
  return [s.framePrompt, `${s.size} shot, ${s.angle}, ${s.lens} lens. ${s.lighting}.`, people, `Look: ${b.style}`].filter(Boolean).join(" ");
}

function videoPrompt(b: AgentBoard, s: AgentShot): string {
  return [s.videoPrompt, `Camera: ${s.movement}, ${s.size}, ${s.lens}.`, s.lighting && `Light: ${s.lighting}.`, s.sound && b.audio ? `Sound: ${s.sound}.` : "", `Style: ${b.style}`, "One continuous shot, no cuts, no on-screen text."]
    .filter(Boolean)
    .join(" ");
}

const framePath = (p: AgentProject, s: AgentShot) => join(RENDER_DIR, `agent-${p.id}-${s.id}.png`);

async function drawFrames(p: AgentProject, ids: string[], lookup: CastLookup) {
  const b = p.board!;
  const todo = b.shots.filter((s) => ids.includes(s.id));
  for (const s of todo) {
    s.frame = { status: "running" };
    s.frameApproved = false;
    s.takeId = undefined;
  }
  touch(p);
  // three at a time
  const queue = [...todo];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const shot = s;
      const refs = (shot.cast.length ? shot.cast : b.characters.map((c) => c.castId).filter((x): x is string => !!x)).map((id) => lookup(id)?.path).filter((x): x is string => !!x).slice(0, 10);
      const out = framePath(p, shot);
      try {
        await storyboardFrame({ prompt: framePrompt(b, shot), refPaths: refs, aspect: T2V_ASPECTS[b.aspect], outPath: out });
        shot.frame = { status: "succeeded", url: `/media/renders/${basename(out)}?v=${Date.now()}` };
      } catch (e) {
        shot.frame = { status: "failed", error: (e as Error).message.slice(0, 300) };
      }
      touch(p);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

/** Comfy runs a handful of partner jobs at once per account: shots wait their turn, four at a time. */
const FILM_SLOTS = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function filmShots(p: AgentProject, ids: string[]) {
  const b = p.board!;
  const todo = b.shots.filter((x) => ids.includes(x.id));
  for (const s of todo) Object.assign(s, { takeId: undefined, queued: true });
  p.film = undefined;
  touch(p);
  const worker = async () => {
    for (let s = todo.shift(); s; s = todo.shift()) {
      const take = startFramesTake({
        prompt: videoPrompt(b, s), model: b.model, quality: b.quality, seconds: s.seconds, aspect: b.aspect, audio: b.audio,
        start: { id: `agent-${s.id}`, path: framePath(p, s) },
      });
      Object.assign(s, { takeId: take.id, queued: false });
      touch(p);
      while (take.status === "running" || take.status === "queued") await sleep(3000);
    }
  };
  void Promise.all(Array.from({ length: FILM_SLOTS }, worker));
}

/** The shots' takes as they stand; when all are done, cut them together once. */
function withTakes(p: AgentProject) {
  const takes = new Map(listTakes().map((t) => [t.id, t]));
  const shots = (p.board?.shots ?? []).map((s) => {
    const t = s.takeId ? takes.get(s.takeId) : undefined;
    if (!t && s.queued) return { ...s, take: { status: "queued" as const, progress: 0, message: "Waiting for a free slot" } };
    return { ...s, take: t && { status: t.status, progress: t.progress, message: t.message, url: t.url, error: t.error } };
  });
  if (p.stage === "shots" && !p.film && shots.length && shots.every((s) => s.take?.status === "succeeded")) {
    const out = join(RENDER_DIR, `agent-${p.id}-film.mp4`);
    p.film = { status: "running" };
    touch(p);
    concatShots(shots.map((s) => join(RENDER_DIR, basename(s.take!.url!))), out)
      .then(() => {
        p.film = { status: "succeeded", url: `/media/renders/${basename(out)}?v=${Date.now()}` };
        p.stage = "film";
      })
      .catch((e) => (p.film = { status: "failed", error: (e as Error).message.slice(0, 300) }))
      .finally(() => touch(p));
  }
  return { ...p, board: p.board && { ...p.board, shots } };
}

/** What the next approval costs. */
function quote(p: AgentProject) {
  const b = p.board;
  if (!b) return { frames: 0, shots: 0 };
  return {
    frames: b.shots.filter((s) => s.frame?.status !== "succeeded").length * AGENT_FRAME_USD,
    shots: b.shots.reduce((sum, s) => sum + frameModelUsd(b.model, b.quality, s.seconds), 0),
  };
}

/* ------------------------------------------------------------------ routes */

export function agentRoutes(app: Hono, lookup: CastLookup) {
  const view = (p: AgentProject) => ({ ...withTakes(p), quote: quote(p), director: AGENT_MODEL });
  const need = (id: string) => projects.get(id);
  const hasKey = () => !!process.env.COMFY_API_KEY?.trim();

  app.get("/api/agent", (c) => c.json([...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((p) => ({ id: p.id, title: p.title, stage: p.stage, updatedAt: p.updatedAt, thumb: p.board?.shots.find((s) => s.frame?.url)?.frame?.url }))));

  app.post("/api/agent", async (c) => {
    const now = Date.now();
    const p: AgentProject = { id: randomUUID().slice(0, 8), title: "New film", stage: "brief", messages: [], castIds: [], createdAt: now, updatedAt: now };
    projects.set(p.id, p);
    touch(p);
    return c.json(view(p));
  });

  app.get("/api/agent/:id", (c) => {
    const p = need(c.req.param("id"));
    return p ? c.json(view(p)) : c.json({ error: "no such project" }, 404);
  });

  app.delete("/api/agent/:id", (c) => {
    projects.delete(c.req.param("id"));
    void save();
    return c.json({ ok: true });
  });

  // talk to the director; it answers in the background, the client polls the project
  app.post("/api/agent/:id/message", async (c) => {
    const p = need(c.req.param("id"));
    if (!p) return c.json({ error: "no such project" }, 404);
    if (!hasKey()) return c.json({ error: "Agent mode needs COMFY_API_KEY in app/.env" }, 400);
    if (p.thinking) return c.json({ error: "The director is still answering" }, 409);
    const b = (await c.req.json().catch(() => ({}))) as { text?: unknown; castIds?: unknown };
    const text = str(b.text, 4000);
    if (!text) return c.json({ error: "say what you want to make" }, 400);
    if (Array.isArray(b.castIds)) p.castIds = b.castIds.filter((x): x is string => typeof x === "string" && !!lookup(x)).slice(0, 12);
    p.messages.push({ role: "user", text, at: Date.now() });
    p.thinking = true;
    touch(p);
    void direct(p, lookup)
      .catch((e) => p.messages.push({ role: "agent", text: `I couldn't reach the director model: ${(e as Error).message.slice(0, 200)}`, at: Date.now() }))
      .finally(() => {
        p.thinking = false;
        touch(p);
      });
    return c.json(view(p));
  });

  // the user's own edits: model, quality, shape, sound, and a shot's length or prompts
  app.patch("/api/agent/:id/board", async (c) => {
    const p = need(c.req.param("id"));
    if (!p?.board) return c.json({ error: "no storyboard yet" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { model?: unknown; quality?: unknown; aspect?: unknown; audio?: unknown; shot?: { id?: unknown; seconds?: unknown; videoPrompt?: unknown; framePrompt?: unknown } };
    const board = p.board;
    if (typeof b.model === "string" && b.model in FRAME_MODELS) {
      board.model = b.model as FrameModel;
      const m = FRAME_MODELS[board.model];
      if (!m.qualities.includes(board.quality)) board.quality = m.qualities[0];
      for (const s of board.shots) s.seconds = snapSeconds(board.model, Math.min(m.max, Math.max(m.min, s.seconds)));
    }
    if (typeof b.quality === "string" && FRAME_MODELS[board.model].qualities.includes(b.quality)) board.quality = b.quality;
    if (typeof b.aspect === "string" && b.aspect in T2V_ASPECTS && b.aspect !== board.aspect) {
      board.aspect = b.aspect as T2vAspect;
      // a new shape needs new frames
      for (const s of board.shots) Object.assign(s, { frame: undefined, frameApproved: false, takeId: undefined });
      if (p.stage !== "brief") p.stage = "board";
    }
    if (typeof b.audio === "boolean") board.audio = b.audio;
    const s = board.shots.find((x) => x.id === b.shot?.id);
    if (s && b.shot) {
      if (typeof b.shot.seconds === "number") s.seconds = snapSeconds(board.model, Math.min(FRAME_MODELS[board.model].max, Math.max(FRAME_MODELS[board.model].min, b.shot.seconds)));
      if (typeof b.shot.videoPrompt === "string") s.videoPrompt = b.shot.videoPrompt.slice(0, 1200);
      if (typeof b.shot.framePrompt === "string" && b.shot.framePrompt !== s.framePrompt) Object.assign(s, { framePrompt: b.shot.framePrompt.slice(0, 1200), frame: undefined, frameApproved: false });
      s.takeId = undefined;
    }
    touch(p);
    return c.json(view(p));
  });

  // approval 1: the storyboard -> draw the key frames (all missing ones, or the shots asked for)
  app.post("/api/agent/:id/frames", async (c) => {
    const p = need(c.req.param("id"));
    if (!p?.board) return c.json({ error: "no storyboard yet" }, 404);
    if (!hasKey()) return c.json({ error: "Agent mode needs COMFY_API_KEY in app/.env" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { shotIds?: unknown };
    const ids = Array.isArray(b.shotIds) ? b.shotIds.filter((x): x is string => typeof x === "string") : p.board.shots.filter((s) => s.frame?.status !== "succeeded").map((s) => s.id);
    if (p.board.shots.some((s) => ids.includes(s.id) && s.frame?.status === "running")) return c.json({ error: "Those frames are still being drawn" }, 409);
    p.stage = "frames";
    void drawFrames(p, ids, lookup);
    return c.json(view(p));
  });

  app.post("/api/agent/:id/shots/:sid/approve", async (c) => {
    const p = need(c.req.param("id"));
    const s = p?.board?.shots.find((x) => x.id === c.req.param("sid"));
    if (!p || !s) return c.json({ error: "no such shot" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { approved?: unknown };
    s.frameApproved = b.approved !== false && s.frame?.status === "succeeded";
    touch(p);
    return c.json(view(p));
  });

  // approval 2: the frames -> film every shot (or the ones asked for again)
  app.post("/api/agent/:id/film", async (c) => {
    const p = need(c.req.param("id"));
    if (!p?.board) return c.json({ error: "no storyboard yet" }, 404);
    if (!hasKey()) return c.json({ error: "Agent mode needs COMFY_API_KEY in app/.env" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { shotIds?: unknown };
    const missing = p.board.shots.filter((s) => s.frame?.status !== "succeeded");
    if (missing.length) return c.json({ error: `Shot ${p.board.shots.indexOf(missing[0]) + 1} has no key frame yet` }, 400);
    const takes = new Map(listTakes().map((t) => [t.id, t]));
    const ids = Array.isArray(b.shotIds)
      ? b.shotIds.filter((x): x is string => typeof x === "string")
      // everything not already filmed or filming
      : p.board.shots.filter((s) => !s.queued && (!s.takeId || takes.get(s.takeId)?.status === "failed")).map((s) => s.id);
    for (const s of p.board.shots) s.frameApproved = true;
    p.stage = "shots";
    filmShots(p, ids);
    return c.json(view(p));
  });
}
