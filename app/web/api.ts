import type { BackendStatus } from "../server/backend";
import type { ExportRequest } from "../server/workflowExport";
import type { AgentProject, AgentSettings, AgentShot, FrameModel, T2vAspect, T2vTake } from "../server/shared";
import type { CastCard, Clip, DepthJob, PersonBox, Preparation, PromptPack, Render, RenderEvent, RenderParams } from "../server/shared";

export type AgentSummary = { id: string; title: string; stage: AgentProject["stage"]; updatedAt: number; model: FrameModel; cast: number; thumb?: string };
export type AgentShotView = AgentShot & { take?: { status: T2vTake["status"]; progress: number; message: string; url?: string; error?: string } };
export type AgentView = Omit<AgentProject, "board"> & {
  board?: Omit<NonNullable<AgentProject["board"]>, "shots"> & { shots: AgentShotView[] };
  settings: AgentSettings;
  cast: { id: string; url: string; prompt: string }[];
  quote: { frames: number; shots: number };
  director: string;
};
/** The local director: model and quantization choices, the start command and what the server has loaded. */
export type DirectorStatus = {
  local: boolean;
  url: string;
  running: boolean;
  models: { repo: string; label: string; note: string; quant: string; uncensored?: boolean; quants: { quant: string; gb: number }[] }[];
  choice: { repo: string; quant: string };
  command: string;
  label: string;
  loaded?: string[];
  cloud: string;
};
const agentPost = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<AgentView>(r));

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

/**
 * Live job updates: server-sent events first. Some tunnels (Cloudflare quick
 * tunnels) hold an event stream back until it closes, so if the stream stays
 * silent or errors, fall back to polling the job's plain JSON route.
 * `onEvent` and `poll` return true once the job has finished.
 */
function follow<T>(streamUrl: string, onEvent: (data: T) => boolean, poll: () => Promise<boolean>): () => void {
  let closed = false;
  let polling = false;
  let heard = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const es = new EventSource(streamUrl);
  const stop = () => {
    closed = true;
    es.close();
    if (timer) clearTimeout(timer);
  };
  const startPolling = () => {
    if (closed || polling) return;
    polling = true;
    es.close();
    if (timer) clearTimeout(timer);
    const tick = async () => {
      if (closed) return;
      let done = false;
      try {
        done = await poll();
      } catch {
        // a dropped request is retried on the next tick
      }
      if (done) stop();
      else if (!closed) timer = setTimeout(tick, 2000);
    };
    void tick();
  };
  es.onmessage = (m) => {
    if (closed || polling) return;
    heard = true;
    if (onEvent(JSON.parse(m.data) as T)) stop();
  };
  es.onerror = () => startPolling();
  timer = setTimeout(() => {
    if (!heard) startPolling();
  }, 4000);
  return stop;
}

/** GET a job's JSON; null when the server no longer knows it (e.g. after a restart). */
async function getJob<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;
  return j<T>(res);
}

export type { ModelOption, Quality } from "../server/providers/types";
export type { CatalogModel } from "../server/providers/catalog";
import type { CatalogModel } from "../server/providers/catalog";
import type { ModelOption } from "../server/providers/types";

export interface Health {
  engine: "comfy" | "preview";
  target: string | null;
  workflows: string[];
  ffmpeg: boolean;
  renderCap: number;
  repo: string;
  preparation: { comfyConfigured: boolean; rubberBandConfigured: boolean };
}

/** POST multipart with upload progress (fetch cannot report it). onProgress gets 0..1. */
function postForm<T>(url: string, fd: FormData, onProgress?: (p: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.upload.onload = () => onProgress?.(1);
    x.onload = () => {
      let body: { error?: string } = {};
      try {
        body = JSON.parse(x.responseText);
      } catch {
        /* not json */
      }
      if (x.status >= 200 && x.status < 300) resolve(body as T);
      else reject(new Error(body.error ?? `HTTP ${x.status}`));
    };
    x.onerror = () => reject(new Error("Upload failed: network error"));
    x.send(fd);
  });
}

