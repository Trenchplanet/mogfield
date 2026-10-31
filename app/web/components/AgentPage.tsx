import { useCallback, useEffect, useRef, useState } from "react";
import { FRAME_MODELS, T2V_ASPECTS, type AgentSettings, type AgentStage, type CastCard, type FrameModel, type T2vAspect } from "../../server/shared";
import { api, type AgentShotView, type AgentSummary, type AgentView, type DirectorStatus } from "../api";
import { saveToPhotos } from "../save";

const STAGES: { id: AgentStage; label: string }[] = [
  { id: "brief", label: "Brief" },
  { id: "board", label: "Storyboard" },
  { id: "frames", label: "Key frames" },
  { id: "shots", label: "Filming" },
  { id: "film", label: "Film" },
];

const STARTERS = [
  "A 20 s moody perfume ad: a woman walks through a rainy neon street at night",
  "Trailer for a cosy fantasy film about a fox who runs a tiny bakery",
  "My character in a 15 s action teaser: rooftop chase at golden hour, handheld",
];

const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(2)}`;
const KEY = "mogfield.agent.project";

/** Agent mode (experimental): talk to a director, approve the storyboard, the frames and the shots. */
export function AgentPage(p: { images: CastCard[]; models: { id: string; available: boolean }[]; say: (m: string) => void }) {
  const [list, setList] = useState<AgentSummary[]>([]);
  const [id, setId] = useState<string | null>(() => {
    try {
      // a link can open one project (?page=agent&project=…)
      return new URLSearchParams(location.search).get("project") ?? localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  const [proj, setProj] = useState<AgentView | null>(null);
  const [text, setText] = useState("");
  const [cast, setCast] = useState<string[]>([]);
  const [castOpen, setCastOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  // a new project: its name and workflow, before the first message
  const local = p.models.some((m) => m.id.startsWith("pika:") && m.available);
  const fresh = (): AgentSettings => ({ model: local ? "pika-h3" : "seedance-2-0-fast", quality: "480p", aspect: "9:16", audio: true });
  const [draft, setDraft] = useState<{ title: string } & AgentSettings>(() => ({ title: "", ...fresh() }));
  const [renaming, setRenaming] = useState<string | null>(null);

  const open = useCallback((x: string | null) => {
    setId(x);
    // nothing carries over from another project: its cast stays with it
    if (!x) {
      setCast([]);
      setText("");
    }
    try {
      if (x) localStorage.setItem(KEY, x);
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode */
    }
  }, []);

  useEffect(() => {
    void api.agentList().then(setList).catch(() => {});
  }, [proj?.title, proj?.stage]);

  useEffect(() => {
    if (!id) return setProj(null);
    void api
      .agentGet(id)
      .then((x) => {
        setProj(x);
        setCast(x.castIds);
        setRenaming(null);
      })
      .catch(() => open(null));
  }, [id, open]);

  // keep the project fresh while something is working on it
  const working =
    !!proj &&
    (!!proj.thinking ||
      proj.film?.status === "running" ||
      !!proj.board?.shots.some((s) => s.frame?.status === "running" || s.take?.status === "running" || s.take?.status === "queued") ||
      (proj.stage === "shots" && !proj.film));
  useEffect(() => {
    if (!working || !id) return;
    const t = setInterval(() => void api.agentGet(id).then(setProj).catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [working, id]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [proj?.messages.length, proj?.thinking]);

  const act = async (fn: () => Promise<AgentView>) => {
    setBusy(true);
    try {
      setProj(await fn());
    } catch (e) {
      p.say((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** The project's cast, saved with it as soon as it changes. */
  const setProjectCast = async (next: string[]) => {
    setCast(next);
    if (proj) await api.agentUpdate(proj.id, { castIds: next }).then(setProj).catch((e: Error) => p.say(e.message));
  };
  const addPicture = async (f: File) => {
    try {
      // uploaded into this project only: it does not land in the shared library
      const card = await api.cast({ file: f, kind: "character", saved: false });
      await setProjectCast([...cast, card.id].slice(0, 12));
      if (!proj) setExtra((xs) => [...xs, { id: card.id, url: card.url, prompt: card.prompt }]);
    } catch (e) {
      p.say((e as Error).message);
    }
  };
  // pictures uploaded into a project that is not created yet
  const [extra, setExtra] = useState<{ id: string; url: string; prompt: string }[]>([]);
  const castCards = [...(proj?.cast ?? []), ...extra.filter((x) => !proj?.cast.some((c) => c.id === x.id)), ...p.images.map((i) => ({ id: i.id, url: i.url, prompt: i.prompt }))];
  const picture = (cid: string) => castCards.find((x) => x.id === cid);

  const create = async () => {
    setBusy(true);
    try {
      const pr = await api.agentNew({ ...draft, title: draft.title.trim() || undefined, castIds: cast });
      open(pr.id);
      setProj(pr);
      setExtra([]);
      setDraft({ title: "", ...fresh() });
      return pr;
    } catch (e) {
      p.say((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!proj || !confirm(`Delete the project “${proj.title}”? Its storyboard, frames and chat are removed; finished takes stay in History.`)) return;
    await api.agentDelete(proj.id).catch(() => {});
    open(null);
    void api.agentList().then(setList).catch(() => {});
  };

  const rename = async () => {
    const title = renaming?.trim();
    setRenaming(null);
    if (proj && title && title !== proj.title) await act(() => api.agentUpdate(proj.id, { title }));
  };

  const send = async (say = text) => {
    const msg = say.trim();
    if (!msg || busy || proj?.thinking) return;
    setBusy(true);
    try {
      const pr = proj ?? (await api.agentNew({ ...draft, title: draft.title.trim() || undefined, castIds: cast }));
      if (!proj) {
        open(pr.id);
        setExtra([]);
      }
      setText("");
      setProj(await api.agentSay(pr.id, msg, cast));
    } catch (e) {
      p.say((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const b = proj?.board;
  const shots = b?.shots ?? [];
  const drawn = shots.filter((s) => s.frame?.status === "succeeded").length;
  const drawing = shots.some((s) => s.frame?.status === "running");
  const filmed = shots.filter((s) => s.take?.status === "succeeded").length;
  const stageAt = STAGES.findIndex((s) => s.id === (proj?.stage ?? "brief"));
  const pics = p.images.slice(0, 24).filter((i) => !cast.includes(i.id));
  const settings: AgentSettings = proj?.settings ?? draft;
  const setSettings = (patch: Partial<AgentSettings>) => {
    const model = patch.model ?? settings.model;
    const qs = FRAME_MODELS[model].qualities;
    const next = { ...settings, ...patch, quality: qs.includes(patch.quality ?? settings.quality) ? (patch.quality ?? settings.quality) : qs[0] };
    if (!proj) setDraft((d) => ({ ...d, ...next }));
    // with a storyboard the board's own settings are the project's workflow
    else if (proj.board) void act(() => api.agentBoard(proj.id, patch));
    else void act(() => api.agentUpdate(proj.id, { settings: next }));
  };

  return (
    <div className="vp ag">
      <aside className="vp-panel ag-chat">
        <div className="ag-head">
          {renaming !== null ? (
            <input className="ag-rename" autoFocus value={renaming} maxLength={80} aria-label="Project name" onChange={(e) => setRenaming(e.target.value)} onBlur={() => void rename()} onKeyDown={(e) => { if (e.key === "Enter") void rename(); if (e.key === "Escape") setRenaming(null); }} />
          ) : (
            <select value={id ?? ""} onChange={(e) => open(e.target.value || null)} aria-label="Project">
              <option value="">＋ New project</option>
              {list.map((x) => (
                <option key={x.id} value={x.id}>{x.title}{x.cast ? ` · ${x.cast} cast` : ""}</option>
              ))}
            </select>
          )}
          {proj && renaming === null && (
            <>
              <button className="ag-icon" title="Rename project" aria-label="Rename project" onClick={() => setRenaming(proj.title)}>✎</button>
              {proj.board && <a className="ag-icon" title="Download this project's ComfyUI workflow" aria-label="Download workflow" href={`/api/agent/${proj.id}/workflow`} download>⤓</a>}
              <button className="ag-icon" title="Delete project" aria-label="Delete project" onClick={() => void remove()}>🗑</button>
            </>
          )}
          <span className="ag-badge" title="Agent mode is new: expect rough edges">Experimental</span>
        </div>

        {local && <DirectorPicker say={p.say} />}

        {!proj && (
          <div className="ag-new">
            <b>New project</b>
            <small>Each project keeps its own workflow, characters, storyboard and chat.</small>
            <div className="ag-new-row">
              <input value={draft.title} maxLength={80} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && void create()} placeholder="Project name" aria-label="Project name" />
              <button disabled={busy} onClick={() => void create()}>Create</button>
            </div>
          </div>
        )}
        <div className="ag-settings ag-project-settings" aria-label="Project workflow">
          <label>
            <span>Model</span>
            <select value={settings.model} onChange={(e) => setSettings({ model: e.target.value as FrameModel })}>
              {(Object.keys(FRAME_MODELS) as FrameModel[]).map((m) => (
                <option key={m} value={m} disabled={m === "pika-h3" && !local}>{FRAME_MODELS[m].label}{m === "pika-h3" && !local ? " (LOCAL only)" : ""}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Quality</span>
            <select value={settings.quality} onChange={(e) => setSettings({ quality: e.target.value })}>
              {FRAME_MODELS[settings.model].qualities.map((q) => (
                <option key={q} value={q}>{q}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Shape</span>
            <select value={settings.aspect} onChange={(e) => setSettings({ aspect: e.target.value as T2vAspect })}>
              {(Object.keys(T2V_ASPECTS) as T2vAspect[]).map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </label>
          <button className={`vp-audio ${settings.audio ? "on" : ""}`} onClick={() => setSettings({ audio: !settings.audio })}>Sound {settings.audio ? "on" : "off"}</button>
        </div>

        <div className="vp-body ag-log" ref={log}>
          {!proj?.messages.length && (
            <div className="vp-hero ag-hero">
              <b>Direct a film by talking</b>
              <span>Say what you want to make. The director answers in film language, writes a storyboard and asks you to approve it, then the key frames, then the filming. Nothing costs anything until you approve it.</span>
              <div className="ag-starters">
                {STARTERS.map((s) => (
                  <button key={s} onClick={() => setText(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {proj?.messages.map((m, i) => (
            <div key={i} className={`ag-msg ${m.role}`}>
              <p>{m.text}</p>
              {!!m.questions?.length && (
                <div className="ag-qs">
                  {m.questions.map((q) => (
                    <button key={q} onClick={() => setText((t) => (t ? `${t}\n` : "") + `${q} `)}>{q}</button>
                  ))}
                  <button className="ag-you-decide" onClick={() => void send("You decide, go with your best idea.")}>You decide</button>
                </div>
              )}
            </div>
          ))}
          {proj?.thinking && (
            <div className="ag-msg agent ag-typing" aria-live="polite"><p><i /><i /><i /> The director is thinking</p></div>
          )}
        </div>

        <div className="vp-foot ag-compose">
          <div className="ag-cast">
            <button className={`ag-cast-toggle ${castOpen ? "on" : ""}`} onClick={() => setCastOpen((x) => !x)}>
              {proj ? "Project cast" : "Cast"}{cast.length ? ` · ${cast.length}` : ""}
            </button>
            {cast.map((c, i) => {
              const img = picture(c);
              return img ? <img key={c} src={img.url} alt={img.prompt} title={`${i + 1}. ${img.prompt}`} /> : null;
            })}
          </div>
          {castOpen && (
            <div className="ag-cast-pick">
              {/* this project's characters first: tap to take one out of the project */}
              {cast.map((cid, i) => {
                const img = picture(cid);
                return img ? (
                  <button key={cid} className="on" aria-pressed title={`${img.prompt} · tap to remove from this project`} onClick={() => void setProjectCast(cast.filter((x) => x !== cid))}>
                    <img src={img.url} alt={img.prompt} />
                    <span>{i + 1}</span>
                  </button>
                ) : null;
              })}
              <button className="ag-cast-add" onClick={() => upload.current?.click()} disabled={cast.length >= 12} title="Upload a character into this project only">＋</button>
              <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void addPicture(f); e.target.value = ""; }} />
              {pics.length > 0 && <small className="vp-hint ag-cast-sep">From your library</small>}
              {pics.map((img) => (
                <button key={img.id} title={img.prompt} disabled={cast.length >= 12} onClick={() => void setProjectCast([...cast, img.id])}>
                  <img src={img.url} alt={img.prompt} />
                </button>
              ))}
            </div>
          )}
          <div className="ag-input">
            <textarea
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={b ? "Ask for changes: “make shot 2 a low-angle close-up”" : "What do you want to make?"}
            />
            <button className="ag-send" disabled={busy || !!proj?.thinking || !text.trim()} onClick={() => void send()} aria-label="Send">
              <svg viewBox="0 0 24 24" aria-hidden><path d="M12 19V5M5 12l7-7 7 7" /></svg>
            </button>
          </div>
        </div>
      </aside>

      <section className="vp-main ag-main">
        <ol className="ag-steps" aria-label="Progress">
          {STAGES.map((s, i) => (
            <li key={s.id} className={i < stageAt ? "done" : i === stageAt ? "on" : ""}>{s.label}</li>
          ))}
        </ol>

        {!b ? (
          <div className="ag-empty">
            <b>No storyboard yet</b>
            <span>Your storyboard shows up here: every shot with its size, angle, lens, movement and light.</span>
          </div>
        ) : (
          <div className="ag-board">
            {proj?.film?.status === "succeeded" && proj.film.url && (
              <div className="ag-film">
                <video src={proj.film.url} controls playsInline preload="metadata" />
                <a className="btn" href={proj.film.url} download={`mogfield-${b.title}.mp4`} {...saveToPhotos(proj.film.url, `mogfield-${b.title}.mp4`)}>Download film</a>
              </div>
            )}
            <header className="ag-title">
              <h2>{b.title}</h2>
              {b.logline && <p>{b.logline}</p>}
              {b.style && <small>Look: {b.style}</small>}
            </header>
            <div className="ag-settings">
              <span className="ag-total">{FRAME_MODELS[b.model].label} · {b.quality} · {b.aspect} · {shots.length} shots · {shots.reduce((t, s) => t + s.seconds, 0)} s</span>
            </div>

            <div className={`ag-shots r${b.aspect.replace(":", "x")}`}>
              {shots.map((s, i) => (
                <ShotCard key={s.id} n={i + 1} shot={s} aspect={T2V_ASPECTS[b.aspect]} busy={busy}
                  onRedraw={() => void act(() => api.agentFrames(proj!.id, [s.id]))}
                  onApprove={(v) => void act(() => api.agentApprove(proj!.id, s.id, v))}
                  onRetake={() => void act(() => api.agentFilm(proj!.id, [s.id]))}
                  onSeconds={(v) => void act(() => api.agentBoard(proj!.id, { shot: { id: s.id, seconds: v } }))}
                />
              ))}
            </div>
          </div>
        )}

        {b && (
          <div className="ag-gate">
            {proj!.stage === "board" && (
              <>
                <span>Happy with the storyboard? Next: a key frame for each shot, using your cast.</span>
                <button className="vp-go" disabled={busy || drawing} onClick={() => void act(() => api.agentFrames(proj!.id))}>
                  {drawn === shots.length ? "Use these frames" : `Approve storyboard · draw ${shots.length - drawn} frame${shots.length - drawn === 1 ? "" : "s"} · ~${usd(proj!.quote.frames)}`}
                </button>
              </>
            )}
            {proj!.stage === "frames" && (
              <>
                <span>{drawing ? `Drawing frames… ${drawn}/${shots.length}` : drawn < shots.length ? `${shots.length - drawn} shot${shots.length - drawn === 1 ? " still needs" : "s still need"} a key frame.` : "Redraw any frame you don't like, then film every shot from its frame."}</span>
                {drawn < shots.length && !drawing ? (
                  <button className="vp-go" disabled={busy} onClick={() => void act(() => api.agentFrames(proj!.id))}>
                    {`Draw ${shots.length - drawn} more frame${shots.length - drawn === 1 ? "" : "s"} · ~${usd(proj!.quote.frames)}`}
                  </button>
                ) : (
                  <button className="vp-go" disabled={busy || drawing} onClick={() => void act(() => api.agentFilm(proj!.id))}>
                    {`Approve frames · film ${shots.length} shots · ~${usd(proj!.quote.shots)}`}
                  </button>
                )}
              </>
            )}
            {proj!.stage === "shots" && (
              <span>{proj!.film?.status === "running" ? "Cutting the film together…" : proj!.film?.status === "failed" ? `Cutting failed: ${proj!.film.error}` : `Filming… ${filmed}/${shots.length} shots done. You can retake any shot.`}</span>
            )}
            {proj!.stage === "film" && <span>Your film is ready. Ask the director for changes, retake a shot, or start a new film.</span>}
          </div>
        )}
      </section>
    </div>
  );
}

/** On LOCAL: which model directs, at which quantization, and the command that starts it. */
function DirectorPicker(p: { say: (m: string) => void }) {
  const [st, setSt] = useState<DirectorStatus | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => void api.directorGet().then(setSt).catch(() => {}), []);
  useEffect(load, [load]);
  if (!st) return null;
  const model = st.models.find((m) => m.repo === st.choice.repo) ?? st.models[0];
  // llama-server names the model after its file; the chosen quantization should be in it
  const loadedOk = st.running && (st.loaded ?? []).some((x) => x.toUpperCase().includes(st.choice.quant.toUpperCase()));
  const pick = async (repo: string, quant: string) => {
    try {
      await api.directorSet(repo, quant);
      load();
    } catch (e) {
      p.say((e as Error).message);
    }
  };
  return (
    <div className={`ag-director ${open ? "open" : ""}`}>
      <button className="ag-director-head" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        <i className={loadedOk ? "ok" : st.running ? "warn" : "bad"} aria-hidden />
        <span>Director <b>{st.label}</b></span>
        <small>{loadedOk ? "running" : st.running ? "another model is loaded" : "not running"}</small>
      </button>
      {open && (
        <div className="ag-director-body">
          <label>
            <span>Model</span>
            <select value={model.repo} onChange={(e) => { const m = st.models.find((x) => x.repo === e.target.value)!; void pick(m.repo, m.quants.some((q) => q.quant === m.quant) ? m.quant : m.quants[0]?.quant ?? m.quant); }}>
              {st.models.map((m) => (
                <option key={m.repo} value={m.repo}>{m.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Quantization</span>
            <select value={st.choice.quant} onChange={(e) => void pick(model.repo, e.target.value)}>
              {(model.quants.length ? model.quants : [{ quant: st.choice.quant, gb: 0 }]).map((q) => (
                <option key={q.quant} value={q.quant}>{q.quant}{q.gb ? ` · ${q.gb} GB` : ""}</option>
              ))}
            </select>
          </label>
          <small>{model.note} <a href={`https://huggingface.co/${model.repo}`} target="_blank" rel="noreferrer">Hugging Face</a></small>
          {model.uncensored && <small className="vp-warn">Refusals removed: the director's rules (no celebrity likenesses, real people only from your own pictures, no logos) are only prompt instructions to this model.</small>}
          <span className="vp-label">{loadedOk ? "Running at" : "Start it on the machine that runs it"}</span>
          {loadedOk ? (
            <code>{st.url}</code>
          ) : (
            <div className="ag-director-cmd">
              <code>{st.command}</code>
              <button onClick={() => void navigator.clipboard?.writeText(st.command).then(() => p.say("Copied the command"), () => {})}>Copy</button>
            </div>
          )}
          <small>The first start downloads the file from Hugging Face. On API the director is {st.cloud} through the Comfy API.</small>
          <button className="ag-director-check" onClick={load}>Check again</button>
        </div>
      )}
    </div>
  );
}

