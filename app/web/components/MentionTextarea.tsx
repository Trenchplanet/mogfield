import { useRef, useState } from "react";

export interface MentionRef {
  tag: string; // "@image1", "@video"
  label: string;
  thumb?: string;
}

/** A textarea where "@" offers the user's references (characters as @image1…,
 *  the video as @video) so both sides agree on what a mention points at. */
export function MentionTextarea(p: {
  value: string;
  onChange: (v: string) => void;
  refs: MentionRef[];
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  autoFocus?: boolean;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null); // text after "@" at the caret
  const [active, setActive] = useState(0);

  const matches = query === null ? [] : p.refs.filter((r) => r.tag.toLowerCase().startsWith(`@${query.toLowerCase()}`));

  const readQuery = (el: HTMLTextAreaElement) => {
    const m = /(^|\s)@(\w*)$/.exec(el.value.slice(0, el.selectionStart ?? 0));
    setQuery(m ? m[2] : null);
    setActive(0);
  };

  const insert = (tag: string) => {
    const el = ta.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, caret);
    const m = /@(\w*)$/.exec(before);
    const start = m ? caret - m[0].length : caret;
    const pad = start > 0 && !/\s$/.test(el.value.slice(0, start)) ? " " : "";
    const next = `${el.value.slice(0, start)}${pad}${tag} ${el.value.slice(caret)}`;
    p.onChange(p.maxLength ? next.slice(0, p.maxLength) : next);
    setQuery(null);
    const pos = start + pad.length + tag.length + 1;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="mention">
      {p.refs.length > 0 && (
        <div className="mention-chips" aria-label="References you can mention">
          {p.refs.map((r) => (
            <button key={r.tag} type="button" className="mention-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(r.tag)} title={`Insert ${r.tag} (${r.label})`}>
              {r.thumb && <img src={r.thumb} alt="" />}
              <span>{r.tag}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mention-box">
        {matches.length > 0 && (
          <div className="mention-menu" role="listbox" aria-label="Mention a reference">
            {matches.map((r, i) => (
              <button
                key={r.tag}
                type="button"
                role="option"
                aria-selected={i === active}
                className={`mention-item ${i === active ? "on" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(r.tag)}
              >
                {r.thumb ? <img src={r.thumb} alt="" /> : <span className="mention-dot" />}
                <b>{r.tag}</b>
                <small>{r.label}</small>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={p.rows ?? 3}
          maxLength={p.maxLength}
          value={p.value}
          placeholder={p.placeholder}
          autoFocus={p.autoFocus}
          onChange={(e) => {
            p.onChange(e.target.value);
            readQuery(e.target);
          }}
          onClick={(e) => readQuery(e.currentTarget)}
          onBlur={() => setTimeout(() => setQuery(null), 120)}
          onKeyDown={(e) => {
            e.stopPropagation(); // keep app shortcuts (G, D, [ ]) out of typing
            if (!matches.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % matches.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a - 1 + matches.length) % matches.length);
            } else if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              insert(matches[active].tag);
            } else if (e.key === "Escape") setQuery(null);
          }}
        />
      </div>
    </div>
  );
}
