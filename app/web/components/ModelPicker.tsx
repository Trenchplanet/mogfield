import { useEffect, useState } from "react";
import type { ModelOption, Quality } from "../api";

const CHECK = "M5 12l5 5L20 7";
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
const I = { check: CHECK };

/** Model + Quality rows with floating pickers (Create and Pro Recast). */
export function ModelPicker(p: { models: ModelOption[]; model: string; setModel: (id: string) => void; quality: Quality; setQuality: (q: Quality) => void; draftPreview?: boolean }) {
  const [menu, setMenuState] = useState<"model" | "quality" | null>(null);
  const [menuPos, setMenuPos] = useState<React.CSSProperties>({});
  const setMenu = (m: "model" | "quality" | null, anchor?: HTMLElement) => {
    if (m && anchor) {
      // float beside the row; anchor to its bottom edge when it sits low on screen
      const r = anchor.getBoundingClientRect();
      const low = r.top > window.innerHeight / 2;
      setMenuPos(
        window.innerWidth <= 820
          ? { position: "fixed", left: 12, right: 12, bottom: 12 }
          : { position: "fixed", left: r.right + 10, ...(low ? { bottom: window.innerHeight - r.bottom } : { top: r.top }) },
      );
    }
    setMenuState(m);
  };
  // close menus on outside click / Escape
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".easy-menu, .row-select")) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    const onScroll = () => setMenu(null);
    window.addEventListener("resize", onScroll);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
    };
  }, [menu]);

  const current = p.models.find((m) => m.id === p.model) ?? p.models[0];
  return (
    <>
        <div className="row-wrap">
          <button className="row-card row-select" onClick={(e) => setMenu(menu === "model" ? null : "model", e.currentTarget)} aria-expanded={menu === "model"}>
            <span className="row-text">
              <small>Model</small>
              <b>
                {current?.label ?? "…"} {current?.badges.map((b) => <span key={b} className="tag">{b}</span>)}
              </b>
            </span>
            <span className="chev">›</span>
          </button>
          {menu === "model" && (
            <div className="easy-menu models" role="listbox" aria-label="Model" style={menuPos}>
              {p.models.map((m) => (
                <button key={m.id} role="option" aria-selected={m.id === current?.id} className={`menu-item ${m.available ? "" : "off"}`} onClick={() => { p.setModel(m.id); setMenu(null); }}>
                  <span className="row-text">
                    <b>{m.label} {m.badges.map((b) => <span key={b} className="tag">{b}</span>)}</b>
                    <small>{m.available ? `${m.provider}${m.inputMode === "text-only" ? " · Text only" : m.inputMode === "text-image" ? " · Text + image" : ""} · ${m.qualities.join(" · ")}` : m.needs}</small>
                  </span>
                  {m.id === current?.id && <Icon d={I.check} />}
                </button>
              ))}
            </div>
          )}
      </div>

      {current?.inputMode === "text-only" && (
        <small className="hint-text">LTX gets text and motion notes only. The source video and character images are not sent; motion is approximated from analysis.</small>
      )}
      {current?.inputMode === "text-image" && (
        <small className="hint-text">MiniMax H3 receives text and optional character images; the source video is not sent. Motion is approximate, and H3 generates native audio.</small>
      )}

      {p.draftPreview ? (
        <div className="row-card row-select">
          <span className="row-text"><small>Workflow</small><b>480p draft → 1080p final</b></span>
        </div>
      ) : <div className="row-wrap">
          <button className="row-card row-select" onClick={(e) => setMenu(menu === "quality" ? null : "quality", e.currentTarget)} aria-expanded={menu === "quality"}>
            <span className="row-text">
              <small>Quality</small>
              <b>{p.quality}</b>
            </span>
            <span className="chev">›</span>
          </button>
          {menu === "quality" && (
            <div className="easy-menu quality" role="listbox" aria-label="Quality" style={menuPos}>
              {(current?.qualities ?? ["480p", "720p", "1080p"]).map((q) => (
                <button key={q} role="option" aria-selected={q === p.quality} className="menu-item" onClick={() => { p.setQuality(q); setMenu(null); }}>
                  <b>{q}</b>
                  {q === p.quality && <Icon d={I.check} />}
                </button>
              ))}
            </div>
          )}
      </div>}
    </>
  );
}
