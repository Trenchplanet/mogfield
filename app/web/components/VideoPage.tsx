import { useEffect, useRef, useState, type ReactNode } from "react";
import { FRAME_MODELS, RESHOOT_ANGLES, T2V_ASPECTS, frameLengths, frameModelUsd, snapSeconds, type CastCard, type Clip, type FrameModel, type Render, type ReshootAngle, type T2vAspect, type T2vTake } from "../../server/shared";
import { estimateUsd, formatUsd } from "../../server/providers/pricing";
import { api, type CatalogModel, type ModelOption, type Quality } from "../api";
import { saveToPhotos } from "../save";
import { ANGLE_ICON, Icon } from "./AngleIcons";
import { OpenInComfy } from "./OpenInComfy";
import type { Trim } from "./VideoCard";

export type VideoSub = "create" | "edit" | "restyle";
export type EditTool = "extend" | "reshoot";

const MAX_REFS = 4;
const MODEL_LINE: Record<FrameModel, string> = {
  "seedance-2-5": "Text, frames and reference images, up to 30 s.",
  "seedance-2-0": "Steady, cinematic, up to 15 s and 4K.",
  "seedance-2-0-fast": "Quicker and cheaper, up to 15 s.",
  "seedance-2-0-mini": "Cheapest drafts, up to 15 s.",
  wan3: "Starts on your frame, up to 30 s.",
  "wan3-prime": "Wan 3.0 at its best, up to 30 s.",
  h3: "Text or frames, sharp motion, up to 15 s and 2K.",
  "ltx-2-5-fast": "Text or frames, quick, up to 20 s.",
  "ltx-2-5-pro": "Text or frames, finer detail, up to 10 s.",
};
/** The Comfy router model that runs a prompt (no frames) for each Seedance option.
 *  H3 and LTX 2.5 run a prompt through their own text-to-video nodes instead. */
const ROUTER: Partial<Record<FrameModel, RegExp>> = {
  "seedance-2-5": /seedance-2-5/,
  "seedance-2-0": /seedance-2-0-(?!fast|mini)/,
  "seedance-2-0-fast": /seedance-2-0-fast/,
  "seedance-2-0-mini": /seedance-2-0-mini/,
};

const HOW: Record<string, { title: string; line: string }[]> = {
  create: [
    { title: "Add a frame", line: "Upload a start frame, an end frame or both, or reference images, or start from text alone." },
    { title: "Pick a model", line: "Choose the model, length, shape and resolution. The price shows on the button." },
    { title: "Get video", line: "Press Generate. Finished clips land in History, each with its ComfyUI workflow." },
  ],
  extend: [
    { title: "Pick a video", line: "Any upload, or a take you made here. Choose where it should continue from." },
    { title: "Last frame becomes first frame", line: "The new clip starts on that exact frame, so the characters, place and style carry over." },
    { title: "One joined video", line: "You get the continuation and the original + continuation joined into one video." },
  ],
  reshoot: [
    { title: "Pick a take", line: "The model reads the whole video: people, place and action." },
    { title: "Pick the new camera", line: "Orbit, low angle, overhead, close-up, drone and more." },
    { title: "Get the new angle", line: "The same moment, filmed again from where you put the camera." },
  ],
};

const usd = (n: number | null) => (n === null ? "" : ` · ${formatUsd(n)}`);
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/**
 * Video: one panel for every video tool, like a camera's menu: Create Video
 * (text, start / end frame, references) and Edit Video (Extend, Re-shoot).
 * The panel, its tabs and the History beside it stay put whatever you pick.
 */
