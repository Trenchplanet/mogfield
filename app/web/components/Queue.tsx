import type { Clip, JobStep, Preparation, Render } from "../../server/shared";
import { saveToPhotos } from "../save";

export type QueueItem = { kind: "prep"; at: number; prep: Preparation } | { kind: "render"; at: number; render: Render };

const running = (s: string) => s === "queued" || s === "running";

/** What the queue shows: work in progress, preparations waiting on you, and recent takes. */
export function queueItems(preparations: Preparation[], renders: Render[]): QueueItem[] {
  const used = new Set(renders.map((r) => r.params.preparationId).filter(Boolean));
  const items: QueueItem[] = [
    // a preparation leaves the queue once a take uses it (it stays in the Library as a template)
    ...preparations.filter((p) => !p.dismissed && (running(p.status) || !used.has(p.id))).map((prep) => ({ kind: "prep" as const, at: prep.createdAt, prep })),
    ...renders.filter((r) => !r.dismissed).map((render) => ({ kind: "render" as const, at: render.createdAt, render })),
  ];
  return items.sort((a, b) => b.at - a.at).slice(0, 25);
}

/** Running work plus preparations that need a review or are ready to generate. */
export function queueCount(items: QueueItem[]) {
  return items.filter((i) => (i.kind === "render" ? running(i.render.status) : running(i.prep.status) || i.prep.status === "ready")).length;
}

export const queueBusy = (items: QueueItem[]) => items.some((i) => running(i.kind === "render" ? i.render.status : i.prep.status));

function ago(at: number) {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

const liveStep = (steps?: JobStep[]) => steps?.find((s) => s.state === "running");

function status(item: QueueItem): { text: string; tone: "live" | "ok" | "wait" | "bad" | "muted"; detail?: string } {
  if (item.kind === "prep") {
    const p = item.prep;
    if (p.status === "queued") return { text: "Queued", tone: "live" };
    if (p.status === "running") {
      const step = liveStep(p.steps);
      return { text: `${step?.label ?? p.message} · ${Math.round(p.progress * 100)}%`, tone: "live", detail: step?.note };
    }
    if (p.status === "failed") return { text: "Preparation failed", tone: "bad", detail: p.error };
    return p.approved ? { text: "Approved · ready to generate", tone: "ok" } : { text: "Ready to review", tone: "wait" };
  }
  const r = item.render;
  if (r.status === "queued") return { text: "Queued", tone: "live" };
  if (r.status === "running") {
    const step = liveStep(r.steps);
    return { text: `${step?.label ?? r.message} · ${Math.round(r.progress * 100)}%`, tone: "live", detail: step?.note };
  }
  if (r.status === "failed") return { text: "Failed", tone: "bad", detail: r.error };
  return { text: r.isDraft ? "Draft ready" : "Done", tone: "ok" };
}

export function QueueList(p: {
  items: QueueItem[];
  clips: Clip[];
  onOpen: (item: QueueItem) => void;
  onDismiss: (item: QueueItem) => void;
  empty?: string;
}) {
  const clipById = new Map(p.clips.map((c) => [c.id, c]));
  if (!p.items.length) return <p className="queue-empty">{p.empty ?? "Nothing in the queue."}</p>;
  return (
    <ul className="queue-list">
      {p.items.map((item) => {
        const id = item.kind === "prep" ? item.prep.id : item.render.id;
        const clip = clipById.get(item.kind === "prep" ? item.prep.clipId : item.render.params.clipId);
        const st = status(item);
        const busy = st.tone === "live";
        return (
          <li key={`${item.kind}-${id}`} className={`queue-row ${st.tone}`}>
            <button className="queue-open" onClick={() => p.onOpen(item)}>
              <span className="queue-thumb">{clip?.poster ? <img src={clip.poster} alt="" /> : null}{busy && <i className="job-spin" />}</span>
              <span className="queue-text">
                <b>{item.kind === "prep" ? "Preparation" : `Take ${item.render.take}`}<small> · {clip?.name ?? "clip"} · {ago(item.at)}</small></b>
                <span className={`queue-status ${st.tone}`}>{st.text}</span>
                {st.detail && <small className="queue-detail">{st.detail}</small>}
              </span>
            </button>
            {item.kind === "render" && item.render.status === "succeeded" && item.render.url && (
              <a className="queue-dl" href={item.render.url} download={`mogfield-video-${item.render.take}.mp4`} {...saveToPhotos(item.render.url, `mogfield-video-${item.render.take}.mp4`)} aria-label={`Download take ${item.render.take}`} title="Download">
                <svg viewBox="0 0 24 24" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
              </a>
            )}
            {!busy && (
              <button className="queue-dismiss" aria-label="Remove from queue" title="Remove from queue" onClick={() => p.onDismiss(item)}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The top-right queue button: a count of what needs attention, and a spinner while work runs. */
export function QueueButton(p: { count: number; busy: boolean; open: boolean; onClick: () => void }) {
  return (
    <button className={`queue-button ${p.open ? "on" : ""}`} aria-expanded={p.open} aria-label={`Queue, ${p.count} active`} onClick={p.onClick}>
      {p.busy ? <i className="job-spin" /> : (
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 6h16M4 12h16M4 18h10" /></svg>
      )}
      <span>Queue</span>
      {p.count > 0 && <span className="queue-count">{p.count}</span>}
    </button>
  );
}
