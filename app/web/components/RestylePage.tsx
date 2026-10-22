import { useRef, useState } from "react";
import type { CastCard, Clip, Render } from "../../server/shared";
import { estimateUsd, formatUsd } from "../../server/providers/pricing";
import { api, type ModelOption, type Quality } from "../api";
import { saveToPhotos } from "../save";
import { AbButton } from "./AbButton";
import { EasyVideoCard, type Trim } from "./VideoCard";

const MAX_CHARACTERS = 4;

/** Seedance 2.0 reads the depth map without the Genjustsu prep that 2.5 needs. */
const RESTYLE_MODELS = /seedance-2-0/;

const STYLES: { label: string; text: string }[] = [
  { label: "Photoreal", text: "Photoreal live-action cinema: natural skin texture, real materials, filmic grain, soft cinematic lighting." },
  { label: "Claymation", text: "Handmade claymation stop-motion: visible fingerprints in the clay, slightly stepped 12 fps motion, miniature handmade set." },
  { label: "Watercolor", text: "Loose watercolor painting in motion: soft bleeding edges, paper texture, washed pastel colors." },
  { label: "Anime-inspired", text: "Original hand-drawn 2D anime-inspired animation: clean line art, cel shading, painted backgrounds." },
  { label: "3D animated", text: "Stylized 3D animated feature film: soft rounded shapes, expressive faces, warm global illumination." },
  { label: "Film noir", text: "1940s film noir: high-contrast black and white, hard shadows through blinds, smoky atmosphere." },
  { label: "Cyberpunk", text: "Neon cyberpunk: rain-slick surfaces, magenta and cyan neon signs, holograms, dense futuristic city." },
  { label: "1970s film", text: "1970s 35 mm film look: warm faded colors, heavy grain, soft halation, period wardrobe and set dressing." },
  { label: "Oil painting", text: "Moving oil painting: thick visible brushstrokes, rich impasto texture, painterly light." },
  { label: "Comic ink", text: "Inked comic-book look: bold black outlines, halftone dots, flat vivid colors." },
];

/** Restyle: keep the take's motion (its depth map), change who is in it, the
 *  world they are in and the visual style. */
