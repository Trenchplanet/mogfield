import { useEffect, useRef, useState } from "react";
import type { CastCard } from "../../server/shared";
import { api } from "../api";

type Stage = { kind: "pick" } | { kind: "uploading"; p: number } | { kind: "building"; since: number } | { kind: "done"; card: CastCard } | { kind: "error"; message: string };

/** One photo in, a Nano Banana character sheet out. */
export function CharacterMaker({ onClose, onCreated, onUse }: { onClose: () => void; onCreated: (c: CastCard) => void; onUse: (c: CastCard) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [size, setSize] = useState<"1K" | "2K">("2K");
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const [over, setOver] = useState(false);
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // paste a picture straight into the maker
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const img = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (!img || stage.kind === "uploading" || stage.kind === "building") return;
      e.preventDefault();
      pick(img.name && img.name !== "image.png" ? img : new File([img], "Pasted character.png", { type: img.type }));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  useEffect(() => {
    if (stage.kind !== "building") return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [stage.kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && stage.kind !== "uploading" && stage.kind !== "building" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage.kind, onClose]);

  const pick = (f: File | undefined) => {
    if (!f || !f.type.startsWith("image/")) return;
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 40));
    setStage({ kind: "pick" });
  };

  const make = async () => {
    if (!file) return;
    setStage({ kind: "uploading", p: 0 });
    try {
      const card = await api.makeCharacter({ file, name: name.trim() || undefined, size }, (p) => {
        if (p >= 1) setStage({ kind: "building", since: Date.now() });
        else setStage({ kind: "uploading", p });
      });
      onCreated(card);
      setStage({ kind: "done", card });
    } catch (e) {
      setStage({ kind: "error", message: (e as Error).message });
    }
  };

  const busy = stage.kind === "uploading" || stage.kind === "building";
  // sheets take ~35-40 s at 2K: show an honest estimate, never 100% until done
  const est = size === "2K" ? 40 : 30;
  const buildP = stage.kind === "building" ? Math.min(0.95, (now - stage.since) / 1000 / est) : 0;

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="maker" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Make a character">
        <div className="maker-head">
          <div>
            <h3>Make a character</h3>
            <p>Upload one picture. MOGFIELD turns its appearance into a six-view fictional character sheet.</p>
          </div>
          <button className="lib-close" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>

        {stage.kind === "done" ? (
          <div className="maker-result">
            <img src={stage.card.url} alt={`${stage.card.prompt} character sheet`} />
            <div className="maker-actions">
              <button className="accent" onClick={() => onUse(stage.card)}>Use this character</button>
              <button onClick={() => { setFile(null); setPreview(null); setName(""); setStage({ kind: "pick" }); }}>Make another</button>
              <span className="hint-text">Saved to Characters in your library.</span>
            </div>
          </div>
        ) : (
          <div className="maker-body">
            <button
              className={`maker-drop ${over ? "over" : ""} ${preview ? "has" : ""}`}
              onClick={() => !busy && input.current?.click()}
              disabled={busy}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                pick(e.dataTransfer.files?.[0]);
              }}
            >
              {preview ? (
                <img src={preview} alt="" />
              ) : (
                <>
                  <span className="up-icon">+</span>
                  <b>Add a picture</b>
                  <small>A person, creature or product. PNG, JPG or WebP — or paste one (⌘V).</small>
                </>
              )}
            </button>
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />

            <div className="maker-side">
              <label className="field-block">
                <span className="field-label">Name</span>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="e.g. Hero" disabled={busy} />
              </label>
              <div className="field-block">
                <span className="field-label">Resolution</span>
                <div className="seg" role="radiogroup" aria-label="Resolution">
                  {(["1K", "2K"] as const).map((s) => (
                    <button key={s} role="radio" aria-checked={size === s} className={size === s ? "on" : ""} onClick={() => setSize(s)} disabled={busy}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field-block">
                <span className="field-label">Model</span>
                <span className="maker-model">Nano Banana 2.1 · Comfy API</span>
              </div>

              {busy && (
                <div className="maker-progress">
                  <span>{stage.kind === "uploading" ? `Uploading ${Math.round(stage.p * 100)}%` : `Building the sheet… about ${Math.max(1, Math.round(est - (now - (stage as { since: number }).since) / 1000))} s`}</span>
                  <span className="depth-bar"><i style={{ width: `${Math.round((stage.kind === "uploading" ? stage.p * 0.15 : 0.15 + buildP * 0.85) * 100)}%` }} /></span>
                </div>
              )}
              {stage.kind === "error" && <div className="pack-error">{stage.message}</div>}

              <button className="generate" disabled={!file || busy} onClick={make}>
                {busy ? "Making…" : "Make character sheet"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
