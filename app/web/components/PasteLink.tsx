import { useRef, useState } from "react";
import { findVideoLink } from "../../server/shared";

/** "Paste link": reads a TikTok / Instagram / X link from the clipboard and hands it to
 *  the server's downloader; falls back to a field when the clipboard can't be read. */
export function PasteLink(p: { onVideoLink: (url: string) => Promise<unknown>; disabled?: boolean; tile?: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const send = async (raw: string) => {
    const link = findVideoLink(raw);
    if (!link) {
      setError("That isn't a TikTok, Instagram or X video link");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // false means the download failed (the app already said why): keep the field
      if ((await p.onVideoLink(link)) === false) return;
      setOpen(false);
      setText("");
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (findVideoLink(clip)) return void send(clip);
    } catch {
      // clipboard blocked: let them paste by hand
    }
    setOpen(true);
    setTimeout(() => field.current?.focus(), 0);
  };

  const icon = <svg viewBox="0 0 24 24" aria-hidden><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>;
  if (!open && p.tile)
    return (
      <button className="lib-tile upload paste-link-tile" onClick={() => void paste()} disabled={p.disabled || busy}>
        <span className="up-icon">{icon}</span>
        <b>{busy ? "Downloading…" : "Paste link"}</b>
        <small>TikTok, Instagram or X</small>
      </button>
    );
  if (!open)
    return (
      <button className="paste-link" onClick={() => void paste()} disabled={p.disabled || busy}>
        {icon}
        {busy ? "Downloading…" : "Paste link"}
      </button>
    );
  return (
    <form className={`paste-link-form ${p.tile ? "in-grid" : ""}`} onSubmit={(e) => { e.preventDefault(); void send(text); }}>
      <input
        ref={field}
        value={text}
        onChange={(e) => { setText(e.target.value); setError(null); }}
        placeholder="TikTok, Instagram or X link"
        aria-label="TikTok, Instagram or X video link"
        inputMode="url"
        disabled={busy}
      />
      <button type="submit" className="accent" disabled={busy || !text.trim()}>{busy ? "Downloading…" : "Add"}</button>
      <button type="button" className="ghost" onClick={() => { setOpen(false); setError(null); }} disabled={busy}>Cancel</button>
      {error && <small className="paste-link-error">{error}</small>}
    </form>
  );
}
