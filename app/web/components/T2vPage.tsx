import { useEffect, useRef, useState } from "react";
import { T2V_ASPECTS, type CastCard, type T2vAspect, type T2vTake } from "../../server/shared";
import { estimateUsd, formatUsd } from "../../server/providers/pricing";
import { api, type ModelOption, type Quality } from "../api";
import { saveToPhotos } from "../save";

const MAX_IMAGES = 4;

/** The structure that works for Seedance: one shot, a fixed hero, a timed beat sheet. */
const TEMPLATE = (seconds: number, aspect: string) => `A single continuous ${seconds}-second ${aspect === "9:16" ? "vertical 9:16" : aspect} cinematic shot, photoreal, shot on a large-format digital cinema camera with anamorphic lenses, 24 fps, filmic grain.

THE HERO: [who or what from the reference image, exactly as designed there: shape, colors, materials, details to keep in every frame].

THE WORLD: [the place, time of day, weather and mood; the key set pieces and background action].

ACTION AND TIMING (one take, no cuts):
0–${Math.round(seconds / 4)} s: [opening move and what the camera does]
${Math.round(seconds / 4)}–${Math.round(seconds / 2)} s: [the first big beat]
${Math.round(seconds / 2)}–${Math.round((seconds * 3) / 4)} s: [the escalation]
${Math.round((seconds * 3) / 4)}–${seconds} s: [the final image to end on]

LIGHT AND COLOUR: [key light, fill, practicals, grade].

CAMERA FEEL: [Steadicam, crane, handheld energy, lens flares, shake on impacts].

QUALITY: hyper-detailed textures, physically accurate light, smoke and motion, realistic scale, no text overlays.

Avoid: text, captions, watermarks, logos, warped or melting geometry, the hero changing design or color, cuts or scene changes.`;

