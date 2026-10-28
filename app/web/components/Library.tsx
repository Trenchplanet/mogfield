import { useEffect, useRef, useState } from "react";
import type { CastCard, Clip, Render } from "../../server/shared";
import { PasteLink } from "./PasteLink";

/** Drag payload between the library and the Create drop zones. */
export const DRAG_TYPE = "application/x-mogfield";
export type DragItem = { type: "clip" | "image"; id: string };

export function readDrag(e: React.DragEvent): DragItem | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    return raw ? (JSON.parse(raw) as DragItem) : null;
  } catch {
    return null;
  }
}

type Tab = "uploads" | "characters" | "generations";
type Filter = "all" | "videos" | "images";

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
const UPLOAD = "M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 7a4.5 4.5 0 0 1 .5 9M12 12v9M8.5 15.5 12 12l3.5 3.5";
const STAR = "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z";
const CHECK = "M5 12l5 5L20 7";
const TRASH = "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13";

export function Library(p: {
  target: "video" | "image";
  clips: Clip[]; // uploaded videos (no samples)
  images: CastCard[];
  renders: Render[];
  selectedClip: string | null;
  selectedImages: string[];
  onPickClip: (id: string) => void;
  onToggleImage: (card: CastCard) => void;
  onUpload: (files: File[], saveAsCharacter: boolean) => Promise<void>;
  onSave: (id: string, saved: boolean) => void;
  onDelete: (id: string) => void;
  onOpenRender: (id: string) => void;
  onClose: () => void;
  onMakeCharacter: () => void;
  /** A TikTok / Instagram / X link to download as a new video; resolves false when it failed. */
  onVideoLink: (url: string) => Promise<boolean>;
  uploadPct: number | null;
}) {
  const [tab, setTab] = useState<Tab>(p.target === "image" ? "characters" : "uploads");
  const [filter, setFilter] = useState<Filter>(p.target === "video" ? "videos" : "images");
  const [sort, setSort] = useState<"new" | "old">("new");
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      await p.onUpload(files, tab === "characters");
    } finally {
      setBusy(false);
    }
  };

  const by = <T extends { createdAt: number }>(xs: T[]) => [...xs].sort((a, b) => (sort === "new" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));
  const showVideos = tab === "uploads" && filter !== "images";
  const showImages = (tab === "uploads" && filter !== "videos") || tab === "characters";
  const images = by(tab === "characters" ? p.images.filter((i) => i.saved) : p.images);
  const clips = showVideos ? by(p.clips) : [];
  const renders = tab === "generations" ? by(p.renders.filter((r) => r.status === "succeeded")) : [];
  const accept = tab === "characters" ? "image/png,image/jpeg,image/webp" : filter === "videos" ? "video/*" : filter === "images" ? "image/png,image/jpeg,image/webp" : "video/*,image/png,image/jpeg,image/webp";
  const aspectOf = (clipId: string) => {
    const c = p.clips.find((x) => x.id === clipId);
    return c ? c.width / c.height : 9 / 16;
  };
  const empty = !clips.length && !(showImages && images.length) && !renders.length;

  const drag = (item: DragItem) => (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div className="library" role="dialog" aria-label="Library">
      <div className="lib-head">
        <div className="pill-tabs left" role="tablist">
          {(["uploads", "characters", "generations"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "uploads" ? "Uploads" : t === "characters" ? "Characters" : "Generations"}
            </button>
          ))}
        </div>
        <button className="lib-close" onClick={p.onClose} aria-label="Close library">×</button>
      </div>

      <div
        className={`lib-body ${over ? "over" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void upload(Array.from(e.dataTransfer.files ?? []));
        }}
      >
        <div className="lib-bar">
          {tab === "uploads" ? (
            <div className="chip-row">
              {(["all", "videos", "images"] as Filter[]).map((f) => (
                <button key={f} className={`opt ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "videos" ? "Videos" : "Images"}
                </button>
              ))}
            </div>
          ) : (
            <span className="lib-hint">{tab === "characters" ? <><span className="hint-desk">Saved characters. Drag one onto Add your characters, or paste an image (⌘V).</span><span className="hint-touch">Saved characters. Tap one to add it.</span></> : "Your finished videos."}</span>
          )}
          <button className="ghost lib-sort" onClick={() => setSort(sort === "new" ? "old" : "new")}>
            {sort === "new" ? "Newest first" : "Oldest first"}
          </button>
        </div>

        <div className="lib-grid">
          {tab === "characters" && (
            <button className="lib-tile upload make" onClick={p.onMakeCharacter}>
              <span className="up-icon"><Icon d={STAR} size={22} /></span>
              <b>Make a character</b>
              <small>Picture → reference sheet</small>
            </button>
          )}
          {tab !== "generations" && (
            <button className="lib-tile upload" onClick={() => file.current?.click()} disabled={busy}>
              <span className="up-icon"><Icon d={UPLOAD} size={22} /></span>
              <b>{busy ? (p.uploadPct !== null && p.uploadPct < 1 ? `Uploading ${Math.round(p.uploadPct * 100)}%` : "Processing…") : tab === "characters" ? "Upload a sheet" : "Upload media"}</b>
              {busy && <span className="tile-bar"><i style={{ width: `${Math.round((p.uploadPct ?? 1) * 100)}%` }} /></span>}
            </button>
          )}
          {tab === "uploads" && filter !== "images" && <PasteLink tile onVideoLink={p.onVideoLink} disabled={busy} />}
          <input ref={file} type="file" accept={accept} multiple hidden onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />

          {clips.map((c) => (
            <div key={c.id} className={`lib-tile media ${p.selectedClip === c.id ? "on" : ""}`} style={{ ["--ar" as string]: String(c.width / c.height) }} draggable onDragStart={drag({ type: "clip", id: c.id })}>
              <button className="lib-pick" onClick={() => p.onPickClip(c.id)} aria-label={`Use ${c.name}`}>
                <video src={c.url} poster={c.poster} muted loop autoPlay playsInline preload="metadata" draggable={false} />
              </button>
              <span className="lib-badge">{c.duration.toFixed(0)}s</span>
              {p.selectedClip === c.id && <span className="lib-check"><Icon d={CHECK} size={14} /></span>}
              <span className="lib-name">{c.name}</span>
            </div>
          ))}

          {showImages &&
            images.map((img) => {
              const on = p.selectedImages.includes(img.id);
              return (
                <div key={img.id} className={`lib-tile media ${on ? "on" : ""}`} draggable onDragStart={drag({ type: "image", id: img.id })}>
                  <button className="lib-pick" onClick={() => p.onToggleImage(img)} aria-label={`${on ? "Remove" : "Use"} ${img.prompt}`} aria-pressed={on}>
                    <img src={img.url} alt="" draggable={false} />
                  </button>
                  {on && <span className="lib-check"><Icon d={CHECK} size={14} /></span>}
                  <div className="lib-actions">
                    <button className={`lib-act ${img.saved ? "starred" : ""}`} onClick={() => p.onSave(img.id, !img.saved)} title={img.saved ? "Remove from characters" : "Save as character"} aria-label={img.saved ? "Remove from characters" : "Save as character"}>
                      <Icon d={STAR} size={14} />
                    </button>
                    <button className="lib-act" onClick={() => p.onDelete(img.id)} title="Delete" aria-label="Delete image">
                      <Icon d={TRASH} size={14} />
                    </button>
                  </div>
                  <span className="lib-name">{img.prompt}</span>
                </div>
              );
            })}

          {renders.map((r) => (
            <button key={r.id} className="lib-tile media" style={{ ["--ar" as string]: String(aspectOf(r.params.clipId)) }} onClick={() => p.onOpenRender(r.id)}>
              <video src={r.url} muted loop autoPlay playsInline preload="metadata" />
              <span className="lib-name">Video {r.take}</span>
            </button>
          ))}
        </div>
        {empty && tab === "generations" && <p className="lib-empty">Nothing generated yet.</p>}
        {over && <div className="lib-drop">Drop to upload</div>}
      </div>
    </div>
  );
}
