import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

/** The workflows behind MOGFIELD, each one a ComfyUI graph you can open and run yourself. */
export const WORKFLOWS: { name: string; label: string; line: string }[] = [
  { name: "backlot_pika_h3_ref2va", label: "Pika H3 Flex · reference (local)", line: "Your take, its sound and your character go into Pika H3 Flex on your own ComfyUI: swap, restyle or re-shoot." },
  { name: "backlot_pika_h3_fl2va", label: "Pika H3 Flex · frames (local)", line: "A start frame, and optionally an end frame, filmed by Pika H3 Flex with sound. Create, Extend and the director's shots." },
  { name: "backlot_h3_swap", label: "Character swap · H3", line: "Your video and character go into MiniMax H3, which films the same motion again with your character in it." },
  { name: "mogfield_seedance_restyle", label: "Character swap · Seedance", line: "The video and your character pictures go to Seedance as references: same motion, new person." },
  { name: "backlot_genjustsu_sam", label: "Person masks · SAM 3", line: "Tracks the person you picked through every shot, so only they get swapped." },
  { name: "backlot_depth", label: "Depth map", line: "Depth Anything V2 turns each frame into depth: the motion without the look." },
  { name: "mogfield_seedance_reshoot", label: "Re-shoot", line: "Seedance reads the whole take and films the same moment from a new camera angle." },
  { name: "mogfield_seedance_t2v", label: "Text to video", line: "A prompt and optional reference pictures straight into Seedance." },
  { name: "backlot_recast", label: "Recast · LTX 2.5 (local)", line: "Runs on your own GPU: the depth guides LTX 2.5 through an IC-LoRA while your references set the look." },
  { name: "backlot_direct", label: "Camera & lens (local)", line: "A virtual camera move, lens and colour grade through the depth map, no AI generation." },
];

/** Stages, the way you would group a ComfyUI graph. A node goes to the first stage whose test matches; `at` is the column, left to right. */
const STAGES: { key: string; label: string; tint: string; at: number; test: RegExp }[] = [
  { key: "in", label: "Inputs", at: 0, tint: "48,209,88", test: /^(LoadVideo|LoadImage|LoadAudio|GetVideoComponents|GetImageSize)$/ },
  { key: "out", label: "Output", at: 5, tint: "255,55,95", test: /Decode|CreateVideo|^Save|Letterbox|GradeLUT|LensKit|CameraRig|VideoOutput|MaskToImage|SeparateAVLatent|CropGuides/ },
  { key: "models", label: "Models", at: 1, tint: "152,152,157", test: /Loader|LoRA|SigmaShift|LoadSAM/i },
  { key: "prep", label: "Prepare", at: 2, tint: "255,159,10", test: /Resize|Trim|FromBatch|RepeatImage|Depth|Mask|Preprocessor|Segmentation|Propagate|Upscale/i },
  { key: "prompt", label: "Prompt", at: 3, tint: "191,90,242", test: /TextEncode|Conditioning|Guide|Prompt/i },
  { key: "gen", label: "Generate", at: 4, tint: "10,132,255", test: /./ },
];

