import { useEffect, useMemo, useRef, useState } from "react";
import { OpenInComfy } from "./OpenInComfy";
import type { CastCard } from "../../server/shared";
import { api } from "../api";

// What the user can add, grouped. `add` is what the image model is told.
const GROUPS: { title: string; items: { label: string; add: string }[] }[] = [
  {
    title: "Hair",
    items: [
      { label: "Mohawk", add: "a tall spiky mohawk hairstyle" },
      { label: "Buzz cut", add: "a short buzz cut" },
      { label: "Long hair", add: "long flowing hair past the shoulders" },
      { label: "Afro", add: "a big curly afro" },
      { label: "Bald", add: "a clean shaved bald head" },
      { label: "Pink hair", add: "hair dyed bright neon pink" },
      { label: "Blue hair", add: "hair dyed electric blue" },
      { label: "Platinum", add: "platinum blonde hair" },
    ],
  },
  {
    title: "Face",
    items: [
      { label: "Sunglasses", add: "dark sunglasses" },
      { label: "Glasses", add: "clear prescription glasses" },
      { label: "Full beard", add: "a full thick beard" },
      { label: "Mustache", add: "a bold mustache" },
      { label: "Face tattoos", add: "small face tattoos" },
      { label: "Piercings", add: "nose and ear piercings" },
      { label: "Scar", add: "a scar across one eyebrow" },
      { label: "Freckles", add: "freckles across the nose and cheeks" },
      { label: "Bold makeup", add: "bold dramatic makeup" },
    ],
  },
  {
    title: "Headwear",
    items: [
      { label: "Cap", add: "a baseball cap" },
      { label: "Beanie", add: "a knitted beanie" },
      { label: "Cowboy hat", add: "a cowboy hat" },
      { label: "Crown", add: "a golden crown" },
      { label: "Horns", add: "two curved horns growing from the head" },
      { label: "Headphones", add: "large over-ear headphones around the neck" },
    ],
  },
  {
    title: "Outfit",
    items: [
      { label: "Leather jacket", add: "a black leather jacket" },
      { label: "Hoodie", add: "an oversized hoodie" },
      { label: "Suit & tie", add: "a tailored suit with a tie" },
      { label: "Gold chains", add: "chunky gold chains around the neck" },
      { label: "Tracksuit", add: "a retro tracksuit" },
      { label: "Armor", add: "fantasy plate armor" },
    ],
  },
  {
    title: "Transform",
    items: [
      { label: "3D cartoon", add: "restyle the whole character as a polished 3D animated movie character" },
      { label: "Anime", add: "restyle the whole character in a clean anime style" },
      { label: "Cyborg", add: "cybernetic implants and metal plating on the face and arms" },
      { label: "Zombie", add: "zombie skin with grey tone and decay" },
      { label: "Alien", add: "alien skin with a subtle green tint and larger eyes" },
      { label: "Elf ears", add: "long pointed elf ears" },
    ],
  },
];
const ADD_BY_LABEL = new Map(GROUPS.flatMap((g) => g.items.map((i) => [i.label, i.add] as const)));

type Busy = { kind: "picture" | "board"; since: number } | null;

function useObjectUrl(file: File | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return setUrl(null);
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

function RefThumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useObjectUrl(file);
  return (
    <span className="cs-ref">
      {url && <img src={url} alt="" />}
      <button onClick={onRemove} aria-label="Remove reference">×</button>
    </span>
  );
}

