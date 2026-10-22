import { useEffect, useRef, useState } from "react";
import type { Clip, PersonBox, Preparation } from "../../server/shared";
import { api } from "../api";
import { JobSteps } from "./JobSteps";
import { PeoplePicker } from "./PeoplePicker";

function FullClipReviewVideo(p: { src: string; title: string; onReviewed: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [reviewed, setReviewed] = useState(false);

  useEffect(() => setReviewed(false), [p.src]);

  const markTime = () => {
    const el = video.current;
    if (!el || !Number.isFinite(el.duration) || reviewed) return;
    let covered = 0;
    for (let i = 0; i < el.played.length; i++) covered += el.played.end(i) - el.played.start(i);
    if (covered >= el.duration - 0.75) {
      setReviewed(true);
      p.onReviewed();
    }
  };

  return (
    <div className={`prep-review-card ${reviewed ? "reviewed" : ""}`}>
      <div className="prep-review-title"><b>{p.title}</b><span>{reviewed ? "Full clip reviewed" : "Play through the full clip"}</span></div>
      <video
        ref={video}
        src={p.src}
        controls
        playsInline
        preload="metadata"
        onTimeUpdate={markTime}
        onEnded={markTime}
      />
      <div className="prep-review-status">{reviewed ? "✓" : "○"} {reviewed ? "Reviewed" : "Review required"}</div>
    </div>
  );
}

export function PreparationSheet(p: {
  clip: Clip;
  trim?: { start: number; end: number };
  preparation: Preparation | null;
  readiness: { comfyConfigured: boolean; rubberBandConfigured: boolean };
  costLabel: string | null;
  onPreparation: (job: Preparation) => void;
  onApproved: (job: Preparation) => void;
  onGenerate: () => void;
  onClose: () => void;
}) {
  const [segmentPrompt, setSegmentPrompt] = useState(p.preparation?.people?.length ? "person" : p.preparation?.segmentPrompt ?? "person");
  // who SAM 3 tracks: everyone matching the text, or only the people boxed on one frame
  const [who, setWho] = useState<"everyone" | "pick">(p.preparation?.people?.length ? "pick" : "everyone");
  const [boxes, setBoxes] = useState<PersonBox[]>(p.preparation?.people ?? []);
  const [peopleAt, setPeopleAt] = useState(p.preparation?.peopleAt ?? 0);
  const takeStart = p.trim?.start ?? 0;
  const takeLength = p.trim ? p.trim.end - p.trim.start : Math.min(p.clip.duration, 30);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewedInput, setReviewedInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the prepared take was not right: back to the setup, with the earlier picks kept
  const [redo, setRedo] = useState(false);
  const prep = p.preparation;
  const running = prep?.status === "queued" || prep?.status === "running";
  const ready = prep?.status === "ready" && !!prep.manifestHash;
  const alreadyApproved = ready && prep.approved;
  const canPrepare = p.readiness.comfyConfigured && p.readiness.rubberBandConfigured;

  useEffect(() => {
    if (!prep || !running) return;
    return api.watchPreparation(prep.id, p.onPreparation);
  }, [prep?.id, running, p.onPreparation]);

  useEffect(() => {
    setReviewedInput(false);
  }, [prep?.id]);

  const start = async () => {
    if (!consent || !canPrepare || busy) return;
    setBusy(true);
    setError(null);
    try {
      const job = await api.prepare({ clipId: p.clip.id, trim: p.trim, segmentPrompt: segmentPrompt.trim() || "person", ...(who === "pick" ? { people: boxes, peopleAt } : {}) });
      p.onPreparation(job);
      setRedo(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!prep || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.dismissPreparation(prep.id);
      setConsent(false);
      setRedo(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!prep?.manifestHash || !reviewedInput || busy) return;
    setBusy(true);
    setError(null);
    try {
      const approved = await api.approvePreparation(prep.id, prep.manifestHash);
      p.onPreparation(approved);
      p.onApproved(approved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mayClose = !busy;
  return (
    <div className="sheet-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget && mayClose) p.onClose(); }}>
      <section className="prep-sheet" role="dialog" aria-modal="true" aria-labelledby="prep-title">
        <header className="prep-head">
          <div><span className="prep-eyebrow">GENJUSTSU · COMFY EDITION</span><h2 id="prep-title">Prepare and review the take</h2></div>
          <button className="prep-close" onClick={p.onClose} disabled={!mayClose} aria-label="Close">×</button>
        </header>
        <div className="prep-content">
          {!prep || prep.status === "failed" || redo ? (
            <>
              {prep?.error && !redo && <div className="prep-error" role="alert">{prep.error}</div>}
              {redo && <div className="prep-note">Set aside. Change who to swap (Pick people boxes one person) and prepare again.</div>}
              <div className="prep-field">Who to swap
                <div className="seg" role="radiogroup" aria-label="Who to swap">
                  <button role="radio" aria-checked={who === "everyone"} className={who === "everyone" ? "on" : ""} onClick={() => setWho("everyone")}>Everyone matching</button>
                  <button role="radio" aria-checked={who === "pick"} className={who === "pick" ? "on" : ""} onClick={() => setWho("pick")}>Pick people</button>
                </div>
              </div>
              {who === "everyone" ? (
                <label className="prep-field">Subject to mask
                  <input value={segmentPrompt} onChange={(e) => setSegmentPrompt(e.target.value)} maxLength={120} placeholder="person" />
                </label>
              ) : (
                <PeoplePicker src={p.clip.url} aspect={p.clip.width / p.clip.height} start={takeStart} duration={takeLength} at={peopleAt} setAt={setPeopleAt} boxes={boxes} setBoxes={setBoxes} />
              )}
              <div className="prep-steps">
                <div><b>1</b><span>Normalize to 24 fps, then run Depth Anything V2 in Comfy.</span></div>
                <div><b>2</b><span>Run SAM 3 video tracking and separate the vocal stem in Comfy; shift vocals +3 semitones.</span></div>
                <div><b>3</b><span>Review the prepared video, approve, then generate.</span></div>
              </div>
              <label className="prep-consent">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>I understand preparation uploads this clip and its audio to Comfy for depth, SAM 3 and audio separation. Comfy Cloud workflow execution needs an active Cloud plan and may be charged separately from video credits. The video model (Seedance or H3) runs only after I separately click Generate.</span>
              </label>
              {!p.readiness.comfyConfigured && <div className="prep-note">Add COMFY_API_KEY to app/.env for Comfy Cloud, or set COMFY_BASE_URL to your ComfyUI API endpoint.</div>}
              {!p.readiness.rubberBandConfigured && <div className="prep-note">Install Rubber Band with <code>brew install rubberband</code>, or set RUBBERBAND_BIN.</div>}
              {error && <div className="prep-error" role="alert">{error}</div>}
              <div className="prep-actions">
                <button onClick={p.onClose} disabled={!mayClose}>Cancel</button>
                <button className="primary" onClick={() => void start()} disabled={!consent || !canPrepare || busy || (who === "everyone" ? !segmentPrompt.trim() : !boxes.length)}>{busy ? "Starting…" : prep && !redo ? "Prepare again" : "Prepare take"}</button>
              </div>
            </>
          ) : running ? (
            <div className="prep-progress">
              <div className="prep-progress-head"><b>Preparing the take</b><span>{Math.round(prep.progress * 100)}%</span></div>
              <div className="prep-track"><i style={{ width: `${Math.round(prep.progress * 100)}%` }} /></div>
              {prep.steps?.length ? <JobSteps steps={prep.steps} /> : <p>{prep.message}</p>}
              <p>It keeps running if you close this. Find it again under <b>Queue</b> at the top right.</p>
              <div className="prep-actions">
                <button onClick={p.onClose}>Close · keep running</button>
              </div>
            </div>
          ) : ready ? (
            <>
              {alreadyApproved ? (
                <>
                  <div className="prep-approved"><b>Approved artifacts are ready.</b><span>Generate sends the prepared video and your character to the model you picked, at the quality you picked. The estimate is shown on the button; Comfy’s content policy still applies.</span></div>
                  <div className="prep-actions">
                    <button onClick={() => void reject()} disabled={busy}>Redo preparation</button>
                    <button onClick={p.onClose}>Later</button>
                    <button className="primary" disabled={busy} onClick={() => { p.onClose(); p.onGenerate(); }}>
                      {busy ? "Starting…" : `Generate${p.costLabel ? ` · ${p.costLabel}` : ""}`}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="prep-review-intro"><b>Watch the prepared video before approving.</b><span>This is exactly what the video model receives: the depth-colored figure over the background, with the pitched vocals. Approval is tied to these exact files.</span></div>
                  <div className="prep-review-grid single">
                    {prep.seedanceInputUrl && <FullClipReviewVideo key={`${prep.id}-input`} src={prep.seedanceInputUrl} title="Prepared video · depth figure + pitched vocals" onReviewed={() => setReviewedInput(true)} />}
                  </div>
                  <details className="prep-extra"><summary>Other previews (mask, depth, silent composite)</summary><div className="prep-review-grid">
                    {prep.overlayUrl && <video src={prep.overlayUrl} controls playsInline preload="metadata" aria-label="SAM mask over the original" />}
                    {prep.maskUrl && <video src={prep.maskUrl} controls playsInline preload="metadata" aria-label="Binary SAM mask" />}
                    {prep.depthUrl && <video src={prep.depthUrl} controls playsInline preload="metadata" aria-label="Colored depth map" />}
                    {prep.compositeUrl && <video src={prep.compositeUrl} controls playsInline preload="metadata" aria-label="Silent depth subject composite" />}
                  </div></details>
                  <div className="prep-hash">Artifact manifest <code>{prep.manifestHash?.slice(0, 16)}…</code></div>
                  {error && <div className="prep-error" role="alert">{error}</div>}
                  <div className="prep-actions">
                    <button onClick={() => void reject()} disabled={busy}>Not right · redo</button>
                    <button onClick={p.onClose} disabled={!mayClose}>Close</button>
                    <button className="primary" onClick={() => void approve()} disabled={busy || !reviewedInput}>{busy ? "Approving…" : "Approve prepared video"}</button>
                  </div>
                </>
              )}
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