/** "ResizeImageMaskNode" -> "Resize Image Mask"; our "BL:" titles name what the node is for. */
function nodeName(cls: string, title?: string) {
  if (title && !title.startsWith("BL:")) return title;
  return cls.replace(/Node(V\d)?$|Api$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}
/** Up to two short settings worth seeing on the card (model, resolution, length…). */
function nodeFacts(inputs: Record<string, unknown>) {
  return Object.entries(inputs)
    .filter(([k, v]) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean") && !/seed|prompt|filename|watermark|format|codec/i.test(k) && String(v).length < 28)
    .slice(0, 2)
    .map(([k, v]) => `${k.replace(/^model\./, "")}: ${String(v)}`);
}

export function GraphView({ name: initial }: { name: string }) {
  const [name, setName] = useState(initial);
  useEffect(() => setName(initial), [initial]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [installed, setInstalled] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    setGraph(null);
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
    const stageOf = (id: string) => STAGES.findIndex((s) => s.test.test(graph[id].class_type));
    const lanes = STAGES.map((s, i) => ({ ...s, ids: ids.filter((id) => stageOf(id) === i).sort((a, b) => depth.get(a)! - depth.get(b)! || Number(a) - Number(b)) })).filter((l) => l.ids.length).sort((a, b) => a.at - b.at);
    const lane = new Map(lanes.flatMap((l, i) => l.ids.map((id) => [id, i] as const)));
    const edges = ids.flatMap((id) => deps(id).map((from) => ({ from, to: id }))).filter((e) => lane.get(e.from) !== lane.get(e.to));
    return { lanes, edges };
  }, [graph]);

  // wires are drawn between the cards' measured positions
  const box = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState<{ from: string; to: string; d: string }[]>([]);
  useLayoutEffect(() => {
    const root = box.current;
    if (!root || !layout) return;
    const draw = () => {
      const o = root.getBoundingClientRect();
      const at = (id: string) => root.querySelector<HTMLElement>(`[data-node="${id}"]`)?.getBoundingClientRect();
      setWires(
        layout.edges.flatMap((e) => {
          const a = at(e.from);
          const b = at(e.to);
          if (!a || !b) return [];
          const back = a.left > b.left;
          const x1 = (back ? a.left : a.right) - o.left + root.scrollLeft;
          const y1 = a.top + a.height / 2 - o.top + root.scrollTop;
          const x2 = (back ? b.right : b.left) - o.left + root.scrollLeft;
          const y2 = b.top + b.height / 2 - o.top + root.scrollTop;
          const k = Math.max(30, Math.abs(x2 - x1) * 0.45) * (back ? -1 : 1);
          return [{ ...e, d: `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}` }];
        }),
      );
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(root);
    return () => ro.disconnect();
  }, [layout]);

  const download = () => {
    if (!graph) return;
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.json`;
    a.click();
  };
  const meta = WORKFLOWS.find((w) => w.name === name);
  const linked = (id: string) => !hover || id === hover || wires.some((w) => (w.from === hover && w.to === id) || (w.to === hover && w.from === id));
  return (
    <div className="graph-view">
      <div className="wf-pick" role="tablist" aria-label="Workflow">
        {WORKFLOWS.map((w) => (
          <button key={w.name} role="tab" aria-selected={w.name === name} className={w.name === name ? "on" : ""} onClick={() => setName(w.name)}>{w.label}</button>
        ))}
      </div>
      <div className="graph-head">
        <span>
          <b>{meta?.label ?? name}</b>
          {meta && <small>{meta.line}</small>}
        </span>
        {installed && graph && (
          <button onClick={download} title="Drop the file onto ComfyUI to open it">
            Open in ComfyUI ↗
          </button>
        )}
      </div>
      {!graph || !layout ? (
        <div className="wf-loading">Loading graph…</div>
      ) : (
        <div className="wf-canvas" ref={box}>
          <svg className={`wf-wires ${wires.length > 24 ? "busy" : ""}`} aria-hidden>
            {wires.map((w, i) => (
              <path key={i} d={w.d} className={hover && (w.from === hover || w.to === hover) ? "on" : hover ? "dim" : ""} />
            ))}
          </svg>
          {layout.lanes.map((l, i) => (
            <section key={l.key} className="wf-lane" style={{ ["--tint" as string]: l.tint }}>
              <header>
                <span>{i + 1}</span>
                <b>{l.label}</b>
                <small>{l.ids.length}</small>
              </header>
              {l.ids.map((id) => {
                const n = graph[id];
                const ours = n.class_type.startsWith("Backlot") || n._meta?.title?.startsWith("BL:");
                return (
                  <div key={id} data-node={id} className={`wf-node ${ours ? "ours" : ""} ${linked(id) ? "" : "dim"}`} onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)} title={`#${id} ${n.class_type}`}>
                    <b>{nodeName(n.class_type, n._meta?.title)}</b>
                    <small>{n.class_type}</small>
                    {nodeFacts(n.inputs).map((f) => <em key={f}>{f}</em>)}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
      {!installed && <div className="wf-note">Workflow not installed yet: showing the pipeline outline.</div>}
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
