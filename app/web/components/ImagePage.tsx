import { useRef, useState } from "react";
import { T2V_ASPECTS, type CastCard, type T2vAspect } from "../../server/shared";
import { api, type CatalogModel } from "../api";
import { saveToPhotos } from "../save";
import { CatalogList, useCatalog } from "./VideoPage";

const MAX_REFS = 4;
/** The default: Nano Banana 2.1, the same model that draws character boards. */
const DEFAULT = { id: "vertexai/gemini-nano-banana-2.1", label: "Nano Banana 2.1", line: "Google · text + up to 4 pictures · sharp, faithful edits" };

/**
 * Create Image: a picture from a prompt, optionally guided by up to four of
 * your pictures. With the API switch on, every image model in the Comfy API
 * catalog can make it. Pictures land in your library, ready for Video or
 * Create Character.
 */
export function ImagePage(p: { images: CastCard[]; apiMode: boolean; say: (m: string) => void; onNewImage: (c: CastCard) => void; onMakeCharacter: () => void }) {
  const catalog = useCatalog(p.apiMode, "image");
  const [other, setOther] = useState<CatalogModel | null>(null);
  const picked = p.apiMode ? other : null;
  const [picking, setPicking] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [refs, setRefs] = useState<string[]>([]);
  const [aspect, setAspect] = useState<T2vAspect>("9:16");
  const [busy, setBusy] = useState(0);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const made = p.images.filter((i) => / \(image\)$/.test(i.prompt));

  const upload = async (f: File) => {
    setUploading(true);
    try {
      const card = await api.cast({ file: f, kind: "character", saved: true });
      p.onNewImage(card);
      setRefs((xs) => (xs.length >= MAX_REFS ? xs : [...xs, card.id]));
    } catch (e) {
      p.say((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  // several pictures can be on their way at once
  const go = async () => {
    if (!prompt.trim()) return;
    setBusy((n) => n + 1);
    try {
      const card = await api.image({ prompt: prompt.trim(), model: picked?.id ?? DEFAULT.id, imageIds: refs, aspect });
      p.onNewImage(card);
    } catch (e) {
      p.say((e as Error).message);
    } finally {
      setBusy((n) => n - 1);
    }
  };

  return (
    <div className="vp">
      <aside className="vp-panel">
        <div className="vp-body">
          <div className="vp-model">
            <div className="vp-model-head">
              <span><b>{picked?.label ?? DEFAULT.label}</b><small>{picked ? `${picked.provider} · ${picked.inputs.includes("image") ? "text + pictures" : "text only"}` : DEFAULT.line}</small></span>
              {p.apiMode && <button className="small" onClick={() => setPicking((x) => !x)}>{picking ? "Done" : "Change"}</button>}
            </div>
            {picking && (
              <div className="vp-model-list">
                <button className={!picked ? "on" : ""} onClick={() => { setOther(null); setPicking(false); }}><b>{DEFAULT.label}</b><small>{DEFAULT.line}</small></button>
                <CatalogList title="All Comfy API image models" list={catalog} current={picked?.id ?? null} onPick={(m) => { setOther(m); setPicking(false); }} />
              </div>
            )}
          </div>
          <label className="vp-field">
            <span className="vp-label">Prompt</span>
            <textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="What picture do you want? e.g. a rain-soaked neon alley at night, a woman in a yellow raincoat looking back, 35 mm film still" />
          </label>
          <div className="vp-refs">
            <span className="vp-label">Reference pictures <small>(optional, up to {MAX_REFS})</small></span>
            <div className="vp-ref-row">
              <button className="vp-ref add" onClick={() => file.current?.click()} disabled={uploading} aria-label="Add a reference picture">{uploading ? "…" : "+"}</button>
              {p.images.slice(0, 16).map((img) => (
                <button key={img.id} className={`vp-ref ${refs.includes(img.id) ? "on" : ""}`} title={img.prompt} aria-pressed={refs.includes(img.id)} onClick={() => setRefs((xs) => (xs.includes(img.id) ? xs.filter((x) => x !== img.id) : xs.length >= MAX_REFS ? xs : [...xs, img.id]))}>
                  <img src={img.url} alt={img.prompt} />
                  {refs.includes(img.id) && <span>{refs.indexOf(img.id) + 1}</span>}
                </button>
              ))}
            </div>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { if (e.target.files?.[0]) void upload(e.target.files[0]); e.target.value = ""; }} />
          </div>
          {picked && !picked.inputs.includes("image") && refs.length > 0 && <small className="vp-warn">{picked.label} takes text only: the pictures are left out.</small>}
          <div className="vp-chips">
            <label className="vp-chip">
              <span>Shape</span>
              <select value={aspect} onChange={(e) => setAspect(e.target.value as T2vAspect)}>
                {(Object.keys(T2V_ASPECTS) as T2vAspect[]).map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="vp-foot">
          <button className="vp-go" disabled={!prompt.trim()} onClick={go}>{busy ? `Making ${busy > 1 ? `${busy} pictures` : "the picture"}…` : "Create image"}</button>
        </div>
      </aside>

      <section className="vp-main">
        <div className="vp-main-tabs"><button className="on">Your images</button></div>
        {!made.length && !busy ? (
          <div className="vp-empty">Nothing yet. Pictures you create land here and in your library.</div>
        ) : (
          <div className="vp-grid">
            {Array.from({ length: busy }, (_, i) => (
              <div key={`wait-${i}`} className="vp-take">
                <div className="vp-wait" style={{ aspectRatio: String(T2V_ASPECTS[aspect]) }}><span>Drawing…</span></div>
              </div>
            ))}
            {made.map((img) => (
              <div key={img.id} className="vp-take">
                <img className="ip-img" src={img.url} alt={img.prompt} />
                <div className="vp-take-meta">
                  <small title={img.prompt}>{img.prompt.replace(/ \(image\)$/, "")}</small>
                  <span className="vp-actions">
                    <a className="btn small" href={img.url} download={`mogfield-image-${img.id}.png`} {...saveToPhotos(img.url, `mogfield-image-${img.id}.png`)}>Save</a>
                    <button className="small" onClick={() => setRefs((xs) => (xs.includes(img.id) || xs.length >= MAX_REFS ? xs : [...xs, img.id]))} title="Use this picture as a reference for the next one">Use as reference</button>
                    <button className="small" onClick={p.onMakeCharacter} title="Open Create Character: pick this picture under “Or start from one of yours”">Make character</button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
