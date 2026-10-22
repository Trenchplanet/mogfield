import { useEffect, useMemo, useState } from "react";
import type { PromptPack, Render } from "../../server/shared";
import { api } from "../api";
import { PRESET_LABEL } from "../camera";
import { endCard, titleCard } from "../cards";
import { lutLabel } from "../lut";

// ------------------------------------------------------------ graph flip

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;

// Shown until workflows/*.json exist: the shape of the Direct pipeline.
const OUTLINE: Graph = {
  "1": { class_type: "LoadVideo", inputs: {}, _meta: { title: "BL:video" } },
  "2": { class_type: "GetVideoComponents", inputs: { video: ["1", 0] } },
  "3": { class_type: "DepthAnythingV2Preprocessor", inputs: { image: ["2", 0] } },
  "4": { class_type: "BacklotCameraRig", inputs: { images: ["2", 0], depth: ["3", 0] }, _meta: { title: "BL:camera" } },
  "5": { class_type: "LTX 2.5 IC-LoRA v2v", inputs: { guide: ["4", 0], mask: ["4", 1] } },
  "6": { class_type: "BacklotLensKit", inputs: { images: ["5", 0], depth: ["3", 0] }, _meta: { title: "BL:lens" } },
  "7": { class_type: "BacklotGradeLUT", inputs: { images: ["6", 0] }, _meta: { title: "BL:grade" } },
  "8": { class_type: "BacklotLetterbox", inputs: { images: ["7", 0] }, _meta: { title: "BL:letterbox" } },
  "9": { class_type: "SaveVideo", inputs: { images: ["8", 0] }, _meta: { title: "BL:output" } },
};

