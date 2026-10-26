import { useRef, useState, type ReactNode } from "react";
import { PasteLink } from "./PasteLink";
import { LoraPicker, LoraToggle } from "./LoraRow";
import { DepthToggle } from "./DepthToggle";
import { findVideoLink, type CastCard, type Clip, type DepthJob, type Render } from "../../server/shared";
import { PRESET_LABEL } from "../camera";
import { lutLabel } from "../lut";
import type { Direction, Section } from "../state";
import { ProVideoCard, type Trim } from "./VideoCard";
import { BackgroundRow } from "./BackgroundRow";
import { MentionTextarea, type MentionRef } from "./MentionTextarea";
import { ModelPicker } from "./ModelPicker";
import { OpenInComfy } from "./OpenInComfy";
import type { ModelOption, Quality } from "../api";
import { AspectPicker, ApertureRing, FocusPanel, GradePanel, LensCarousel, MovePicker } from "./CameraDept";
import { GenerationStatus } from "./GenerationStatus";
import { saveToPhotos } from "../save";

type Mode = "direct" | "recast";

const MODE_COPY: Record<Mode, { title: string; sub: string }> = {
  recast: { title: "Recast", sub: "New characters and places, same performance" },
  direct: { title: "Direct", sub: "Camera moves, lenses and color for your video" },
};

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
const I = {
  video: "M3 7h12v10H3zM15 10l6-3v10l-6-3",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  shirt: "M8 3l4 3 4-3 5 4-3 3v11H6V10L3 7z",
  box: "M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  lens: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  grade: "M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-2 0-3 3 0 4-1 3-2 3-4A9 9 0 0 0 12 3zM7.5 11.5h.01M10 7.5h.01M15 8h.01",
  frame: "M3 6h18v12H3zM3 9h18M3 15h18",
  swap: "M7 7h12l-3-3M17 17H5l3 3",
  depth: "M3 18l6-9 4 5 3-4 5 8z",
};

function Row({ icon, label, value, open, onToggle, enabled, onEnable, children }: { icon: string; label: string; value: string; open: boolean; onToggle: () => void; enabled?: boolean; onEnable?: (on: boolean) => void; children: ReactNode }) {
  const off = enabled === false;
  return (
    <div className={`row-card ${open && !off ? "open" : ""} ${off ? "off" : ""}`}>
      <div className="row-line">
        <button className="row-head" onClick={() => (off && onEnable ? onEnable(true) : onToggle())} aria-expanded={open && !off}>
          <Icon d={icon} />
          <span className="row-text">
            <small>{label}</small>
            <b>{off ? "Off" : value}</b>
          </span>
          {!off && <span className="chev" aria-hidden>›</span>}
        </button>
        {onEnable && (
          <label className="switch" title={`${label} on/off`}>
            <input type="checkbox" checked={!off} onChange={(e) => onEnable(e.target.checked)} aria-label={`${label} on/off`} />
            <i />
          </label>
        )}
      </div>
      {open && !off && <div className="row-body">{children}</div>}
    </div>
  );
}