function ShotCard(p: { n: number; shot: AgentShotView; aspect: number; busy: boolean; onRedraw: () => void; onApprove: (v: boolean) => void; onRetake: () => void; onSeconds: (v: number) => void }) {
  const s = p.shot;
  const [more, setMore] = useState(false);
  const take = s.take;
  return (
    <article className={`ag-shot ${s.frameApproved ? "ok" : ""}`}>
      <div className="ag-frame" style={{ aspectRatio: String(p.aspect) }}>
        {take?.status === "succeeded" && take.url ? (
          <video src={take.url} poster={s.frame?.url} controls playsInline preload="none" />
        ) : s.frame?.url ? (
          <img src={s.frame.url} alt={s.title} />
        ) : (
          <span className="ag-frame-empty">{s.frame?.status === "running" ? "Drawing…" : s.frame?.status === "failed" ? "Frame failed" : `Shot ${p.n}`}</span>
        )}
        {s.frame?.status === "running" && <i className="ag-spin" aria-hidden />}
        {take && take.status !== "succeeded" && (
          <span className={`ag-take ${take.status}`}>{take.status === "failed" ? "Take failed" : `${Math.round(take.progress * 100)}% · ${take.message}`}</span>
        )}
        <b className="ag-n">{p.n}</b>
      </div>
      <div className="ag-shot-body">
        <div className="ag-shot-top">
          <b>{s.title}</b>
          <select value={s.seconds} onChange={(e) => p.onSeconds(Number(e.target.value))} aria-label="Length" disabled={p.busy}>
            {Array.from({ length: 30 }, (_, i) => i + 1).map((x) => (
              <option key={x} value={x}>{x}s</option>
            ))}
          </select>
        </div>
        <div className="ag-tags">
          {[s.size, s.angle, s.movement, s.lens].filter(Boolean).map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <p>{s.action}</p>
        {s.lighting && <small>Light: {s.lighting}</small>}
        {s.sound && <small>Sound: {s.sound}</small>}
        {s.frame?.error && <small className="vp-warn">{s.frame.error}</small>}
        {take?.error && <small className="vp-warn">{take.error}</small>}
        <button className="ag-more" onClick={() => setMore((x) => !x)}>{more ? "Hide prompts" : "Prompts"}</button>
        {more && (
          <div className="ag-prompts">
            <small><b>Frame</b> {s.framePrompt}</small>
            <small><b>Video</b> {s.videoPrompt}</small>
          </div>
        )}
        <div className="ag-shot-actions">
          {s.frame?.status === "succeeded" && !s.takeId && (
            <button className={s.frameApproved ? "on" : ""} onClick={() => p.onApprove(!s.frameApproved)} disabled={p.busy}>{s.frameApproved ? "✓ Approved" : "Approve"}</button>
          )}
          {s.frame && s.frame.status !== "running" && !s.takeId && <button onClick={p.onRedraw} disabled={p.busy}>Redraw</button>}
          {take && take.status !== "running" && take.status !== "queued" && <button onClick={p.onRetake} disabled={p.busy}>Retake</button>}
        </div>
      </div>
    </article>
  );
}
