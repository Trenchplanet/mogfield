import { useRef, useState } from "react";
import { PasteLink } from "./PasteLink";
import { LoraToggle } from "./LoraRow";
import { DepthToggle } from "./DepthToggle";
import { findVideoLink, type CastCard, type Clip } from "../../server/shared";
import type { ModelOption, Quality } from "../api";
import { DRAG_TYPE, readDrag, type DragItem } from "./Library";
import { EasyVideoCard, type Trim } from "./VideoCard";
import { BackgroundRow } from "./BackgroundRow";
import { MentionTextarea, type MentionRef } from "./MentionTextarea";
import { ModelPicker } from "./ModelPicker";
import { GenerationStatus } from "./GenerationStatus";
import { saveToPhotos } from "../save";

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
const I = {
  video: "M3 7h12v10H3zM15 10l6-3v10l-6-3",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  shirt: "M8 3l4 3 4-3 5 4-3 3v11H6V10L3 7z",
  box: "M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10",
  check: "M5 12l5 5L20 7",
  plus: "M12 5v14M5 12h14",
};

const MAX_CHARACTERS = 4;

export function EasyPanel(p: {
  clip: Clip | null;
  renderPreview: { url: string; label: string } | null;
  onUploadClip: (f: File) => Promise<void>;
  onVideoLink: (url: string) => Promise<boolean>;
  characters: CastCard[];
  onAddCharacter: (f: File) => Promise<void>;
  onRemoveCharacter: (id: string) => void;
  models: ModelOption[];
  model: string;
  setModel: (id: string) => void;
  quality: Quality;
  setQuality: (q: Quality) => void;
  lora: string;
  setLora: (id: string) => void;
  useDepth: boolean;
  setUseDepth: (on: boolean) => void;
  busy: boolean;
  developing: { progress: number; message: string } | null;
  generationError: string | null;
  /** Checklist of the take being generated. */
  steps?: import("../../server/shared").JobStep[];
  onGenerate: () => void;
  onPro: () => void;
  onOpenLibrary: (target: "video" | "image") => void;
  onDropItem: (item: DragItem) => void;
  trim: Trim;
  onTrim: (t: Trim) => void;
  uploadPct: number | null;
  prompt: string;
  setPrompt: (s: string) => void;
  promptOn: boolean;
  setPromptOn: (on: boolean) => void;
  keepBackground: boolean;
  setKeepBackground: (v: boolean) => void;
  background: string;
  setBackground: (s: string) => void;
  maxSeconds: number;
  costLabel: string | null;
}) {
  const refs: MentionRef[] = [
    ...p.characters.map((c, i) => ({ tag: `@image${i + 1}`, label: c.prompt, thumb: c.url })),
    ...(p.clip ? [{ tag: "@video", label: "Your video", thumb: p.clip.poster }] : []),
  ];
  const vid = useRef<HTMLInputElement>(null);
  const img = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState<"video" | "image" | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const upload = async (f: File) => {
    setUploading(true);
    try {
      await p.onUploadClip(f);
    } finally {
      setUploading(false);
    }
  };
  const addImages = async (files: FileList | File[]) => {
    setAdding(true);
    try {
      for (const f of Array.from(files).slice(0, MAX_CHARACTERS - p.characters.length)) if (f.type.startsWith("image/")) await p.onAddCharacter(f);
    } finally {
      setAdding(false);
    }
  };
  const dropProps = (kind: "video" | "image") => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(DRAG_TYPE) && !(kind === "video" && e.dataTransfer.types.includes("text/uri-list"))) return;
      e.preventDefault();
      setOver(kind);
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(null);
      const item = readDrag(e);
      if (item) {
        if ((kind === "video") === (item.type === "clip")) p.onDropItem(item);
        return;
      }
      const files = e.dataTransfer.files;
      if (!files?.length) {
        const link = kind === "video" && findVideoLink(e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain"));
        if (link) void p.onVideoLink(link);
        return;
      }
      if (kind === "video" && files[0].type.startsWith("video/")) void upload(files[0]);
      if (kind === "image") void addImages(files);
    },
  });

  const current = p.models.find((m) => m.id === p.model) ?? p.models[0];
  const h3 = !!current?.id.startsWith("h3:"); // H3 swap keeps the scene as it is
  const needsCharacter = current?.inputMode !== "text-only" && current?.inputMode !== "text-image";
  const ready = !!p.clip && (!needsCharacter || p.characters.length > 0) && !!current?.available;
  const reason = !p.clip ? "Add a video" : needsCharacter && !p.characters.length ? "Add at least one character" : current && !current.available ? `${current.label} isn't connected yet` : null;

  return (
    <div className="panel easy" ref={panel}>
      <div className="panel-tabs">
        <button className="on">Create</button>
        <button onClick={p.onPro}>Pro</button>
      </div>

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
          <div className="mode-hero-text">
            <h2 className="wordmark">MOGFIELD</h2>
            <p>Motion Transfer · Character Swap</p>
          </div>
        </div>

        {p.clip ? (
          <div className={`drop-card big has ${over === "video" ? "over" : ""}`} {...dropProps("video")}>
            <EasyVideoCard clip={p.clip} trim={p.trim} onTrim={p.onTrim} onReplace={() => p.onOpenLibrary("video")} maxLen={p.maxSeconds} />
          </div>
        ) : (
          <button className={`drop-card big ${over === "video" ? "over" : ""}`} onClick={() => p.onOpenLibrary("video")} disabled={uploading} {...dropProps("video")}>
            <span className="drop-icons"><i><Icon d={I.video} /></i></span>
            <b>{p.uploadPct !== null ? (p.uploadPct < 1 ? `Uploading ${Math.round(p.uploadPct * 100)}%` : "Processing video…") : "Add a video to extract motion"}</b>
            {p.uploadPct !== null ? <span className="tile-bar wide"><i style={{ width: `${Math.round(p.uploadPct * 100)}%` }} /></span> : <small>Up to 60 s; you pick up to {p.maxSeconds} s. Or paste a TikTok / Reels / X link (⌘V)</small>}
          </button>
        )}
        <input ref={vid} type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
        {!p.clip && <PasteLink onVideoLink={p.onVideoLink} disabled={p.uploadPct !== null} />}

        <div className={`drop-card big chars ${over === "image" ? "over" : ""}`} {...dropProps("image")}>
          {p.characters.length ? (
            <div className="char-grid">
              {p.characters.map((c) => (
                <div key={c.id} className="char">
                  <img src={c.url} alt={c.prompt} />
                  <button className="char-x" onClick={() => p.onRemoveCharacter(c.id)} aria-label={`Remove ${c.prompt}`}>×</button>
                </div>
              ))}
              {p.characters.length < MAX_CHARACTERS && (
                <button className="char add" onClick={() => p.onOpenLibrary("image")} disabled={adding} aria-label="Add character">
                  <Icon d={I.plus} size={20} />
                </button>
              )}
            </div>
          ) : (
            <button className="drop-inner" onClick={() => p.onOpenLibrary("image")} disabled={adding}>
              <span className="drop-icons">
                <i><Icon d={I.person} /></i>
                <i><Icon d={I.shirt} /></i>
                <i><Icon d={I.box} /></i>
              </span>
              <b>{adding ? "Adding…" : "Add your characters"}</b>
              <small>Up to {MAX_CHARACTERS} images</small>
            </button>
          )}
          <input ref={img} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { if (e.target.files) void addImages(e.target.files); e.target.value = ""; }} />
        </div>
        {current?.inputMode === "text-image" && <small className="hint-text">Character images are optional visual references for H3. The source video is not sent.</small>}

        {!h3 && p.useDepth && <BackgroundRow keep={p.keepBackground} setKeep={p.setKeepBackground} text={p.background} setText={p.setBackground} refs={refs} />}

        {current?.inputMode !== "text-only" && current?.inputMode !== "text-image" && <DepthToggle on={p.useDepth} setOn={p.setUseDepth} />}

        <div className={`row-card prompt ${p.promptOn ? "open" : ""}`}>
          <label className="row-head toggle-row">
            <span className="row-text">
              <b>Prompt</b>
              {!p.promptOn && <small>Optional: add your own direction</small>}
            </span>
            <span className="switch">
              <input type="checkbox" checked={p.promptOn} onChange={(e) => p.setPromptOn(e.target.checked)} aria-label="Prompt on/off" />
              <i />
            </span>
          </label>
          {p.promptOn && (
            <div className="row-body">
              <MentionTextarea value={p.prompt} onChange={p.setPrompt} refs={refs} rows={3} maxLength={500} placeholder="@image1 waves at the camera at the end, cinematic mood…" autoFocus />
              <small className="hint-text">{current?.inputMode === "text-only" ? "LTX gets your written prompt and motion notes; the source video and character images are not sent." : current?.inputMode === "text-image" ? "H3 gets your prompt, optional character images and approximate motion notes. The source video is not sent; H3 generates its own audio." : "Added to MOGFIELD's prompt. Type @ to point at a character or your video. Motion and camera still come from your video."}</small>
            </div>
          )}
        </div>

        <ModelPicker models={p.models} model={p.model} setModel={p.setModel} quality={p.quality} setQuality={p.setQuality} />
        {current?.loras && <LoraToggle loras={current.loras} lora={p.lora} setLora={p.setLora} />}
      </div>

      <div className="panel-foot">
        <GenerationStatus progress={p.developing} error={p.generationError} steps={p.steps} />
        <button className="generate" disabled={!ready || p.busy} onClick={p.onGenerate} title={reason ?? "Generate (G)"}>
          {p.busy ? "Generating…" : p.costLabel ? `Generate · ${p.costLabel}` : "Generate"}
        </button>
        {reason && !p.busy && <small className="foot-note">{reason}{current && !current.available && p.clip && p.characters.length ? `: ${current.needs}` : ""}</small>}
        {!reason && !p.busy && p.costLabel && <small className="foot-note">Estimate from Comfy's published rates; the API's charge is final.</small>}
      </div>
    </div>
  );
}