/** Text to video: a new shot from a detailed prompt and up to 4 reference images. */
export function T2vPage(p: { images: CastCard[]; models: ModelOption[]; onNewImage: (card: CastCard) => void; say: (m: string) => void }) {
  const options = p.models.filter((m) => m.available && /seedance/.test(m.id));
  const [modelId, setModelId] = useState("");
  // Seedance 2.5 handles a prompt with reference images well; fall back to what the account has
  const model = options.find((m) => m.id === modelId) ?? options.find((m) => /2-5/.test(m.id)) ?? options[0];
  const [quality, setQuality] = useState<Quality>("720p");
  const q: Quality = model?.qualities.includes(quality) ? quality : (model?.qualities[0] ?? "720p");
  const [seconds, setSeconds] = useState(15);
  const maxSeconds = Math.min(model?.maxSeconds ?? 15, 15);
  const secs = Math.min(seconds, maxSeconds);
  const [aspect, setAspect] = useState<T2vAspect>("9:16");
  const [audio, setAudio] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [takes, setTakes] = useState<T2vTake[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  // takes: load, then poll while one is running
  const running = takes.some((t) => t.status === "running" || t.status === "queued");
  useEffect(() => {
    void api.t2vTakes().then(setTakes).catch(() => {});
  }, []);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void api.t2vTakes().then(setTakes).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [running]);

  const images = p.images.slice(0, 24);
  const toggle = (id: string) =>
    setPicked((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : xs.length >= MAX_IMAGES ? xs : [...xs, id]));

  const upload = async (f: File) => {
    setUploading(true);
    try {
      const card = await api.cast({ file: f, kind: "character", saved: true });
      p.onNewImage(card);
      setPicked((xs) => (xs.length >= MAX_IMAGES ? xs : [...xs, card.id]));
    } catch (e) {
      p.say((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const cost = model ? estimateUsd(model.pricing, { seconds: secs, quality: q, aspect: T2V_ASPECTS[aspect], inputVideos: 0 }) : null;

  const start = async () => {
    if (!model || !prompt.trim() || busy) return;
    setBusy(true);
    try {
      const take = await api.t2v({ prompt: prompt.trim(), imageIds: picked, model: model.id, quality: q, seconds: secs, aspect, audio });
      setTakes((ts) => [take, ...ts]);
      p.say("Text to video started. It shows under Film it.");
    } catch (e) {
      p.say((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cs-page">
      <header className="cs-head">
        <div>
          <h2>Text to video</h2>
          <p>A new shot from a detailed prompt. Add the characters, objects or places it must keep, then direct it second by second.</p>
        </div>
      </header>
      <div className="cs-grid">
        <section className="cs-card">
          <h3><span className="cs-num">1</span> References</h3>
          <div className="tv-refs">
            <button className="cs-ref add" onClick={() => file.current?.click()} disabled={uploading} aria-label="Add a picture">{uploading ? "…" : "+"}</button>
            {images.map((img) => (
              <button key={img.id} className={`cs-ref tv-ref ${picked.includes(img.id) ? "on" : ""}`} onClick={() => toggle(img.id)} title={img.prompt} aria-pressed={picked.includes(img.id)}>
                <img src={img.url} alt={img.prompt} />
                {picked.includes(img.id) && <span className="tv-badge">{picked.indexOf(img.id) + 1}</span>}
              </button>
            ))}
          </div>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          <small className="cs-hint">Up to {MAX_IMAGES}, optional. Character and object sheets from Character Studio work best. In the prompt, call them “the reference image” (or reference image 1, 2…) in the order picked.</small>
        </section>

        <section className="cs-card">
          <h3><span className="cs-num">2</span> Prompt</h3>
          <textarea className="tv-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the shot like a director: the hero, the world, a second-by-second beat sheet, light, camera, what to avoid." />
          <div className="be-actions">
            <small className="cs-hint tv-count">{prompt.length} characters</small>
            <button onClick={() => setPrompt((cur) => (cur.trim() ? `${cur.trim()}\n\n${TEMPLATE(secs, aspect)}` : TEMPLATE(secs, aspect)))}>Cinematic template</button>
          </div>
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
              <div className="rs-seg" role="radiogroup" aria-label="Shape">
                {(Object.keys(T2V_ASPECTS) as T2vAspect[]).map((a) => (
                  <button key={a} role="radio" aria-checked={aspect === a} className={aspect === a ? "on" : ""} onClick={() => setAspect(a)}>{a}</button>
                ))}
              </div>
              <label className="tv-length">
                <span>Length <b>{secs} s</b></span>
                <input type="range" min={4} max={maxSeconds} step={1} value={secs} onChange={(e) => setSeconds(Number(e.target.value))} />
              </label>
              <label className="tv-toggle">
                <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
                <span>Generate sound</span>
              </label>
              <button className="accent rs-go" disabled={!prompt.trim() || busy} onClick={start}>
                {busy ? "Starting…" : `Generate · ${secs} s ${aspect}${cost !== null ? ` · ${formatUsd(cost)}` : ""}`}
              </button>
            </>
          ) : (
            <small className="cs-hint">Text to video needs a Seedance model on the Comfy API. Add COMFY_API_KEY to app/.env.</small>
          )}

          {takes.length > 0 && (
            <div className="rs-takes">
              {takes.slice(0, 8).map((t) => (
                <div key={t.id} className="rs-take">
                  {t.status === "succeeded" && t.url ? (
                    <video src={t.url} muted loop playsInline autoPlay controls />
                  ) : (
                    <div className="rs-wait">
                      <span>{t.status === "failed" ? "Failed" : t.message || "Queued"}</span>
                      {t.status !== "failed" && <span className="depth-bar"><i style={{ width: `${Math.round((t.progress ?? 0) * 100)}%` }} /></span>}
                    </div>
                  )}
                  <div className="rs-take-meta">
                    <b>{t.seconds} s · {t.aspect} · {t.quality}</b>
                    <span className="tv-take-actions">
                      <button className="small" onClick={() => setPrompt(t.prompt)} title="Put this prompt back in the box">Reuse</button>
                      {t.status === "succeeded" && t.url ? (
                        <>
                        <a className="btn small" href={t.url} download={`mogfield-t2v-${t.id}.mp4`} {...saveToPhotos(t.url, `mogfield-t2v-${t.id}.mp4`)}>Save</a>
                        {t.workflowUrl && <a className="btn small" href={t.workflowUrl} download={`mogfield-t2v-${t.id}.workflow.json`} title="The ComfyUI workflow this take ran: drop it into ComfyUI to run it again">Workflow</a>}
                        </>
                      ) : t.status === "failed" ? (
                        <small title={t.error}>{(t.error ?? "").slice(0, 60)}</small>
                      ) : (
                        <small>{Math.round((t.progress ?? 0) * 100)}%</small>
                      )}
                    </span>
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
