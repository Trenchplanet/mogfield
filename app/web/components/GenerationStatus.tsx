import type { JobStep } from "../../server/shared";
import { JobSteps } from "./JobSteps";

export function GenerationStatus(p: {
  progress: { progress: number; message: string } | null;
  error: string | null;
  /** The take's checklist (Seedance takes report named steps). */
  steps?: JobStep[];
}) {
  if (p.error) {
    return (
      <div className="generation-status failed" role="alert" aria-live="assertive">
        <b>Generation stopped</b>
        <span>{p.error}</span>
        {p.steps?.some((s) => s.state === "failed") && <JobSteps steps={p.steps} compact />}
      </div>
    );
  }
  if (!p.progress) return null;

  const value = Math.round(Math.max(0, Math.min(1, p.progress.progress)) * 100);
  return (
    <div className="generation-status" role="status" aria-live="polite">
      <div className="generation-status-head"><b>{p.progress.message || "Working"}</b><span>{value}%</span></div>
      <div className="generation-status-track" role="progressbar" aria-label="Generation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <i style={{ width: `${value}%` }} />
      </div>
      {p.steps?.length ? <JobSteps steps={p.steps} compact /> : null}
    </div>
  );
}