export function ControlPanel(p: {
  mode: Mode;
  setMode: (m: Mode) => void;
  clip: Clip | null;
  renderPreview: { url: string; label: string } | null;
  onUploadClip: (f: File) => Promise<void>;
  onVideoLink: (url: string) => Promise<boolean>;
  onReplaceVideo: () => void;
  trim: Trim;
  onTrim: (t: Trim) => void;
  keepBackground: boolean;
  setKeepBackground: (v: boolean) => void;
  background: string;
  setBackground: (s: string) => void;
  maxSeconds: number;
  level: "easy" | "pro";
  setLevel: (l: "easy" | "pro") => void;
  models: ModelOption[];
  model: string;
  setModel: (id: string) => void;
  quality: Quality;
  setQuality: (q: Quality) => void;
  lora: string;
  setLora: (id: string) => void;
  useDepth: boolean;
  setUseDepth: (on: boolean) => void;
  costLabel: string | null;
  onPromptOnly: () => void;
  casts: CastCard[];
  onRemoveCast: (id: string) => void;
  onAddCast: (input: { prompt?: string; file?: File; kind: CastCard["kind"] }) => Promise<void>;
  engine: "comfy" | "preview";
  prompt: string;
  setPrompt: (s: string) => void;
  dir: Direction;
  set: (p: Partial<Direction>) => void;
  luts: string[];
  busy: boolean;
  developing: { progress: number; message: string } | null;
  generationError: string | null;
  /** Checklist of the take being generated. */
  steps?: import("../../server/shared").JobStep[];
  onGenerate: () => void;
  depthJob: DepthJob | null;
  showDepth: boolean;
  onToggleDepth: () => void;
  onGenerateDepth: () => void;
  failedRender: Render | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [promptOn, setPromptOn] = useState(!!p.prompt);
  const [uploading, setUploading] = useState(false);
  const [castPrompt, setCastPrompt] = useState("");
  const [castBusy, setCastBusy] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const vid = useRef<HTMLInputElement>(null);
  const img = useRef<HTMLInputElement>(null);
  const addKind = useRef<CastCard["kind"]>("character");
  const pro = p.level === "pro";
  const pick = (k: CastCard["kind"]) => {
    addKind.current = k;
    img.current?.click();
  };
  const toggle = (k: string) => setOpen((o) => (o === k ? null : k));
  const enable = (k: Section, v: boolean) => {
    p.set({ on: { ...p.dir.on, [k]: v } });
    setOpen(v ? k : null);
  };

  const upload = async (f: File) => {
    setUploading(true);
    try {
      await p.onUploadClip(f);
    } finally {
      setUploading(false);
    }
  };
  const addCast = async (input: { prompt?: string; file?: File; kind: CastCard["kind"] }) => {
    setCastBusy(true);
    try {
      await p.onAddCast(input);
      setCastPrompt("");
    } finally {
      setCastBusy(false);
    }
  };
  const drop = (kind: "video" | "image") => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(kind);
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(null);
      const f = e.dataTransfer.files?.[0];
      if (!f) {
        const link = kind === "video" && findVideoLink(e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain"));
        if (link) void p.onVideoLink(link);
        return;
      }
      if (kind === "video" && f.type.startsWith("video/")) void upload(f);
      if (kind === "image" && f.type.startsWith("image/")) void addCast({ file: f, kind: "character" });
    },
  });

  const mentionRefs: MentionRef[] = [
    ...p.casts.filter((c) => c.kind === "character").map((c, i) => ({ tag: `@image${i + 1}`, label: c.prompt, thumb: c.url })),
    ...(p.clip ? [{ tag: "@video", label: "Your video", thumb: p.clip.poster }] : []),
  ];
  const copy = MODE_COPY[p.mode];
  const d = p.dir;

  return (
    <div className="panel">
      <div className="panel-scroll">

        {p.renderPreview && (
          <section className="panel-result-preview" aria-label="Generated video preview">
            <div>
              <b>{p.renderPreview.label}</b>
              <a className="result-dl" href={p.renderPreview.url} download={p.renderPreview.url.split("/").pop()} {...saveToPhotos(p.renderPreview.url, p.renderPreview.url.split("/").pop()!)}><svg viewBox="0 0 24 24" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>Download</a>
            </div>
            <video src={p.renderPreview.url} controls playsInline preload="auto" />
          </section>
        )}

        <div className="mode-hero" style={p.clip ? { backgroundImage: `url(${p.clip.poster})` } : undefined}>
          {pro && (
            <button className="hero-change" onClick={() => p.setMode(p.mode === "recast" ? "direct" : "recast")}>
              <Icon d={I.swap} /> Change
            </button>
          )}
          <div className="mode-hero-text">
            <h2>{copy.title}</h2>
            <p>{copy.sub}</p>
          </div>
        </div>

        {pro && (
          <div className="seg" role="radiogroup" aria-label="Mode">
            <button role="radio" aria-checked={p.mode === "recast"} className={p.mode === "recast" ? "on" : ""} onClick={() => p.setMode("recast")}>
              <Icon d={I.person} /> Recast
            </button>
            <button role="radio" aria-checked={p.mode === "direct"} className={p.mode === "direct" ? "on" : ""} onClick={() => p.setMode("direct")}>
              <Icon d={I.camera} /> Direct
            </button>
          </div>
        )}

        {p.clip ? (
          <div className={`drop-card has ${over === "video" ? "over" : ""}`} {...drop("video")}>
            <ProVideoCard clip={p.clip} trim={p.trim} onTrim={p.onTrim} depthJob={p.depthJob} onReplace={p.onReplaceVideo} maxLen={p.maxSeconds} />
          </div>
        ) : (
          <button className={`drop-card ${over === "video" ? "over" : ""}`} onClick={p.onReplaceVideo} disabled={uploading} {...drop("video")}>
            <span className="drop-icons"><i><Icon d={I.video} /></i></span>
            <b>{uploading ? "Uploading…" : "Add a video"}</b>
            <small>Up to 60 s; you pick up to {p.maxSeconds} s. MOGFIELD measures its camera and subject motion. Or paste a TikTok / Reels / X link (⌘V).</small>
          </button>
        )}
        <input ref={vid} type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
        {!p.clip && <PasteLink onVideoLink={p.onVideoLink} disabled={uploading} />}

        {pro && p.clip && (
          <div className="row-card depth-card">
            {p.clip.depthUrl ? <span className="depth-thumb" aria-hidden /> : <span className="depth-thumb off" aria-hidden><Icon d={I.depth} /></span>}
            <span className="row-text">
              <small>Depth map</small>
              {p.depthJob?.status === "running" ? (
                <>
                  <b>{p.depthJob.message}</b>
                  <span className="depth-bar"><i style={{ width: `${Math.round(p.depthJob.progress * 100)}%` }} /></span>
                </>
              ) : p.clip.depthUrl ? (
                <b>Depth Anything V2 · ready</b>
              ) : (
                <b>{p.depthJob?.status === "failed" ? "Failed, try again" : "Not generated yet"}</b>
              )}
            </span>
            {p.clip.depthUrl && p.depthJob?.status !== "running" ? (
              <label className="switch" title="Show depth on monitor (D)">
                <input type="checkbox" checked={p.showDepth} onChange={p.onToggleDepth} aria-label="Show depth map on monitor" />
                <i />
              </label>
            ) : (
              <button className="small" disabled={p.depthJob?.status === "running"} onClick={p.onGenerateDepth}>
                {p.depthJob?.status === "running" ? `${Math.round(p.depthJob.progress * 100)}%` : "Generate depth map"}
              </button>
            )}
          </div>
        )}

        {p.mode === "recast" && (
          <div className={`drop-card cast ${over === "image" ? "over" : ""}`} {...drop("image")}>
            {p.casts.length ? (
              <div className="ref-list">
                {p.casts.map((c, i) => (
                  <div key={c.id} className="ref-item">
                    <img src={c.url} alt={c.prompt} />
                    <span className="ref-tag">@image{i + 1}</span>
                    <span className="ref-kind">{c.kind === "place" ? "Place" : "Character"}</span>
                    <button className="ref-remove" onClick={() => p.onRemoveCast(c.id)} aria-label={`Remove ${c.prompt}`}>×</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="drop-inner">
                <span className="drop-icons">
                  <i><Icon d={I.person} /></i>
                  <i><Icon d={I.shirt} /></i>
                  <i><Icon d={I.box} /></i>
                </span>
                <b>{castBusy ? "Adding…" : "Add characters and places"}</b>
                <small>Reference images. The first character replaces the main person.</small>
              </div>
            )}
            <div className="ref-add">
              <button disabled={castBusy} onClick={() => pick("character")}>+ Character</button>
              <button disabled={castBusy} onClick={() => pick("place")}>+ Place</button>
            </div>
            {p.engine === "comfy" && (
              <div className="cast-gen">
                <input value={castPrompt} onChange={(e) => setCastPrompt(e.target.value)} placeholder="Or describe a character…" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && castPrompt.trim()) void addCast({ prompt: castPrompt.trim(), kind: "character" }); }} />
                <button disabled={!castPrompt.trim() || castBusy} onClick={() => addCast({ prompt: castPrompt.trim(), kind: "character" })}>Create</button>
              </div>
            )}
            <input ref={img} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void addCast({ file: f, kind: addKind.current }); e.target.value = ""; }} />
          </div>
        )}

        {p.mode === "recast" && <DepthToggle on={p.useDepth} setOn={p.setUseDepth} />}
        {p.mode === "recast" && !p.model.startsWith("h3:") && p.useDepth && <BackgroundRow keep={p.keepBackground} setKeep={p.setKeepBackground} text={p.background} setText={p.setBackground} refs={mentionRefs} />}

        {pro ? (
          <div className={`row-card prompt ${promptOn ? "open" : ""}`}>
            <label className="row-head toggle-row">
              <span className="row-text"><b>Prompt</b></span>
              <span className="switch">
                <input type="checkbox" checked={promptOn} onChange={(e) => setPromptOn(e.target.checked)} />
                <i />
              </span>
            </label>
            {promptOn && (
              <div className="row-body">
                <MentionTextarea value={p.prompt} onChange={p.setPrompt} refs={mentionRefs} rows={3} maxLength={1000} placeholder={p.mode === "recast" ? "@image1 waves at the camera at the end, cinematic mood…" : "Optional notes for the shot"} />
              </div>
            )}
          </div>
        ) : (
          <div className="row-card">
            <div className="row-body top">
              <span className="field-label">Describe the new scene (optional)</span>
              <textarea rows={3} value={p.prompt} onChange={(e) => p.setPrompt(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="A rooftop concert in Tokyo at night, neon, light rain…" />
            </div>
          </div>
        )}

        {p.mode === "recast" && <ModelPicker models={p.models} model={p.model} setModel={p.setModel} quality={p.quality} setQuality={p.setQuality} />}
        {p.mode === "recast" && (() => {
          const loras = p.models.find((m) => m.id === p.model)?.loras;
          return loras ? <LoraPicker loras={loras} lora={p.lora} setLora={p.setLora} /> : null;
        })()}

        {pro && (
          <>
        {p.mode === "direct" && (
          <Row icon={I.camera} label="Camera" value={`${PRESET_LABEL[d.camera]} · ${Math.round(d.cameraStrength * 100)}%`} open={open === "camera"} onToggle={() => toggle("camera")} enabled={d.on.camera} onEnable={(v) => enable("camera", v)}>
            <MovePicker dir={d} set={p.set} />
          </Row>
        )}
        <Row icon={I.lens} label="Lens" value={`${d.lens} · f/${d.fStop}${d.rackFocus ? " · rack" : ""}`} open={open === "lens"} onToggle={() => toggle("lens")} enabled={d.on.lens} onEnable={(v) => enable("lens", v)}>
          <LensCarousel dir={d} set={p.set} />
          <ApertureRing dir={d} set={p.set} />
          <FocusPanel dir={d} set={p.set} />
        </Row>
        <Row icon={I.grade} label="Color" value={d.lut === "none" ? "Natural" : `${lutLabel(d.lut)} · ${Math.round(d.lutStrength * 100)}%`} open={open === "color"} onToggle={() => toggle("color")} enabled={d.on.color} onEnable={(v) => enable("color", v)}>
          <GradePanel dir={d} set={p.set} luts={p.luts} poster={p.clip?.poster} />
        </Row>
        <Row icon={I.frame} label="Frame" value={d.aspect === "0.5625" ? "9:16 vertical" : d.aspect === "1.78" ? "16:9" : `${d.aspect}:1`} open={open === "frame"} onToggle={() => toggle("frame")} enabled={d.on.frame} onEnable={(v) => enable("frame", v)}>
          <AspectPicker dir={d} set={p.set} />
        </Row>
          </>
        )}
      </div>

      <div className="panel-foot">
        <GenerationStatus progress={p.developing} error={p.generationError ?? p.failedRender?.error ?? (p.failedRender ? p.failedRender.message : null)} steps={p.steps} />
        <button className="generate" disabled={!p.clip || p.busy} onClick={p.onGenerate} title="Generate (G)">
          {p.busy ? "Working…" : p.mode === "recast" && p.costLabel ? `Generate · ${p.costLabel}` : "Generate"}
        </button>
        <OpenInComfy settings={() => ({ tool: "swap", mode: p.mode, model: p.model, quality: p.quality, prompt: p.prompt, characters: p.casts.filter((c) => c.kind === "character").length || 1, seconds: p.trim.end - p.trim.start, aspect: p.clip && p.clip.width < p.clip.height ? "9:16" : "16:9" })} />
        {p.mode === "recast" && (
          <button className="ghost prompt-only" onClick={p.onPromptOnly} disabled={!p.clip || p.busy}>
            Copy the prompt only (no generation)
          </button>
        )}
      </div>
    </div>
  );
}