export const api = {
  health: () => fetch("/api/health").then((r) => j<Health>(r)),
  /** Where workflows run, and which features that target can run. */
  /** 16:9 side-by-side of a finished take and its original, with the label layer drawn in the browser. */
  abExport: (renderId: string, overlay: string) =>
    fetch(`/api/renders/${renderId}/ab`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ overlay }) }).then((r) => j<{ url: string }>(r)),
  /** Text to video takes, newest first. */
  t2vTakes: () => fetch("/api/t2v").then((r) => j<T2vTake[]>(r)),
  frames: (body: { prompt: string; startId?: string; endId?: string; refIds?: string[]; model: FrameModel; quality: string; seconds: number; aspect: T2vAspect; audio: boolean }) =>
    fetch("/api/frames", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<T2vTake>(r)),
  extend: (body: { clipId?: string; takeId?: string; from: number; prompt: string; model: FrameModel; quality: string; seconds: number; audio: boolean }) =>
    fetch("/api/extend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<T2vTake>(r)),
  t2v: (body: { prompt: string; imageIds: string[]; model: string; quality: string; seconds: number; aspect: T2vAspect; audio: boolean }) =>
    fetch("/api/t2v", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<T2vTake>(r)),
  /** Comfy API credits left, in dollars (available = prepaid − pending charges). */
  credits: (fresh = false) => fetch(`/api/credits${fresh ? "?fresh" : ""}`).then((r) => j<{ available: number; prepaid: number; pending: number; cloud: number; currency: string }>(r)),
  /** Every Comfy API model that makes a video (or a picture) from a prompt. */
  catalog: (output: "video" | "image") => fetch(`/api/catalog?output=${output}`).then((r) => j<{ ready: boolean; models: CatalogModel[] }>(r)),
  image: (body: { prompt: string; model: string; imageIds: string[]; aspect: T2vAspect }) =>
    fetch("/api/image", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<CastCard>(r)),
  describeStyle(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    return fetch("/api/style/describe", { method: "POST", body: fd }).then((r) => j<{ style: string }>(r));
  },
  /** Agent mode (experimental): projects with a director, a storyboard and approvals. */
  agentList: () => fetch("/api/agent").then((r) => j<AgentSummary[]>(r)),
  directorGet: () => fetch("/api/agent/director").then((r) => j<DirectorStatus>(r)),
  directorSet: (repo: string, quant: string) => agentPost("/api/agent/director", { repo, quant }) as unknown as Promise<{ command: string; label: string }>,
  agentNew: (body: { title?: string; castIds?: string[] } & Partial<AgentSettings> = {}) => agentPost("/api/agent", body),
  agentUpdate: (id: string, patch: { title?: string; castIds?: string[]; settings?: Partial<AgentSettings> }) =>
    fetch(`/api/agent/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).then((r) => j<AgentView>(r)),
  agentGet: (id: string) => fetch(`/api/agent/${id}`).then((r) => j<AgentView>(r)),
  agentDelete: (id: string) => fetch(`/api/agent/${id}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
  agentSay: (id: string, text: string, castIds: string[]) => agentPost(`/api/agent/${id}/message`, { text, castIds }),
  agentBoard: (id: string, patch: Record<string, unknown>) =>
    fetch(`/api/agent/${id}/board`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).then((r) => j<AgentView>(r)),
  agentFrames: (id: string, shotIds?: string[]) => agentPost(`/api/agent/${id}/frames`, { shotIds }),
  agentApprove: (id: string, shotId: string, approved: boolean) => agentPost(`/api/agent/${id}/shots/${shotId}/approve`, { approved }),
  agentFilm: (id: string, shotIds?: string[]) => agentPost(`/api/agent/${id}/film`, { shotIds }),
  /** The ComfyUI graph a tool would run with these settings (Open in ComfyUI). */
  workflowExport: (body: ExportRequest) =>
    fetch("/api/workflow-export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<{ name: string; graph: Record<string, unknown> }>(r)),
  backend: () => fetch("/api/backend").then((r) => j<BackendStatus>(r)),
  /** Check a target without switching (test), or switch to it. */
  setBackend: (b: { target: "cloud" | "custom"; url?: string; test?: boolean }) =>
    fetch("/api/backend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => j<BackendStatus>(r)),
  clips: () => fetch("/api/clips").then((r) => j<Clip[]>(r)),
  luts: () => fetch("/api/luts").then((r) => j<string[]>(r)),
  models: () => fetch("/api/models").then((r) => j<ModelOption[]>(r)),
  library: () => fetch("/api/casts").then((r) => j<CastCard[]>(r)),
  updateImage: (id: string, patch: { saved?: boolean; name?: string }) =>
    fetch(`/api/casts/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).then((r) => j<CastCard>(r)),
  deleteImage: (id: string) => fetch(`/api/casts/${id}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
  renders: () => fetch("/api/renders").then((r) => j<Render[]>(r)),
  /** Download a TikTok / Instagram / X link on the server and add it as a clip. */
  uploadLink: (url: string) =>
    fetch("/api/clips/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }).then((r) => j<Clip>(r)),
  upload(file: File, onProgress?: (p: number) => void) {
    const fd = new FormData();
    fd.append("file", file);
    return postForm<Clip>("/api/clips", fd, onProgress);
  },
  makeCharacter(input: { file: File; name?: string; size: "1K" | "2K" }, onProgress?: (p: number) => void) {
    const fd = new FormData();
    fd.append("file", input.file);
    fd.append("size", input.size);
    if (input.name) fd.append("name", input.name);
    return postForm<CastCard>("/api/characters", fd, onProgress);
  },
  /** Character studio: the photo (new file or earlier picture) with elements added. */
  studioPicture(input: { file?: File; baseId?: string; name: string; elements: string[]; note: string; refs: File[] }, onProgress?: (p: number) => void) {
    const fd = new FormData();
    if (input.file) fd.append("file", input.file);
    if (input.baseId) fd.append("baseId", input.baseId);
    fd.append("name", input.name);
    fd.append("elements", JSON.stringify(input.elements));
    fd.append("note", input.note);
    for (const r of input.refs) fd.append("ref", r);
    return postForm<{ base: CastCard; picture: CastCard }>("/api/studio/picture", fd, onProgress);
  },
  studioBoard: (input: { pictureId: string; name: string; size: "1K" | "2K" }) =>
    fetch("/api/studio/board", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }).then((r) => j<CastCard>(r)),
  cast(input: { prompt?: string; file?: File; kind: CastCard["kind"]; saved?: boolean }, onProgress?: (p: number) => void) {
    const fd = new FormData();
    fd.append("kind", input.kind);
    if (input.saved) fd.append("saved", "true");
    if (input.prompt) fd.append("prompt", input.prompt);
    if (input.file) fd.append("file", input.file);
    return postForm<CastCard>("/api/cast", fd, onProgress);
  },
  render: (p: RenderParams) =>
    fetch("/api/renders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }).then((r) => j<Render>(r)),
  finalizeDraft: (id: string) =>
    fetch(`/api/renders/${id}/finalize`, { method: "POST" }).then((r) => j<Render>(r)),
  reel: (renderId: string, titleCard: string, endCard: string) =>
    fetch("/api/reels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ renderId, titleCard, endCard }) }).then((r) =>
      j<{ url: string }>(r),
    ),
  depth: (clipId: string) => fetch(`/api/clips/${clipId}/depth`, { method: "POST" }).then((r) => j<DepthJob>(r)),
  prepare: (input: { clipId: string; trim?: { start: number; end: number }; segmentPrompt: string; people?: PersonBox[]; peopleAt?: number }) =>
    fetch("/api/preparations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }).then((r) => j<Preparation>(r)),
  preparations: () => fetch("/api/preparations", { cache: "no-store" }).then((r) => j<Preparation[]>(r)),
  dismissPreparation: (id: string) => fetch(`/api/preparations/${id}/dismiss`, { method: "POST" }).then((r) => j<Preparation>(r)),
  dismissRender: (id: string) => fetch(`/api/renders/${id}/dismiss`, { method: "POST" }).then((r) => j<Render>(r)),
  approvePreparation: (id: string, manifestHash: string) =>
    fetch(`/api/preparations/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifestHash }) }).then((r) => j<Preparation>(r)),
  watchPreparation(id: string, on: (job: Preparation) => void) {
    const finished = (job: Preparation) => job.status === "ready" || job.status === "failed";
    return follow<Preparation>(
      `/api/preparations/${id}/events`,
      (job) => {
        on(job);
        return finished(job);
      },
      async () => {
        const job = await getJob<Preparation>(`/api/preparations/${id}`);
        if (!job) return true;
        on(job);
        return finished(job);
      },
    );
  },
  watchDepth(clipId: string, on: (job: DepthJob) => void) {
    return follow<DepthJob>(
      `/api/clips/${clipId}/depth/events`,
      (job) => {
        on(job);
        return job.status !== "running";
      },
      async () => {
        // depth jobs have no status route; a finished map shows up on the clip
        const clips = await getJob<Clip[]>("/api/clips");
        const url = clips?.find((c) => c.id === clipId)?.depthUrl;
        if (!url) return false;
        on({ clipId, status: "succeeded", progress: 1, message: "Depth ready", url });
        return true;
      },
    );
  },
  pack: (body: { clipId: string; castIds: string[]; prompt?: string; look?: string; keepBackground?: boolean; background?: string }) =>
    fetch("/api/recast/pack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<PromptPack>(r)),
  workflow: (name: string) => fetch(`/api/workflows/${name}`).then((r) => (r.ok ? r.json() : null)),
  watch(id: string, on: (ev: RenderEvent) => void) {
    const finished = (r: Render) => r.status === "succeeded" || r.status === "failed";
    return follow<RenderEvent>(
      `/api/renders/${id}/events`,
      (ev) => {
        on(ev);
        return ev.type === "status" && finished(ev.render);
      },
      async () => {
        const r = await getJob<Render>(`/api/renders/${id}`);
        if (!r) return true;
        // every poll carries the step checklist, so send the whole take each time
        on({ type: "status", render: r });
        if (!finished(r)) on({ type: "progress", progress: r.progress, message: r.message });
        return finished(r);
      },
    );
  },
};

export type { BackendStatus };
