import { useCallback, useEffect, useRef, useState } from "react";
import { FRAME_MODELS, T2V_ASPECTS, type AgentStage, type CastCard, type FrameModel, type T2vAspect } from "../../server/shared";
import { api, type AgentShotView, type AgentSummary, type AgentView } from "../api";
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
export function AgentPage(p: { images: CastCard[]; say: (m: string) => void }) {
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

  const open = useCallback((x: string | null) => {
    setId(x);
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

  const send = async (say = text) => {
    const msg = say.trim();
    if (!msg || busy || proj?.thinking) return;
    setBusy(true);
    try {
      const pr = proj ?? (await api.agentNew());
      if (!proj) open(pr.id);
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
  const pics = p.images.slice(0, 24);

  return (
    <div className="vp ag">
      <aside className="vp-panel ag-chat">
        <div className="ag-head">
          <select value={id ?? ""} onChange={(e) => open(e.target.value || null)} aria-label="Project">
            <option value="">New film</option>
            {list.map((x) => (
              <option key={x.id} value={x.id}>{x.title}</option>
            ))}
          </select>
          <span className="ag-badge" title="Agent mode is new: expect rough edges">Experimental</span>
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
              Cast{cast.length ? ` · ${cast.length}` : ""}
            </button>
            {cast.map((c, i) => {
              const img = p.images.find((x) => x.id === c);
              return img ? <img key={c} src={img.url} alt={img.prompt} title={`${i + 1}. ${img.prompt}`} /> : null;
            })}
          </div>
          {castOpen && (
            <div className="ag-cast-pick">
              {pics.length ? (
                pics.map((img) => (
                  <button key={img.id} className={cast.includes(img.id) ? "on" : ""} aria-pressed={cast.includes(img.id)} title={img.prompt} onClick={() => setCast((xs) => (xs.includes(img.id) ? xs.filter((x) => x !== img.id) : xs.length >= 12 ? xs : [...xs, img.id]))}>
                    <img src={img.url} alt={img.prompt} />
                    {cast.includes(img.id) && <span>{cast.indexOf(img.id) + 1}</span>}
                  </button>
                ))
              ) : (
                <small className="vp-hint">Make characters on the Image tab; they show up here.</small>
              )}
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
              <label>
                <span>Model</span>
                <select value={b.model} onChange={(e) => void act(() => api.agentBoard(proj!.id, { model: e.target.value }))}>
                  {(Object.keys(FRAME_MODELS) as FrameModel[]).map((m) => (
                    <option key={m} value={m}>{FRAME_MODELS[m].label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Quality</span>
                <select value={b.quality} onChange={(e) => void act(() => api.agentBoard(proj!.id, { quality: e.target.value }))}>
                  {FRAME_MODELS[b.model].qualities.map((q) => (
                    <option key={q} value={q}>{q}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Shape</span>
                <select value={b.aspect} onChange={(e) => void act(() => api.agentBoard(proj!.id, { aspect: e.target.value }))}>
                  {(Object.keys(T2V_ASPECTS) as T2vAspect[]).map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </label>
              <button className={`vp-audio ${b.audio ? "on" : ""}`} onClick={() => void act(() => api.agentBoard(proj!.id, { audio: !b.audio }))}>Sound {b.audio ? "on" : "off"}</button>
              <span className="ag-total">{shots.length} shots · {shots.reduce((t, s) => t + s.seconds, 0)} s</span>
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
