import { useEffect, useState } from "react";
import type { JobStep } from "../../server/shared";

export function elapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The progress checklist: one line per step, ticked when done, with where it runs and how long it took. */
export function JobSteps({ steps, compact = false }: { steps: JobStep[]; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const live = steps.some((s) => s.state === "running");
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return (
    <ol className={`job-steps ${compact ? "compact" : ""}`} aria-label="Progress steps">
      {steps.map((s) => (
        <li key={s.key} className={`job-step ${s.state}`}>
          <span className="job-step-icon" aria-hidden>
            {s.state === "done" ? (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
            ) : s.state === "failed" ? (
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            ) : s.state === "running" ? (
              <i className="job-spin" />
            ) : null}
          </span>
          <span className="job-step-text">
            <b>{s.label}</b>
            {s.note && s.state !== "done" ? <small>{s.note}</small> : null}
          </span>
          {!compact && <span className={`job-step-where ${s.where}`}>{s.where === "comfy" ? "Comfy Cloud" : "Local"}</span>}
          <span className="job-step-time">{s.startedAt && s.state !== "pending" ? elapsed((s.endedAt ?? now) - s.startedAt) : ""}</span>
          <span className="sr-only">{s.state === "done" ? "done" : s.state === "running" ? "in progress" : s.state === "failed" ? "failed" : "waiting"}</span>
        </li>
      ))}
    </ol>
  );
}