/** Character Studio: photo → add elements → picture (repeat) → approve → character board. */
export function CharacterStudio(p: { images: CastCard[]; onNewCards: (cards: CastCard[]) => void; onUse: (card: CastCard) => void; say: (m: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [base, setBase] = useState<CastCard | null>(null); // the picture being edited, once it is on the server
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [refs, setRefs] = useState<File[]>([]);
  const [versions, setVersions] = useState<CastCard[]>([]);
  const [current, setCurrent] = useState<CastCard | null>(null);
  const [board, setBoard] = useState<CastCard | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [over, setOver] = useState(false);
  const [now, setNow] = useState(Date.now());
  const photoInput = useRef<HTMLInputElement>(null);
  const refInput = useRef<HTMLInputElement>(null);
  const fileUrl = useObjectUrl(file);
  const photoUrl = base?.url ?? fileUrl;
  const hasPhoto = !!photoUrl;

  // recent pictures to start from (not boards)
  const recent = useMemo(() => p.images.filter((i) => /\((photo|studio|image)\)$/.test(i.prompt)).slice(0, 12), [p.images]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [busy]);

  // paste a photo anywhere on the page
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const img = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (!img || busy) return;
      e.preventDefault();
      startFrom(new File([img], img.name && img.name !== "image.png" ? img.name : "Pasted photo.png", { type: img.type }));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const reset = () => {
    setVersions([]);
    setCurrent(null);
    setBoard(null);
    setError(null);
  };
  const startFrom = (f: File | undefined) => {
    if (!f || !f.type.startsWith("image/")) return;
    setFile(f);
    setBase(null);
    if (!name) setName(f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/^Pasted photo$/, "").slice(0, 40));
    reset();
  };
  const startFromCard = (c: CastCard) => {
    setFile(null);
    setBase(c);
    if (!name) setName(c.prompt.replace(/\s*\((photo|studio|image)\)$/, "").slice(0, 40));
    reset();
  };
  const toggle = (label: string) => setPicked((xs) => (xs.includes(label) ? xs.filter((x) => x !== label) : [...xs, label]));

  const makePicture = async (from: CastCard | null = base) => {
    if (!hasPhoto || busy) return;
    setError(null);
    setBoard(null);
    setBusy({ kind: "picture", since: Date.now() });
    try {
      const r = await api.studioPicture({
        file: from ? undefined : file ?? undefined,
        baseId: from?.id,
        name: name.trim() || "Character",
        elements: picked.map((l) => ADD_BY_LABEL.get(l) ?? l),
        note,
        refs,
      });
      setBase(r.base);
      setFile(null);
      setVersions((v) => [r.picture, ...v]);
      setCurrent(r.picture);
      p.onNewCards([r.picture, ...(from ? [] : [r.base])]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // keep editing: the current result becomes the photo, and the chosen elements start over
  const continueFrom = () => {
    if (!current) return;
    setBase(current);
    setPicked([]);
    setNote("");
    setRefs([]);
    setBoard(null);
    p.say("Now editing the new picture. Pick what to add next.");
  };

  const makeBoard = async () => {
    if (!current || busy) return;
    setError(null);
    setBusy({ kind: "board", since: Date.now() });
    try {
      const card = await api.studioBoard({ pictureId: current.id, name: name.trim() || "Character", size: "2K" });
      setBoard(card);
      p.onNewCards([card]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const step = board ? 4 : current ? 3 : hasPhoto ? 2 : 1;
  const est = busy?.kind === "board" ? 40 : 25;
  const pct = busy ? Math.min(0.95, (now - busy.since) / 1000 / est) : 0;
  const changes = picked.length + (note.trim() ? 1 : 0) + refs.length;

  return (
    <div className="cs-page">
      <header className="cs-head">
        <div>
          <h2>Character Studio</h2>
          <p>Start from a photo, add what you want, check the picture, then turn it into a character board for your videos.</p>
          <OpenInComfy say={p.say} settings={() => ({ tool: "image", elements: picked.map((l) => ADD_BY_LABEL.get(l) ?? l), prompt: note })} />
        </div>
        <ol className="cs-steps" aria-label="Steps">
          {["Photo", "Add elements", "Picture", "Character board"].map((s, i) => (
            <li key={s} className={i + 1 < step ? "done" : i + 1 === step ? "on" : ""}><span>{i + 1}</span>{s}</li>
          ))}
        </ol>
      </header>

      <div className="cs-grid">
        {/* 1 · photo */}
        <section className="cs-card">
          <h3><span className="cs-num">1</span> Photo</h3>
          <button
            className={`cs-drop ${over ? "over" : ""} ${hasPhoto ? "has" : ""}`}
            onClick={() => !busy && photoInput.current?.click()}
            disabled={!!busy}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); startFrom(e.dataTransfer.files?.[0]); }}
          >
            {photoUrl ? <img src={photoUrl} alt="Photo being edited" /> : (
              <>
                <span className="up-icon">+</span>
                <b>Add a photo</b>
                <small>Drop, click or paste (⌘V). A clear, front-facing photo works best.</small>
              </>
            )}
          </button>
          {hasPhoto && <small className="cs-hint">{base && versions.some((v) => v.id === base.id) ? "Editing your last picture." : "Click the photo to replace it."}</small>}
          <input ref={photoInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { startFrom(e.target.files?.[0]); e.target.value = ""; }} />
          {recent.length > 0 && (
            <div className="cs-recent">
              <span className="field-label">Or start from one of yours</span>
              <div className="cs-recent-row">
                {recent.map((c) => (
                  <button key={c.id} className={base?.id === c.id ? "on" : ""} onClick={() => startFromCard(c)} disabled={!!busy} title={c.prompt}>
                    <img src={c.url} alt={c.prompt} />
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="field-block">
            <span className="field-label">Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="e.g. Mohawk" disabled={!!busy} />
          </label>
        </section>

        {/* 2 · elements */}
        <section className={`cs-card ${hasPhoto ? "" : "dim"}`}>
          <h3><span className="cs-num">2</span> Add elements {changes > 0 && <span className="lp-count">{changes}</span>}</h3>
          <div className="cs-groups">
            {GROUPS.map((g) => (
              <div key={g.title} className="cs-group">
                <span className="field-label">{g.title}</span>
                <div className="cs-chips">
                  {g.items.map((i) => (
                    <button key={i.label} className={`opt ${picked.includes(i.label) ? "on" : ""}`} aria-pressed={picked.includes(i.label)} onClick={() => toggle(i.label)} disabled={!hasPhoto || !!busy}>
                      {i.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <label className="field-block">
            <span className="field-label">Anything else</span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.stopPropagation()} maxLength={600} placeholder="e.g. a red bandana around the neck, glowing purple eyes" disabled={!hasPhoto || !!busy} />
          </label>
          <div className="field-block">
            <span className="field-label">Reference pictures (optional)</span>
            <div className="cs-refs">
              {refs.map((f, i) => <RefThumb key={`${f.name}-${i}`} file={f} onRemove={() => setRefs((xs) => xs.filter((_, k) => k !== i))} />)}
              {refs.length < 3 && (
                <button className="cs-ref add" onClick={() => refInput.current?.click()} disabled={!hasPhoto || !!busy} title="Add a picture of an item to copy, like specific glasses">+</button>
              )}
            </div>
            <small className="cs-hint">Show the exact glasses, hat or outfit you want; it is copied onto the character.</small>
            <input ref={refInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { setRefs((xs) => [...xs, ...Array.from(e.target.files ?? [])].slice(0, 3)); e.target.value = ""; }} />
          </div>
          <button className="generate" onClick={() => void makePicture()} disabled={!hasPhoto || !changes || !!busy}>
            {busy?.kind === "picture" ? "Making the picture…" : current ? "Make a new picture" : "Make picture"}
          </button>
        </section>

        {/* 3 + 4 · picture and board */}
        <section className="cs-card cs-result">
          <h3><span className="cs-num">{board ? 4 : 3}</span> {board ? "Character board" : "Picture"}</h3>
          {busy && (
            <div className="maker-progress">
              <span>{busy.kind === "picture" ? "Adding your elements" : "Drawing the character board"}… about {Math.max(1, Math.round(est - (now - busy.since) / 1000))} s</span>
              <span className="depth-bar"><i style={{ width: `${Math.round(pct * 100)}%` }} /></span>
            </div>
          )}
          {error && <div className="pack-error">{error}</div>}

          {board ? (
            <>
              <img className="cs-board" src={board.url} alt={`${board.prompt} character board`} />
              <div className="cs-actions">
                <button className="accent" onClick={() => p.onUse(board)}>Use in a video</button>
                <button onClick={() => setBoard(null)}>Back to the picture</button>
              </div>
              <small className="cs-hint">Saved to Characters as “{board.prompt}”.</small>
            </>
          ) : current ? (
            <>
              <div className="cs-compare">
                <img src={comparing && photoUrl ? photoUrl : current.url} alt={comparing ? "Before" : "After"} />
                <button
                  className="chip cs-hold"
                  onPointerDown={() => setComparing(true)}
                  onPointerUp={() => setComparing(false)}
                  onPointerLeave={() => setComparing(false)}
                >
                  {comparing ? "Before" : "Hold to compare"}
                </button>
              </div>
              {versions.length > 1 && (
                <div className="cs-versions" aria-label="Versions">
                  {versions.map((v, i) => (
                    <button key={v.id} className={current.id === v.id ? "on" : ""} onClick={() => setCurrent(v)} title={`Version ${versions.length - i}`}>
                      <img src={v.url} alt={`Version ${versions.length - i}`} />
                    </button>
                  ))}
                </div>
              )}
              <div className="cs-actions">
                <button className="accent" onClick={makeBoard} disabled={!!busy}>{busy?.kind === "board" ? "Making the board…" : "Looks good: make the character board"}</button>
                <button onClick={() => void makePicture()} disabled={!!busy || !changes}>Try again</button>
                <button onClick={continueFrom} disabled={!!busy}>Keep editing this one</button>
              </div>
            </>
          ) : (
            <div className="cs-empty">
              <b>{hasPhoto ? "Pick what to add, then Make picture." : "Start with a photo."}</b>
              <small>You'll see the result here before anything becomes a character board.</small>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