export function VideoPage(p: {
  sub: VideoSub;
  tool: EditTool | null;
  onNav: (sub: VideoSub, tool: EditTool | null) => void;
  images: CastCard[];
  onNewImage: (card: CastCard) => void;
  models: ModelOption[];
  /** The header's API switch is on: Create also lists every video model in the Comfy API catalog. */
  apiMode: boolean;
  clip: Clip | null;
  trim: Trim;
  onPickVideo: () => void;
  clips: Clip[];
  renders: Render[];
  say: (m: string) => void;
  onReshoot: (o: { angle: ReshootAngle; direction?: string; model: string; quality: Quality; trim?: Trim }) => Promise<void>;
}) {
  const [takes, setTakes] = useState<T2vTake[]>([]);
  const [side, setSide] = useState<"history" | "how">("history");
  const running = takes.some((t) => t.status === "running" || t.status === "queued");
  useEffect(() => {
    void api.t2vTakes().then(setTakes).catch(() => {});
  }, []);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void api.t2vTakes().then(setTakes).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [running]);
  const added = (t: T2vTake) => {
    setTakes((ts) => [t, ...ts]);
    setSide("history");
  };

  // Extend can also continue a take made here
  const [extendTake, setExtendTake] = useState<T2vTake | null>(null);
  const extendThis = (t: T2vTake) => {
    setExtendTake(t);
    p.onNav("edit", "extend");
  };

  const howKey = p.sub === "create" ? "create" : (p.tool ?? "extend");
  return (
    <div className="vp">
      <aside className="vp-panel">
        {/* every form stays mounted, so what you typed is still there when you come back */}
        <div style={{ display: p.sub === "create" ? "contents" : "none" }}>
          <CreateForm images={p.images} onNewImage={p.onNewImage} models={p.models} apiMode={p.apiMode} say={p.say} onTake={added} />
        </div>
        <div style={{ display: p.sub === "edit" && p.tool === "extend" ? "contents" : "none" }}>
          <ExtendForm clip={p.clip} take={extendTake} onClearTake={() => setExtendTake(null)} onPickVideo={() => { setExtendTake(null); p.onPickVideo(); }} say={p.say} onTake={added} />
        </div>
        <div style={{ display: p.sub === "edit" && p.tool === "reshoot" ? "contents" : "none" }}>
          <ReshootForm clip={p.clip} trim={p.trim} models={p.models} onPickVideo={p.onPickVideo} onStart={p.onReshoot} />
        </div>
      </aside>

      <section className="vp-main">
        <div className="vp-main-tabs" role="tablist">
          <button role="tab" aria-selected={side === "history"} className={side === "history" ? "on" : ""} onClick={() => setSide("history")}>History</button>
          <button role="tab" aria-selected={side === "how"} className={side === "how" ? "on" : ""} onClick={() => setSide("how")}>How it works</button>
        </div>
        {side === "history" ? (
          <History takes={takes} renders={p.renders} clips={p.clips} onExtend={extendThis} />
        ) : (
          <div className="vp-how">
            {HOW[howKey].map((s, i) => (
              <div key={s.title}><span>{i + 1}</span><b>{s.title}</b><p>{s.line}</p></div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- shared bits */

function ModelCard({ model, label, line, onChange, open, children }: { model?: FrameModel; label?: string; line?: string; onChange: () => void; open: boolean; children: ReactNode }) {
  return (
    <div className="vp-model">
      <div className="vp-model-head">
        <span><b>{label ?? FRAME_MODELS[model!].label}</b><small>{line ?? MODEL_LINE[model!]}</small></span>
        <button className="small" onClick={onChange}>{open ? "Done" : "Change"}</button>
      </div>
      {open && <div className="vp-model-list">{children}</div>}
    </div>
  );
}

function Chips<T extends string | number>({ label, value, options, onChange, show = (x) => String(x) }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; show?: (v: T) => string }) {
  return (
    <label className="vp-chip">
      <span>{label}</span>
      <select value={String(value)} onChange={(e) => onChange(options.find((o) => String(o) === e.target.value) ?? value)}>
        {options.map((o) => <option key={String(o)} value={String(o)}>{show(o)}</option>)}
      </select>
    </label>
  );
}

function FrameSlot({ label, card, onPick, onClear, busy }: { label: string; card: CastCard | null; onPick: (f: File) => void; onClear: () => void; busy: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className={`vp-frame ${card ? "has" : ""}`}>
      {card ? (
        <>
          <img src={card.url} alt={label} />
          <button className="vp-x" onClick={onClear} aria-label={`Remove ${label.toLowerCase()}`}>×</button>
          <span className="vp-frame-label">{label}</span>
        </>
      ) : (
        <button onClick={() => file.current?.click()} disabled={busy}>
          <small>Optional</small>
          <Icon d="M4 5h16v14H4zM8 13l3-3 5 5M15 10h.01" />
          <b>{busy ? "Uploading…" : label}</b>
        </button>
      )}
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])} />
    </div>
  );
}

/* ---------------------------------------------------------------- Create Video */

/** What a catalog model takes, in words. */
const takesLine = (m: CatalogModel) => `${m.provider} · ${m.inputs.filter((x) => x !== "text").length ? `text + ${m.inputs.filter((x) => x !== "text").join(" + ")}` : "text only"}${m.outputs.includes("audio") ? " · with sound" : ""}`;
const CATALOG_LENGTHS = [3, 4, 5, 6, 8, 10, 12, 15, 20, 30];
const CATALOG_QUALITIES = ["480p", "720p", "1080p"] as const;

/** The Comfy API's video models, read once per page load (the first read on the server takes a minute). */
export function useCatalog(on: boolean, output: "video" | "image") {
  const [list, setList] = useState<{ ready: boolean; models: CatalogModel[] }>({ ready: false, models: [] });
  useEffect(() => {
    if (!on) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      void api.catalog(output).then((r) => {
        if (stop) return;
        setList(r);
        if (!r.ready) timer = setTimeout(load, 5000);
      }).catch(() => {});
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [on, output]);
  return list;
}

export function CatalogList({ list, current, onPick, title }: { list: { ready: boolean; models: CatalogModel[] }; current: string | null; onPick: (m: CatalogModel) => void; title: string }) {
  const [q, setQ] = useState("");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = list.models.filter((m) => words.every((w) => `${m.id} ${m.label}`.toLowerCase().includes(w)));
  return (
    <>
      <div className="vp-model-sep">
        <span>{title} {list.models.length > 0 && <small>{list.models.filter((m) => !m.needs).length} ready</small>}</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Search Kling, Veo, Wan…" aria-label="Search models" />
      </div>
      {!list.ready && !list.models.length && <small className="vp-hint">Reading the Comfy API catalog… this takes about a minute the first time.</small>}
      {shown.map((m) => (
        <button key={m.id} className={current === m.id ? "on" : ""} onClick={() => onPick(m)} title={m.id} disabled={!!m.needs}>
          <b>{m.label}</b><small>{m.needs ? `${m.provider} · ${m.needs}` : takesLine(m)}</small>
        </button>
      ))}
      {list.ready && !shown.length && <small className="vp-hint">No model matches “{q}”.</small>}
    </>
  );
}

function CreateForm(p: { images: CastCard[]; onNewImage: (c: CastCard) => void; models: ModelOption[]; apiMode: boolean; say: (m: string) => void; onTake: (t: T2vTake) => void }) {
  const [model, setModel] = useState<FrameModel>("seedance-2-5");
  // any other model from the Comfy API catalog, picked from the full list
  const [other, setOther] = useState<CatalogModel | null>(null);
  const catalog = useCatalog(p.apiMode, "video");
  const [picking, setPicking] = useState(false);
  const [start, setStart] = useState<CastCard | null>(null);
  const [end, setEnd] = useState<CastCard | null>(null);
  const [uploading, setUploading] = useState<"start" | "end" | "ref" | null>(null);
  const [refs, setRefs] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState(5);
  const [aspect, setAspect] = useState<T2vAspect>("9:16");
  const [quality, setQuality] = useState("720p");
  const [audio, setAudio] = useState(true);
  const [busy, setBusy] = useState(false);
  const refFile = useRef<HTMLInputElement>(null);

  // the catalog list only exists with the API switch on
  const picked = p.apiMode ? other : null;
  const m = FRAME_MODELS[model];
  const frames = !!(start || end);
  // H3 and LTX 2.5 run frames and prompts alike as a workflow; Seedance without frames goes to the Comfy model router
  const workflow = !picked && (frames || !!m.text);
  const router = !picked && !workflow ? p.models.find((x) => x.available && ROUTER[model]?.test(x.id)) : undefined;
  const qualities: readonly string[] = picked ? CATALOG_QUALITIES : m.qualities;
  const q = qualities.includes(quality) ? quality : qualities[0];
  const lengths = picked ? CATALOG_LENGTHS : frameLengths(model);
  const secs = picked ? lengths.reduce((b, x) => (Math.abs(x - seconds) < Math.abs(b - seconds) ? x : b)) : snapSeconds(model, Math.min(m.max, Math.max(m.min, seconds)));
  const pictures = [start?.id, end?.id, ...refs].filter((x): x is string => !!x);
  const blocked = picked
    ? null
    : m.needsStart && !start
    ? `${m.label} starts on a start frame: add one, or pick another model`
    : m.text && end && !start
      ? `${m.label} needs a start frame to go with the end frame`
      : !workflow && !router && p.models.length
        ? `${m.label} is not on your Comfy API account`
        : null;
  const cost = blocked || picked ? null : workflow ? frameModelUsd(model, q, secs) : router ? estimateUsd(router.pricing, { seconds: secs, quality: q as Quality, aspect: T2V_ASPECTS[aspect], inputVideos: 0 }) : null;

  const upload = async (f: File, slot: "start" | "end" | "ref") => {
    setUploading(slot);
    try {
      const card = await api.cast({ file: f, kind: "character", saved: slot === "ref" });
      if (slot === "start") setStart(card);
      else if (slot === "end") setEnd(card);
      else {
        p.onNewImage(card);
        setRefs((xs) => (xs.length >= MAX_REFS ? xs : [...xs, card.id]));
      }
    } catch (e) {
      p.say((e as Error).message);
    } finally {
      setUploading(null);
    }
  };

  const go = async () => {
    if (busy || blocked || !prompt.trim()) return;
    setBusy(true);
    try {
      const take = picked
        ? await api.t2v({ prompt: prompt.trim(), imageIds: pictures.slice(0, MAX_REFS), model: `comfy:${picked.id}`, quality: q, seconds: secs, aspect, audio })
        : workflow
        ? await api.frames({ prompt: prompt.trim(), startId: start?.id, endId: end?.id, model, quality: q, seconds: secs, aspect, audio })
        : await api.t2v({ prompt: prompt.trim(), imageIds: refs, model: router!.id, quality: q, seconds: secs, aspect, audio });
      p.onTake(take);
      p.say("Started. It shows in History.");
    } catch (e) {
      p.say((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="vp-body">
        <ModelCard model={model} label={picked?.label} line={picked ? takesLine(picked) : undefined} open={picking} onChange={() => setPicking((x) => !x)}>
          {p.apiMode && <div className="vp-model-sep"><span>Tuned for MOGFIELD</span></div>}
          {(Object.keys(FRAME_MODELS) as FrameModel[]).map((id) => (
            <button key={id} className={!picked && id === model ? "on" : ""} onClick={() => { setModel(id); setOther(null); setPicking(false); }}>
              <b>{FRAME_MODELS[id].label}</b><small>{MODEL_LINE[id]}</small>
            </button>
          ))}
          {p.apiMode && <CatalogList title="All Comfy API video models" list={catalog} current={picked?.id ?? null} onPick={(x) => { setOther(x); setPicking(false); }} />}
        </ModelCard>
        <div className="vp-frames">
          <FrameSlot label="Start frame" card={start} busy={uploading === "start"} onPick={(f) => void upload(f, "start")} onClear={() => setStart(null)} />
          <FrameSlot label="End frame" card={end} busy={uploading === "end"} onPick={(f) => void upload(f, "end")} onClear={() => setEnd(null)} />
        </div>
        {picked && !picked.inputs.includes("image") && pictures.length > 0 && <small className="vp-warn">{picked.label} takes text only: the pictures are left out.</small>}
        {picked && <small className="vp-hint">Runs on the Comfy API with its settings filled from the model's own schema. Comfy bills it at the model's own rate.</small>}
        {frames && !picked ? (
          <small className="vp-hint">{start && end ? "The video starts on the first picture and lands on the second." : start ? "The video starts on this picture." : "The video ends on this picture."} Shape comes from the frame.</small>
        ) : (
          <div className="vp-refs">
            <span className="vp-label">Reference images <small>(optional, up to {MAX_REFS})</small></span>
            <div className="vp-ref-row">
              <button className="vp-ref add" onClick={() => refFile.current?.click()} disabled={uploading === "ref"} aria-label="Add a reference image">{uploading === "ref" ? "…" : "+"}</button>
              {p.images.slice(0, 16).map((img) => (
                <button key={img.id} className={`vp-ref ${refs.includes(img.id) ? "on" : ""}`} title={img.prompt} aria-pressed={refs.includes(img.id)} onClick={() => setRefs((xs) => (xs.includes(img.id) ? xs.filter((x) => x !== img.id) : xs.length >= MAX_REFS ? xs : [...xs, img.id]))}>
                  <img src={img.url} alt={img.prompt} />
                  {refs.includes(img.id) && <span>{refs.indexOf(img.id) + 1}</span>}
                </button>
              ))}
            </div>
            <input ref={refFile} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0], "ref")} />
          </div>
        )}
        <label className="vp-field">
          <span className="vp-label">Prompt</span>
          <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={frames ? "What happens between the frames: the action, the camera move, the mood" : "What video do you want to create?"} />
        </label>
        <div className="vp-chips">
          <Chips label="Length" value={secs} options={lengths} onChange={setSeconds} show={(x) => `${x}s`} />
          {(!frames || picked) && <Chips label="Aspect" value={aspect} options={Object.keys(T2V_ASPECTS) as T2vAspect[]} onChange={setAspect} />}
          <Chips label="Resolution" value={q} options={m.qualities} onChange={setQuality} />
          {!picked && model === "h3" ? (
            <span className="vp-audio on" title="MiniMax H3 always makes sound">Audio always on</span>
          ) : picked && !picked.outputs.includes("audio") ? null : (
            <button className={`vp-audio ${audio ? "on" : ""}`} onClick={() => setAudio((x) => !x)} aria-pressed={audio}>Audio {audio ? "on" : "off"}</button>
          )}
        </div>
        {blocked && <small className="vp-warn">{blocked}</small>}
        <OpenInComfy say={p.say} settings={() => ({ tool: "create", model: picked ? picked.id : model, prompt, quality: q, seconds: secs, aspect, audio, start: !!start, end: !!end, refs: refs.length })} />
      </div>
      <div className="vp-foot">
        <button className="vp-go" disabled={busy || !!blocked || !prompt.trim()} onClick={go}>{busy ? "Starting…" : `Generate${usd(cost)}`}</button>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- Extend Video */

function ExtendForm(p: { clip: Clip | null; take: T2vTake | null; onClearTake: () => void; onPickVideo: () => void; say: (m: string) => void; onTake: (t: T2vTake) => void }) {
  const [model, setModel] = useState<FrameModel>("seedance-2-5");
  const [picking, setPicking] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState(5);
  const [quality, setQuality] = useState("720p");
  const [audio, setAudio] = useState(true);
  const [busy, setBusy] = useState(false);
  const src = p.take ? { url: p.take.joinedUrl ?? p.take.url!, duration: 0, label: "Your take" } : p.clip ? { url: p.clip.url, duration: p.clip.duration, label: p.clip.name } : null;
  const [duration, setDuration] = useState(0);
  const total = src?.duration || duration;
  const [from, setFrom] = useState<number | null>(null);
  const at = from === null || from > total ? total : from;
  useEffect(() => setFrom(null), [src?.url]);

  const m = FRAME_MODELS[model];
  const q = (m.qualities as readonly string[]).includes(quality) ? quality : m.qualities[0];
  const secs = snapSeconds(model, Math.min(m.max, Math.max(m.min, seconds)));
  const lengths = frameLengths(model);
  const cost = frameModelUsd(model, q, secs);

  const go = async () => {
    if (!src || busy || !total) return;
    setBusy(true);
    try {
      const take = await api.extend({ ...(p.take ? { takeId: p.take.id } : { clipId: p.clip!.id }), from: at, prompt: prompt.trim(), model, quality: q, seconds: secs, audio });
      p.onTake(take);
      p.say("Extending. The continuation and the joined video show in History.");
    } catch (e) {
      p.say((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="vp-body">
        <div className="vp-hero"><b>Extend Video</b><span>The last frame becomes the first frame of what comes next. Same characters, same place, same style.</span></div>
        {src ? (
          <div className="vp-source">
            <video key={`${src.url}#${at.toFixed(2)}`} src={`${src.url}#t=${Math.max(0, at - 0.05).toFixed(2)}`} muted playsInline preload="auto" onLoadedMetadata={(e) => !src.duration && setDuration(e.currentTarget.duration)} />
            <span className="vp-frame-label">Continues from {fmt(at)}</span>
            <button className="vp-replace" onClick={p.take ? p.onClearTake : p.onPickVideo}>{p.take ? "Use upload" : "Replace"}</button>
          </div>
        ) : (
          <button className="vp-add-video" onClick={p.onPickVideo}><Icon d="M4 6h11v12H4zM15 10l5-3v10l-5-3" /><b>Add video to extend</b><small>Any upload, or Extend a take from History</small></button>
        )}
        {src && total > 0 && (
          <label className="vp-range">
            <span className="vp-label">Continue from <b>{fmt(at)}</b> of {fmt(total)}</span>
            <input type="range" min={0.5} max={total} step={0.1} value={at} onChange={(e) => setFrom(Number(e.target.value))} />
          </label>
        )}
        <ModelCard model={model} open={picking} onChange={() => setPicking((x) => !x)}>
          {(Object.keys(FRAME_MODELS) as FrameModel[]).map((id) => (
            <button key={id} className={id === model ? "on" : ""} onClick={() => { setModel(id); setPicking(false); }}>
              <b>{FRAME_MODELS[id].label}</b><small>{MODEL_LINE[id]}</small>
            </button>
          ))}
        </ModelCard>
        <label className="vp-field">
          <span className="vp-label">What happens next <small>(optional)</small></span>
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Leave empty to just carry on, or direct it: she spins and bows, the camera pulls back" />
        </label>
        <div className="vp-chips">
          <Chips label="Duration" value={secs} options={lengths} onChange={setSeconds} show={(x) => `${x}s`} />
          <Chips label="Quality" value={q} options={m.qualities} onChange={setQuality} />
          {model === "h3" ? (
            <span className="vp-audio on" title="MiniMax H3 always makes sound">Audio always on</span>
          ) : (
            <button className={`vp-audio ${audio ? "on" : ""}`} onClick={() => setAudio((x) => !x)} aria-pressed={audio}>Audio {audio ? "on" : "off"}</button>
          )}
        </div>
        <OpenInComfy say={p.say} settings={() => ({ tool: "extend", model, prompt, quality: q, seconds: secs, audio, aspect: p.clip && p.clip.width < p.clip.height ? "9:16" : "16:9" })} />
      </div>
      <div className="vp-foot">
        <button className="vp-go" disabled={!src || busy || !total} onClick={go}>{busy ? "Starting…" : `Extend +${secs}s${usd(cost)}`}</button>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- Re-shoot */

function ReshootForm(p: { clip: Clip | null; trim: Trim; models: ModelOption[]; onPickVideo: () => void; onStart: (o: { angle: ReshootAngle; direction?: string; model: string; quality: Quality; trim?: Trim }) => Promise<void> }) {
  // models that take the whole take as a reference: Seedance, Wan 3.0 and MiniMax H3
  const options = p.models.filter((m) => m.available && (/seedance/.test(m.id) || m.id.startsWith("refv:")));
  const [angle, setAngle] = useState<ReshootAngle>("orbit_left");
  const [direction, setDirection] = useState("");
  const [modelId, setModelId] = useState("");
  const model = options.find((m) => m.id === modelId) ?? options.find((m) => /2-0-260128/.test(m.id)) ?? options[0];
  const [quality, setQuality] = useState<Quality>("480p");
  const q: Quality = model?.qualities.includes(quality) ? quality : (model?.qualities[0] ?? "480p");
  const [busy, setBusy] = useState(false);
  const maxSeconds = model?.maxSeconds ?? 15;
  const trim = p.clip ? { start: p.trim.start, end: Math.min(p.trim.end, p.trim.start + maxSeconds) } : p.trim;
  const seconds = trim.end - trim.start;
  const requestTrim = p.clip && seconds < p.clip.duration - 0.05 ? trim : undefined;
  const cost = p.clip && model ? estimateUsd(model.pricing, { seconds, quality: q, aspect: p.clip.width / p.clip.height, inputVideos: 1 }) : null;
  const go = async () => {
    if (!p.clip || !model || busy) return;
    setBusy(true);
    try {
      await p.onStart({ angle, direction: direction.trim() || undefined, model: model.id, quality: q, trim: requestTrim });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="vp-body">
        <div className="vp-hero"><b>Re-shoot</b><span>The same moment, filmed again from another angle.</span></div>
        {p.clip ? (
          <div className="vp-source">
            <video src={`${p.clip.url}#t=${trim.start.toFixed(2)}`} muted playsInline preload="metadata" />
            <span className="vp-frame-label">{fmt(trim.start)}–{fmt(trim.end)}</span>
            <button className="vp-replace" onClick={p.onPickVideo}>Replace</button>
          </div>
        ) : (
          <button className="vp-add-video" onClick={p.onPickVideo}><Icon d="M4 6h11v12H4zM15 10l5-3v10l-5-3" /><b>Add a video</b><small>Up to {maxSeconds} s</small></button>
        )}
        <div className="vp-angles" role="radiogroup" aria-label="Camera angle">
          {(Object.keys(RESHOOT_ANGLES) as ReshootAngle[]).map((id) => (
            <button key={id} role="radio" aria-checked={angle === id} className={angle === id ? "on" : ""} onClick={() => setAngle(id)} title={RESHOOT_ANGLES[id].camera}>
              <Icon d={ANGLE_ICON[id]} />
              <b>{RESHOOT_ANGLES[id].label}</b>
            </button>
          ))}
        </div>
        <label className="vp-field">
          <span className="vp-label">Direction <small>(optional)</small></span>
          <textarea rows={2} value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="e.g. golden hour, keep the dog in frame" />
        </label>
        {options.length ? (
          <div className="vp-chips">
            <Chips label="Model" value={model?.id ?? ""} options={options.map((o) => o.id)} onChange={setModelId} show={(id) => options.find((o) => o.id === id)?.label ?? id} />
            <Chips label="Quality" value={q} options={model?.qualities ?? []} onChange={setQuality} />
          </div>
        ) : (
          <small className="vp-warn">Re-shoot needs Seedance, Wan 3.0 or MiniMax H3 on the Comfy API. Add COMFY_API_KEY to app/.env.</small>
        )}
        <OpenInComfy settings={() => ({ tool: "reshoot", model: model?.id, prompt: direction, quality: q, seconds, angle, aspect: p.clip && p.clip.width < p.clip.height ? "9:16" : "16:9" })} />
      </div>
      <div className="vp-foot">
        <button className="vp-go" disabled={!p.clip || !model || busy} onClick={go}>{busy ? "Starting…" : `Re-shoot · ${RESHOOT_ANGLES[angle].label}${usd(cost)}`}</button>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- History */

/** A finished take at its own shape (16:9, 9:16 or whatever the model made), read from the file itself.
 *  It plays while it is on screen: autoplay alone never starts in a tab that was hidden when it mounted. */
function TakeVideo({ url, aspect }: { url: string; aspect?: number }) {
  const [ratio, setRatio] = useState(aspect ?? 16 / 9);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) void v.play().catch(() => {});
      else v.pause();
    }, { threshold: 0.25 });
    io.observe(v);
    return () => io.disconnect();
  }, [url]);
  return (
    <video
      ref={ref}
      // #t shows a real frame before it plays, instead of black
      src={`${url}#t=0.1`}
      style={{ aspectRatio: String(ratio) }}
      muted
      loop
      playsInline
      controls
      preload="metadata"
      onLoadedMetadata={(e) => e.currentTarget.videoWidth && setRatio(e.currentTarget.videoWidth / e.currentTarget.videoHeight)}
    />
  );
}

const KIND: Record<string, string> = { t2v: "Text to video", frames: "First–last frame", extend: "Extend", reshoot: "Re-shoot" };

function History({ takes, renders, clips, onExtend }: { takes: T2vTake[]; renders: Render[]; clips: Clip[]; onExtend: (t: T2vTake) => void }) {
  type Item = { at: number; take?: T2vTake; render?: Render };
  const items: Item[] = [...takes.map((t) => ({ at: t.createdAt, take: t })), ...renders.filter((r) => r.params.reshoot).map((r) => ({ at: r.createdAt, render: r }))].sort((a, b) => b.at - a.at).slice(0, 30);
  if (!items.length) return <div className="vp-empty">Nothing yet. Finished clips land here, each with its ComfyUI workflow.</div>;
  return (
    <div className="vp-grid">
      {items.map(({ take: t, render: r }) => {
        const id = t?.id ?? r!.id;
        const status = t?.status ?? r!.status;
        const url = t ? (t.joinedUrl ?? t.url) : r!.url;
        const progress = t?.progress ?? r?.progress ?? 0;
        const kind = t ? (t.kind ?? "t2v") : "reshoot";
        const meta = t ? `${t.kind === "extend" ? `+${t.seconds} s` : `${t.seconds} s`} · ${t.quality} · ${FRAME_MODELS[t.model as FrameModel]?.label ?? (t.model.includes("2-5") ? "Seedance 2.5" : "Seedance")}` : `${RESHOOT_ANGLES[r!.params.reshoot!].label} · ${clips.find((c) => c.id === r!.params.clipId)?.name ?? ""}`;
        return (
          <div key={id} className="vp-take">
            {status === "succeeded" && url ? (
              <TakeVideo url={url} aspect={t ? T2V_ASPECTS[t.aspect] : undefined} />
            ) : (
              <div className="vp-wait">
                <span>{status === "failed" ? "Failed" : (t?.message ?? r?.message) || "Queued"}</span>
                {status !== "failed" && <span className="depth-bar"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span>}
              </div>
            )}
            <div className="vp-take-meta">
              <span className="vp-kind">{KIND[kind]}</span>
              <small>{meta}</small>
              {status === "succeeded" && url ? (
                <span className="vp-actions">
                  <a className="btn small" href={url} download={`mogfield-${kind}-${id}.mp4`} {...saveToPhotos(url, `mogfield-${kind}-${id}.mp4`)}>Save</a>
                  {t?.joinedUrl && t.url && <a className="btn small" href={t.url} download={`mogfield-extend-${id}-only.mp4`} title="Only the new part">New part</a>}
                  {t && <button className="small" onClick={() => onExtend(t)} title="Continue this video from its last frame">Extend</button>}
                  {(t?.workflowUrl ?? r?.workflowUrl) && <a className="btn small" href={(t?.workflowUrl ?? r?.workflowUrl)!} download={`mogfield-${kind}-${id}.workflow.json`} title="The ComfyUI workflow this take ran">Workflow</a>}
                </span>
              ) : status === "failed" ? (
                <small className="vp-err" title={t?.error ?? r?.error}>{(t?.error ?? r?.error ?? "").slice(0, 90)}</small>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
