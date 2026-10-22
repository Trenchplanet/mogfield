import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Clip, Preparation, Render } from "../../server/shared";
import { QueueList, type QueueItem } from "./Queue";
import { saveToPhotos } from "../save";

/** A muted looping video that only plays while hovered or after a tap, so a page of tiles stays light. */
function HoverVideo({ src, poster, label }: { src: string; poster?: string; label: string }) {
  const v = useRef<HTMLVideoElement>(null);
  const play = () => void v.current?.play().catch(() => {});
  const stop = () => v.current?.pause();
  return (
    <video
      ref={v}
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      preload="metadata"
      aria-label={label}
      onMouseEnter={play}
      onMouseLeave={stop}
      onFocus={play}
      onBlur={stop}
    />
  );
}

export type TileAction = { label: string; onClick?: () => void; href?: string; download?: string; primary?: boolean };

/** A library tile that opens a small action menu over its video when clicked. */
function MenuTile(p: { id: string; open: boolean; onToggle: (id: string | null) => void; ar: number; media: ReactNode; meta: ReactNode; actions: TileAction[] }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!p.open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) p.onToggle(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") p.onToggle(null); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); };
  }, [p.open, p.onToggle]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <article ref={ref} className={`lp-tile lp-menu-tile ${p.open ? "open" : ""}`} style={{ ["--ar" as string]: String(p.ar) }}>
      <button className="lp-hit" aria-haspopup="menu" aria-expanded={p.open} onClick={() => p.onToggle(p.open ? null : p.id)}>
        <div className="lp-media">{p.media}</div>
        <div className="lp-meta">{p.meta}</div>
      </button>
      {p.open && (
        <div className="lp-menu" role="menu">
          {p.actions.map((a) =>
            a.href ? (
              <a key={a.label} role="menuitem" className={`btn ${a.primary ? "accent" : ""}`} href={a.href} download={a.download} onPointerDown={a.download?.endsWith(".mp4") ? saveToPhotos(a.href, a.download).onPointerDown : undefined} onClick={(e) => { if (a.download?.endsWith(".mp4")) void saveToPhotos(a.href!, a.download).onClick(e); p.onToggle(null); }}>{a.label}</a>
            ) : (
              <button key={a.label} role="menuitem" className={a.primary ? "accent" : ""} onClick={() => { p.onToggle(null); a.onClick?.(); }}>{a.label}</button>
            ),
          )}
        </div>
      )}
    </article>
  );
}

const fileName = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "video";

const seconds = (t?: { start: number; end: number }, fallback?: number) => (t ? t.end - t.start : fallback ?? 0);

export function LibraryPage(p: {
  queue: QueueItem[];
  clips: Clip[];
  preparations: Preparation[];
  renders: Render[];
  onOpenQueueItem: (item: QueueItem) => void;
  onDismiss: (item: QueueItem) => void;
  onUseTemplate: (prep: Preparation) => void;
  onOpenRender: (render: Render) => void;
  onOpenUploads: () => void;
}) {
  const clipById = new Map(p.clips.map((c) => [c.id, c]));
  const templates = p.preparations.filter((x) => x.status === "ready" && x.seedanceInputUrl && clipById.has(x.clipId));
  const takes = p.renders.filter((r) => r.status === "succeeded" && r.url);
  const templateById = new Map(templates.map((t) => [t.id, t]));
  const [menu, setMenu] = useState<string | null>(null);
  return (
    <div className="library-page">
      <section className="lp-section">
        <header className="lp-head">
          <h2>Queue</h2>
          <span>Running work and recent takes. Tap one to pick it up again.</span>
        </header>
        <div className="lp-card">
          <QueueList items={p.queue} clips={p.clips} onOpen={p.onOpenQueueItem} onDismiss={p.onDismiss} empty="Nothing running. Generate a take and it shows up here." />
        </div>
      </section>

      <section className="lp-section">
        <header className="lp-head">
          <h2>Prepared takes · SAM 3 <span className="lp-count">{templates.length}</span></h2>
          <span>Reuse a prepared video as a template: pick a character and generate, no new preparation needed.</span>
        </header>
        {templates.length ? (
          <div className="lp-grid">
            {templates.map((t) => {
              const clip = clipById.get(t.clipId)!;
              return (
                <MenuTile
                  key={t.id}
                  id={`prep:${t.id}`}
                  open={menu === `prep:${t.id}`}
                  onToggle={setMenu}
                  ar={clip.width / clip.height}
                  media={
                    <>
                      {/* no poster: show the prepared video's own first frame, not the original clip */}
                      <HoverVideo src={`${t.seedanceInputUrl!}#t=0.1`} label={`Prepared video of ${clip.name}`} />
                      {t.approved && <span className="lp-badge">Approved</span>}
                    </>
                  }
                  meta={
                    <>
                      <b>{clip.name}</b>
                      <small>{seconds(t.trim, t.duration ?? clip.duration).toFixed(1)}s · mask “{t.segmentPrompt}” · {new Date(t.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
                    </>
                  }
                  actions={[
                    { label: "Use template", primary: true, onClick: () => p.onUseTemplate(t) },
                    { label: "Save video", href: t.seedanceInputUrl!, download: `${fileName(clip.name)}-prepared.mp4` },
                  ]}
                />
              );
            })}
          </div>
        ) : (
          <p className="queue-empty">No prepared takes yet. Generate with Seedance 2.5 and the preparation is kept here.</p>
        )}
      </section>

      <section className="lp-section">
        <header className="lp-head">
          <h2>Generated videos <span className="lp-count">{takes.length}</span></h2>
          <button onClick={p.onOpenUploads}>Uploads & characters</button>
        </header>
        {takes.length ? (
          <div className="lp-grid">
            {takes.map((r) => {
              const clip = clipById.get(r.params.clipId);
              const template = r.params.preparationId ? templateById.get(r.params.preparationId) : undefined;
              return (
                <MenuTile
                  key={r.id}
                  id={`take:${r.id}`}
                  open={menu === `take:${r.id}`}
                  onToggle={setMenu}
                  ar={clip ? clip.width / clip.height : 9 / 16}
                  media={<HoverVideo src={r.url!} poster={clip?.poster} label={`Take ${r.take}`} />}
                  meta={
                    <>
                      <b>Take {r.take}</b>
                      <small>{clip?.name ?? "clip"} · {new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
                    </>
                  }
                  actions={[
                    { label: "Open in studio", primary: true, onClick: () => p.onOpenRender(r) },
                    ...(template ? [{ label: "Use template", onClick: () => p.onUseTemplate(template) }] : []),
                    { label: "Save video", href: r.url!, download: `${fileName(clip?.name ?? "take")}-take-${r.take}.mp4` },
                  ]}
                />
              );
            })}
          </div>
        ) : (
          <p className="queue-empty">Nothing generated yet.</p>
        )}
      </section>
    </div>
  );
}
