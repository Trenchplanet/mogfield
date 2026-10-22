import { useState } from "react";
import { RESHOOT_ANGLES, type Clip, type Render, type ReshootAngle } from "../../server/shared";
import { estimateUsd, formatUsd } from "../../server/providers/pricing";
import type { ModelOption, Quality } from "../api";
import { saveToPhotos } from "../save";
import { AbButton } from "./AbButton";
import { EasyVideoCard, type Trim } from "./VideoCard";

/** Re-shoot works with models that read the whole original video. */
const RESHOOT_MODELS = /seedance/;

/** Little top-down diagrams: the subject is the dot, the camera the triangle. */
const ANGLE_ICON: Record<ReshootAngle, string> = {
  orbit_left: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M5 12a7 7 0 0 1 7-7M5 9l0 3 3 0",
  orbit_right: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M19 12a7 7 0 0 0-7-7M19 9l0 3-3 0",
  low_angle: "M12 5v9M9 8l3-3 3 3M5 20l7-4 7 4",
  high_angle: "M12 19v-9M9 16l3 3 3-3M5 4l7 4 7-4",
  overhead: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M12 3v4M12 17v4M3 12h4M17 12h4",
  closeup: "M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
  wide: "M3 7h18v10H3zM12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  behind: "M12 9m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M8 20c0-3 2-5 4-5s4 2 4 5M12 3v2",
  profile: "M14 9m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M4 12h5M7 10l2 2-2 2",
  drone: "M12 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M6 5h4M14 5h4M8 5v3l4 3 4-3V5",
};

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** Re-shoot: the same moment, filmed again from another camera angle. */
export function ReshootPage(p: {
  clip: Clip | null;
  trim: Trim;
  onTrim: (t: Trim) => void;
  onPickVideo: () => void;
  models: ModelOption[];
  renders: Render[];
  clips: Clip[];
  say: (m: string) => void;
  onStart: (o: { angle: ReshootAngle; direction?: string; model: string; quality: Quality; trim?: Trim }) => Promise<void>;
}) {
  const options = p.models.filter((m) => m.available && RESHOOT_MODELS.test(m.id));
  const [angle, setAngle] = useState<ReshootAngle>("orbit_left");
  const [direction, setDirection] = useState("");
  // Seedance 2.0 is the default: it accepts the original video most reliably
  const [modelId, setModelId] = useState<string>("");
  const model = options.find((m) => m.id === modelId) ?? options.find((m) => /2-0-260128/.test(m.id)) ?? options[0];
  const [quality, setQuality] = useState<Quality>("480p");
  const q: Quality = model?.qualities.includes(quality) ? quality : (model?.qualities[0] ?? "480p");
  const [busy, setBusy] = useState(false);

  const maxSeconds = model?.maxSeconds ?? 15;
  const trim = p.clip ? { start: p.trim.start, end: Math.min(p.trim.end, p.trim.start + maxSeconds) } : p.trim;
  const seconds = trim.end - trim.start;
  const requestTrim = p.clip && seconds < p.clip.duration - 0.05 ? trim : undefined;
  const cost = p.clip && model ? estimateUsd(model.pricing, { seconds, quality: q, aspect: p.clip.width / p.clip.height, inputVideos: 1 }) : null;
  const takes = p.renders.filter((r) => r.params.reshoot).slice(0, 6);

  const start = async () => {
    if (!p.clip || !model || busy) return;
    setBusy(true);
    try {
      await p.onStart({ angle, direction: direction.trim() || undefined, model: model.id, quality: q, trim: requestTrim });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cs-page">
      <header className="cs-head">
        <div>
          <h2>Re-shoot</h2>
          <p>The same moment, filmed again from another angle. Pick a take and where the new camera stands; the model keeps the people, the place and the action.</p>
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
          <small className="cs-hint">Up to {maxSeconds} s. Clear shots of people or objects re-shoot best.</small>
        </section>

        <section className="cs-card">
          <h3><span className="cs-num">2</span> New angle</h3>
          <div className="rs-angles" role="radiogroup" aria-label="Camera angle">
            {(Object.keys(RESHOOT_ANGLES) as ReshootAngle[]).map((id) => (
              <button key={id} role="radio" aria-checked={angle === id} className={`rs-angle ${angle === id ? "on" : ""}`} onClick={() => setAngle(id)} title={RESHOOT_ANGLES[id].camera}>
                <Icon d={ANGLE_ICON[id]} />
                <b>{RESHOOT_ANGLES[id].label}</b>
                <small>{RESHOOT_ANGLES[id].hint}</small>
              </button>
            ))}
          </div>
          <label className="rs-field">
            <span>Direction (optional)</span>
            <textarea rows={2} value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="e.g. golden hour, keep the dog in frame" />
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
              <button className="accent rs-go" disabled={!p.clip || busy} onClick={start}>
                {busy ? "Starting…" : `Re-shoot · ${RESHOOT_ANGLES[angle].label}${cost !== null ? ` · ${formatUsd(cost)}` : ""}`}
              </button>
            </>
          ) : (
            <small className="cs-hint">Re-shoot needs a Seedance model on the Comfy API. Add COMFY_API_KEY to app/.env.</small>
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
                    <b>{r.params.reshoot ? RESHOOT_ANGLES[r.params.reshoot].label : ""}</b>
                    {r.status === "succeeded" && r.url ? (
                      <span className="tv-take-actions">
                      <a className="btn small" href={r.url} download={`mogfield-reshoot-${r.take}.mp4`} {...saveToPhotos(r.url, `mogfield-reshoot-${r.take}.mp4`)}>Save</a>
                      {r.workflowUrl && <a className="btn small" href={r.workflowUrl} download={`mogfield-reshoot-${r.take}.workflow.json`} title="The ComfyUI workflow this take ran: drop it into ComfyUI to run it again">Workflow</a>}
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