export function RestylePage(p: {
  clip: Clip | null;
  trim: Trim;
  onTrim: (t: Trim) => void;
  onPickVideo: () => void;
  images: CastCard[];
  onNewImage: (card: CastCard) => void;
  models: ModelOption[];
  renders: Render[];
  clips: Clip[];
  say: (m: string) => void;
  onStart: (o: { castIds: string[]; style: string; scene?: string; model: string; quality: Quality; trim?: Trim }) => Promise<void>;
}) {
  const options = p.models.filter((m) => m.available && RESTYLE_MODELS.test(m.id));
  const [modelId, setModelId] = useState("");
  const model = options.find((m) => m.id === modelId) ?? options[0];
  const [quality, setQuality] = useState<Quality>("480p");
  const q: Quality = model?.qualities.includes(quality) ? quality : (model?.qualities[0] ?? "480p");
  const [picked, setPicked] = useState<string[]>([]);
  const [style, setStyle] = useState(STYLES[1].text);
  const [scene, setScene] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const maxSeconds = model?.maxSeconds ?? 15;
  const trim = p.clip ? { start: p.trim.start, end: Math.min(p.trim.end, p.trim.start + maxSeconds) } : p.trim;
  const seconds = trim.end - trim.start;
  const requestTrim = p.clip && seconds < p.clip.duration - 0.05 ? trim : undefined;
  const cost = p.clip && model ? estimateUsd(model.pricing, { seconds, quality: q, aspect: p.clip.width / p.clip.height, inputVideos: 1 }) : null;
  const takes = p.renders.filter((r) => r.params.style && !r.params.reshoot).slice(0, 6);

  const toggle = (id: string) => setPicked((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : xs.length >= MAX_CHARACTERS ? xs : [...xs, id]));

  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/")).slice(0, MAX_CHARACTERS);
    if (!imgs.length) return;
    setUploading(true);
    try {
      for (const f of imgs) {
        const card = await api.cast({ file: f, kind: "character", saved: true });
        p.onNewImage(card);
        setPicked((xs) => (xs.length >= MAX_CHARACTERS || xs.includes(card.id) ? xs : [...xs, card.id]));
      }
    } catch (e) {
      p.say((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const start = async () => {
    if (!p.clip || !model || !style.trim() || busy) return;
    setBusy(true);
    try {
      await p.onStart({ castIds: picked, style: style.trim(), scene: scene.trim() || undefined, model: model.id, quality: q, trim: requestTrim });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cs-page">
      <header className="cs-head">
        <div>
          <h2>Restyle</h2>
          <p>Keep the motion of your video, change everything else: who is in it, the world around them and the visual style.</p>
        </div>
      </header>
      <div className="cs-grid">
        <section className="cs-card">
          <h3><span className="cs-num">1</span> Take</h3>
          {p.clip ? (
            <EasyVideoCard clip={p.clip} trim={trim} onTrim={p.onTrim} onReplace={p.onPickVideo} maxLen={maxSeconds} />
          ) : (
            <button className="rs-empty" onClick={p.onPickVideo}>Add a video</button>
          )}
          <small className="cs-hint">Up to {maxSeconds} s. Only its depth map goes to the model: the motion and layout carry over, the look does not.</small>
        </section>

        <section className="cs-card">
          <h3><span className="cs-num">2</span> Characters</h3>
          <div
            className={`tv-refs st-drop ${dragOver ? "over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void addFiles(Array.from(e.dataTransfer.files));
            }}
          >
            <button className="cs-ref add" onClick={() => file.current?.click()} disabled={uploading} aria-label="Add a character picture">{uploading ? "…" : "+"}</button>
            {p.images.slice(0, 24).map((img) => (
              <button key={img.id} className={`cs-ref tv-ref ${picked.includes(img.id) ? "on" : ""}`} onClick={() => toggle(img.id)} title={img.prompt} aria-pressed={picked.includes(img.id)}>
                <img src={img.url} alt={img.prompt} />
                {picked.includes(img.id) && <span className="tv-badge">{picked.indexOf(img.id) + 1}</span>}
              </button>
            ))}
          </div>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => void addFiles(Array.from(e.target.files ?? []))} />
          <small className="cs-hint">Drop pictures here or tap to pick, up to {MAX_CHARACTERS}. Number 1 becomes the main person in the video, the others follow in order. Optional: without characters the people are restyled in the chosen style.</small>

          <label className="rs-field">
            <span>Style</span>
            <div className="st-chips">
              {STYLES.map((s) => (
                <button key={s.label} className={style === s.text ? "on" : ""} onClick={() => setStyle(s.text)}>{s.label}</button>
              ))}
            </div>
            <textarea rows={3} value={style} onChange={(e) => setStyle(e.target.value)} placeholder="The look of the whole shot: medium, materials, colors, era" />
          </label>
          <label className="rs-field">
            <span>What you want to see</span>
            <textarea rows={4} value={scene} onChange={(e) => setScene(e.target.value)} placeholder="The world and what happens in it, e.g. a rainy neon night market, lanterns swinging, steam from food stalls" />
          </label>
        </section>

        <section className="cs-card">
          <h3><span className="cs-num">3</span> Film it</h3>
          {options.length ? (
            <>
              <div className="rs-seg" role="radiogroup" aria-label="Model">
                {options.map((m) => (
                  <button key={m.id} role="radio" aria-checked={model?.id === m.id} className={model?.id === m.id ? "on" : ""} onClick={() => setModelId(m.id)}>{m.label}</button>
                ))}
              </div>
              <div className="rs-seg" role="radiogroup" aria-label="Quality">
                {(model?.qualities ?? []).map((x) => (
                  <button key={x} role="radio" aria-checked={q === x} className={q === x ? "on" : ""} onClick={() => setQuality(x)}>{x}</button>
                ))}
              </div>
              <button className="accent rs-go" disabled={!p.clip || !style.trim() || busy} onClick={start}>
                {busy ? "Starting…" : `Restyle${cost !== null ? ` · ${formatUsd(cost)}` : ""}`}
              </button>
            </>
          ) : (
            <small className="cs-hint">Restyle needs Seedance 2.0 on the Comfy API. Add COMFY_API_KEY to app/.env.</small>
          )}

          {takes.length > 0 && (
            <div className="rs-takes">
              {takes.map((r) => (
                <div key={r.id} className="rs-take">
                  {r.status === "succeeded" && r.url ? (
                    <video src={r.url} muted loop playsInline autoPlay controls />
                  ) : (
                    <div className="rs-wait">
                      <span>{r.status === "failed" ? "Failed" : r.message || "Queued"}</span>
                      {r.status !== "failed" && <span className="depth-bar"><i style={{ width: `${Math.round((r.progress ?? 0) * 100)}%` }} /></span>}
                    </div>
                  )}
                  <div className="rs-take-meta">
                    <b title={r.params.style}>{STYLES.find((s) => s.text === r.params.style)?.label ?? "Custom style"}</b>
                    {r.status === "succeeded" && r.url ? (
                      <span className="tv-take-actions">
                      <a className="btn small" href={r.url} download={`mogfield-restyle-${r.take}.mp4`} {...saveToPhotos(r.url, `mogfield-restyle-${r.take}.mp4`)}>Save</a>
                      {r.workflowUrl && <a className="btn small" href={r.workflowUrl} download={`mogfield-restyle-${r.take}.workflow.json`} title="The ComfyUI workflow this take ran: drop it into ComfyUI to run it again">Workflow</a>}
                        <AbButton render={r} clip={p.clips.find((c) => c.id === r.params.clipId)} say={p.say} />
                      </span>
                    ) : r.status === "failed" ? (
                      <small title={r.error}>{(r.error ?? "").slice(0, 80)}</small>
                    ) : (
                      <small>{Math.round((r.progress ?? 0) * 100)}%</small>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
