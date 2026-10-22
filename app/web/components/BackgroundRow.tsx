import { MentionTextarea, type MentionRef } from "./MentionTextarea";

/** "Keep background the same" switch; off reveals a box for the new background. */
export function BackgroundRow(p: { keep: boolean; setKeep: (v: boolean) => void; text: string; setText: (s: string) => void; refs: MentionRef[] }) {
  return (
    <div className={`row-card ${!p.keep ? "open" : ""}`}>
      <label className="row-head toggle-row">
        <span className="row-text">
          <b>Keep background the same</b>
          <small>{p.keep ? "Only the character changes" : "Describe the new background below"}</small>
        </span>
        <span className="switch">
          <input type="checkbox" checked={p.keep} onChange={(e) => p.setKeep(e.target.checked)} aria-label="Keep background the same" />
          <i />
        </span>
      </label>
      {!p.keep && (
        <div className="row-body">
          <MentionTextarea value={p.text} onChange={p.setText} refs={p.refs} rows={2} maxLength={600} placeholder="A neon-lit alley in Tokyo at night, light rain…" autoFocus />
        </div>
      )}
    </div>
  );
}