export function GraphView({ name }: { name: string }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [installed, setInstalled] = useState(true);
  useEffect(() => {
    void api.workflow(name).then((g) => {
      setInstalled(!!g);
      setGraph(g ?? OUTLINE);
    });
  }, [name]);

  const layout = useMemo(() => {
    if (!graph) return null;
    const ids = Object.keys(graph);
    const deps = (id: string) =>
      Object.values(graph[id].inputs)
        .filter((v): v is [string, number] => Array.isArray(v) && typeof v[0] === "string" && v[0] in graph)
        .map((v) => v[0]);
    const depth = new Map<string, number>();
    const d = (id: string, seen = new Set<string>()): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const v = Math.max(-1, ...deps(id).map((x) => d(x, seen))) + 1;
      depth.set(id, v);
      return v;
    };
    ids.forEach((id) => d(id));
    const cols = new Map<number, string[]>();
    ids.forEach((id) => cols.set(depth.get(id)!, [...(cols.get(depth.get(id)!) ?? []), id]));
    const pos = new Map<string, { x: number; y: number }>();
    const W = 170, H = 62;
    for (const [c, list] of cols) list.forEach((id, i) => pos.set(id, { x: 20 + c * W, y: 20 + i * H + (c % 2) * 18 }));
    const edges = ids.flatMap((id) => deps(id).map((s) => ({ from: pos.get(s)!, to: pos.get(id)! })));
    const width = 40 + cols.size * W;
    const height = 60 + Math.max(...[...cols.values()].map((l) => l.length)) * H;
    return { pos, edges, width, height };
  }, [graph]);

  if (!graph || !layout) return <div className="graph-view">Loading graph…</div>;
  const download = () => {
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.json`;
    a.click();
  };
  return (
    <div className="graph-view">
      <div className="graph-head">
        <span>{installed ? `workflows/${name}.json` : "Pipeline outline (workflow not installed yet)"}</span>
        {installed && (
          <button onClick={download} title="Drop the file onto ComfyUI to open it">
            Open in ComfyUI ↗
          </button>
        )}
      </div>
      <div className="graph-scroll">
        <svg width={layout.width} height={layout.height}>
          {layout.edges.map((e, i) => (
            <path key={i} className="edge" d={`M${e.from.x + 140},${e.from.y + 20} C${e.from.x + 160},${e.from.y + 20} ${e.to.x - 20},${e.to.y + 20} ${e.to.x},${e.to.y + 20}`} />
          ))}
          {Object.entries(graph).map(([id, n]) => {
            const p = layout.pos.get(id)!;
            const ours = n.class_type.startsWith("Backlot");
            const ltx = /LTX/i.test(n.class_type);
            return (
              <g key={id} transform={`translate(${p.x},${p.y})`} className={`node ${ours ? "ours" : ""} ${ltx ? "ltx" : ""}`}>
                <rect width="140" height="40" rx="6" />
                <text x="8" y="16" className="node-class">{n.class_type.length > 22 ? n.class_type.slice(0, 21) + "…" : n.class_type}</text>
                <text x="8" y="31" className="node-title">#{id} {n._meta?.title ?? ""}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ share reel

export function ShareSheet({ render, repo, onClose }: { render: Render; repo: string; onClose: () => void }) {
  const [state, setState] = useState<{ url?: string; error?: string; busy: boolean }>({ busy: true });
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const t = await titleCard({
          take: render.take,
          lens: render.params.lens,
          look: render.params.lut === "none" ? "rec 709" : lutLabel(render.params.lut),
          move: PRESET_LABEL[render.params.camera],
        });
        const e = await endCard(repo);
        const { url } = await api.reel(render.id, t, e);
        if (live) setState({ url, busy: false });
      } catch (err) {
        if (live) setState({ error: (err as Error).message, busy: false });
      }
    })();
    return () => {
      live = false;
    };
  }, [render.id, repo]);

  const post = `One phone video, a whole new shot. Made with MOGFIELD.\n\n${repo}\n#OpenSourceHiggsfield @ComfyUI`;
  const share = async () => {
    if (!state.url) return;
    try {
      const blob = await fetch(state.url).then((r) => r.blob());
      const file = new File([blob], `backlot-take-${render.take}.mp4`, { type: "video/mp4" });
      if (navigator.canShare?.({ files: [file] })) return void (await navigator.share({ files: [file], text: post }));
    } catch {
      /* fall through to download */
    }
    const a = document.createElement("a");
    a.href = state.url;
    a.download = `backlot-take-${render.take}.mp4`;
    a.click();
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="share-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Share reel">
        <div className="share-phone">
          {state.busy && <div className="share-busy">Preparing video…</div>}
          {state.error && <div className="share-busy err">{state.error}</div>}
          {state.url && <video src={state.url} autoPlay loop muted playsInline controls />}
        </div>
        <div className="share-side">
          <h3>Share</h3>
          <p>A vertical before and after, ready to post.</p>
          <textarea readOnly value={post} rows={6} onFocus={(e) => e.currentTarget.select()} />
          <div className="share-actions">
            <button className="primary" disabled={!state.url} onClick={share}>
              Share
            </button>
            <button onClick={() => void navigator.clipboard.writeText(post)}>Copy caption</button>
            <a className="btn" href={`https://x.com/intent/post?text=${encodeURIComponent(post)}`} target="_blank" rel="noreferrer">
              Post on X
            </a>
            <button className="ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ seedance prompt pack

export function PackSheet({ state, onClose }: { state: { loading: string | null; pack: PromptPack | null; error: string | null }; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  };
  const { pack } = state;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="pack-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Seedance prompt">
        <div className="pack-head">
          <div>
            <h3>Seedance 2.5 prompt</h3>
            <p>Upload the files in this order, then paste the prompt and negative prompt.</p>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">Done</button>
        </div>
        {state.loading && (
          <div className="pack-loading">
            <svg className="ring spin" viewBox="0 0 48 48" aria-hidden>
              <circle cx="24" cy="24" r="20" className="ring-bg" />
              <circle cx="24" cy="24" r="20" className="ring-fg" style={{ strokeDashoffset: 90 }} />
            </svg>
            <span>{state.loading}</span>
          </div>
        )}
        {state.error && <div className="pack-error">{state.error}</div>}
        {pack && (
          <>
            <ol className="pack-uploads">
              {pack.uploads.map((u) => (
                <li key={u.tag}>
                  {u.tag === "@video1" ? <video src={u.url} muted loop autoPlay playsInline /> : <img src={u.url} alt="" />}
                  <span className="row-text">
                    <b>{u.tag}</b>
                    <small>{u.label}</small>
                  </span>
                  <a className="btn" href={u.url} download={`${u.tag.slice(1)}${u.tag === "@video1" ? ".mp4" : ""}`}>Download</a>
                </li>
              ))}
            </ol>
            <div className="pack-block">
              <div className="pack-block-head">
                <span>Prompt</span>
                <button onClick={() => copy("prompt", pack.prompt)}>{copied === "prompt" ? "Copied" : "Copy"}</button>
              </div>
              <pre>{pack.prompt}</pre>
            </div>
            <div className="pack-block">
              <div className="pack-block-head">
                <span>Negative prompt</span>
                <button onClick={() => copy("neg", pack.negative)}>{copied === "neg" ? "Copied" : "Copy"}</button>
              </div>
              <pre>{pack.negative}</pre>
            </div>
            <p className="pack-tip">Set motion or structure adherence high so the camera path stays locked. If faces drift, raise reference strength.</p>
          </>
        )}
      </div>
    </div>
  );
}
