// Backlot Menu: the MOGFIELD easy panel as a ComfyUI node.
// Pick a tool, fill in its inputs and press Generate. The combined workflow holds one
// lane per tool (nodes tagged properties.backlot_lane); the menu unmutes the chosen lane,
// mutes the rest, and edits the lane's BL:-titled widgets the same way the server binds them.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const TABS = ["Video", "Image", "Character Swap", "Camera", "Prep"];

const video = (title = "BL:video", label = "Your take") => [title, "file", label, "video"];
const sd = (w, label) => ["BL:seedance", w, label];
const LANES = {
  t2v: { tab: "Video", name: "Create", desc: "Reference image → Seedance 2.5, 15 s with sound", paid: true,
    controls: [["BL:image-1", "image", "Reference image", "image"], sd("model.prompt", "Prompt"), sd("model.resolution", "Resolution"), sd("model.ratio", "Aspect"), sd("model.duration", "Seconds"), sd("model.generate_audio", "Sound"), sd("seed", "Seed")] },
  restyle: { tab: "Video", name: "Restyle", desc: "Your take's depth + a character → Seedance 2.0", paid: true,
    controls: [video("BL:video-1", "Depth video"), ["BL:image-1", "image", "Character", "image"], sd("model.prompt", "Prompt"), sd("model.resolution", "Resolution"), sd("model.ratio", "Aspect"), sd("model.duration", "Seconds"), sd("seed", "Seed")] },
  reshoot: { tab: "Video", name: "Re-shoot", desc: "The same moment from another angle · Seedance 2.0", paid: true,
    controls: [video("BL:video-1"), sd("model.prompt", "Prompt"), sd("model.resolution", "Resolution"), sd("model.ratio", "Aspect"), sd("model.duration", "Seconds"), sd("seed", "Seed")] },
  cast: { tab: "Image", name: "Cast card", desc: "FLUX 3 Klein character reference sheet",
    controls: [["BL:prompt", "text", "Prompt"], ["BL:seed", "seed", "Seed"]] },
  h3: { tab: "Character Swap", name: "H3 swap", desc: "Swap the person in your take for your character",
    controls: [video(), ["BL:image", "image", "Character", "image"], ["BL:h3", "prompt", "Prompt"], ["BL:lora", "strength_model", "Swap strength"], ["BL:steps", "steps", "Steps"], ["BL:seed", "noise_seed", "Seed"]] },
  recast: { tab: "Character Swap", name: "Recast", desc: "LTX 2.5 re-render with a camera move and your cast",
    controls: [video(), ["BL:cast", "image", "Cast card", "image"], ["BL:prompt", "text", "Prompt"], ["BL:camera", "preset", "Move"], ["BL:camera", "strength", "Move strength"], ["BL:lens", "lens", "Lens"], ["BL:lens", "f_stop", "f-stop"], ["BL:grade", "lut", "Look"], ["BL:grade", "strength", "Look strength"], ["BL:letterbox", "aspect", "Matte"], ["BL:seed", "noise_seed", "Seed"]] },
  direct: { tab: "Camera", name: "Direct", desc: "Camera move, lens, grade and matte on your take",
    controls: [video(), ["BL:camera", "preset", "Move"], ["BL:camera", "strength", "Move strength"], ["BL:lens", "lens", "Lens"], ["BL:lens", "f_stop", "f-stop"], ["BL:lens", "focus", "Focus"], ["BL:lens", "grain", "Grain"], ["BL:grade", "lut", "Look"], ["BL:grade", "strength", "Look strength"], ["BL:letterbox", "aspect", "Matte"]] },
  depth: { tab: "Prep", name: "Depth map", desc: "Depth video for the monitor (bright = near)", controls: [video()] },
  genjustsu: { tab: "Prep", name: "Depth + vocals", desc: "Depth video and the vocal stem of your take",
    controls: [video(), ["BL:audio", "audio", "Audio", "audio"], ["BL:depth-size", "width", "Depth width"], ["BL:depth-size", "height", "Depth height"]] },
  sam: { tab: "Prep", name: "Person masks", desc: "SAM 3 masks on the coloured depth video",
    controls: [video("BL:video", "Depth video"), ["BL:segment", "text_prompt", "Track"], ["BL:segment", "score_threshold", "Threshold"]] },
};

const CSS = `
.bl{--bg:#000;--surface:#111113;--card:#1c1c1e;--card-2:#2c2c2e;--fill:#3a3a3c;--text:#fff;--text-2:rgba(235,235,245,.6);--text-3:rgba(235,235,245,.3);--blue:#0a84ff;--green:#30d158;--red:#ff453a;--amber:#ffb340;
 font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",system-ui,sans-serif;letter-spacing:-.01em;color:var(--text);background:var(--surface);border-radius:18px;
 display:flex;flex-direction:column;height:100%;overflow:hidden;box-sizing:border-box}
.bl *{box-sizing:border-box}
.bl button{font:inherit;color:inherit;border:0;border-radius:999px;background:var(--card-2);padding:6px 12px;cursor:pointer;font-weight:500}
.bl button:hover:not(:disabled){background:var(--fill)}.bl button:disabled{opacity:.35;cursor:default}
.bl-head{display:flex;align-items:baseline;gap:8px;padding:14px 14px 8px}.bl-head b{font-size:15px;letter-spacing:.06em}.bl-head span{color:var(--text-2)}
.bl-tabs{display:flex;flex-wrap:wrap;gap:4px;margin:0 12px 6px;padding:2px;border-radius:999px;background:var(--card)}
.bl-tabs button{background:transparent;color:var(--text-2);font-size:12px;font-weight:600;padding:5px 10px}.bl-tabs button.on{background:var(--surface);color:var(--text)}
.bl-scroll{flex:1;overflow-y:auto;padding:4px 12px 12px;display:flex;flex-direction:column;gap:8px;scrollbar-width:none}
.bl-cards{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.bl-card{display:flex;flex-direction:column;align-items:flex-start;gap:3px;text-align:left;border-radius:14px!important;padding:10px 12px!important;background:var(--card)!important;outline:2px solid transparent;white-space:normal}
.bl-card.on{outline-color:var(--blue)}.bl-card b{font-size:14px;display:flex;align-items:center;gap:6px}.bl-card small{color:var(--text-2);font-size:12px}
.bl-dot{width:7px;height:7px;border-radius:50%;background:var(--text-3)}.bl-dot.ok{background:var(--green)}.bl-dot.amber{background:var(--amber)}.bl-dot.red{background:var(--red)}
.bl-badge{font-size:10px;font-weight:700;letter-spacing:.04em;color:#000;background:var(--amber);border-radius:6px;padding:1px 5px}
.bl-row{background:var(--card);border-radius:14px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.bl-row label{color:var(--text-2);font-size:12px;display:flex;justify-content:space-between;align-items:center}
.bl-row select,.bl-row input[type=number],.bl-row input[type=text],.bl-row textarea{width:100%;background:var(--card-2);color:var(--text);border:0;border-radius:10px;padding:7px 9px;font:inherit}
.bl-row textarea{resize:vertical;min-height:64px}
.bl-drop{border:1.5px dashed var(--fill);border-radius:12px;padding:10px;text-align:center;color:var(--text-2);cursor:pointer}
.bl-drop.over{border-color:var(--blue);background:rgba(10,132,255,.08)}.bl-drop b{color:var(--text);display:block;font-weight:600}
.bl-inline{display:flex;gap:6px;align-items:center}.bl-inline > :first-child{flex:1}
.bl-switch{position:relative;width:42px;height:25px;flex:0 0 42px}.bl-switch input{opacity:0;position:absolute;inset:0;margin:0;cursor:pointer;z-index:1}
.bl-switch i{position:absolute;inset:0;background:var(--fill);border-radius:99px}.bl-switch i::after{content:"";position:absolute;left:2px;top:2px;width:21px;height:21px;border-radius:50%;background:#fff;transition:transform .2s}
.bl-switch input:checked+i{background:var(--green)}.bl-switch input:checked+i::after{transform:translateX(17px)}
.bl-muted{color:var(--text-3);font-size:12px}
.bl-preview{background:var(--card);border-radius:14px;padding:8px}.bl-preview video,.bl-preview img{display:block;width:100%;border-radius:10px;background:#050506}.bl-preview audio{width:100%}
.bl-foot{padding:10px 12px 12px;display:flex;flex-direction:column;gap:6px}
.bl-gen{background:var(--text)!important;color:#000!important;font-weight:600!important;padding:11px!important;font-size:15px}.bl-gen:hover:not(:disabled){background:#e5e5ea!important}
.bl-status{font-size:12px;color:var(--text-2)}.bl-status .bar{height:4px;border-radius:2px;background:var(--fill);margin-top:4px;overflow:hidden}.bl-status .bar i{display:block;height:100%;background:var(--blue)}
.bl-issues{display:flex;flex-direction:column;gap:2px;font-size:12px}.bl-issues .red{color:var(--red)}.bl-issues .amber{color:var(--amber)}
`;

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};
const graphNodes = () => app.graph?._nodes ?? app.graph?.nodes ?? [];
const laneNodes = (key) => graphNodes().filter((n) => n.properties?.backlot_lane === key);
const comboValues = (w) => (typeof w.options?.values === "function" ? w.options.values() : w.options?.values) ?? [];

function find(key, title, name) {
  for (const n of laneNodes(key)) {
    if (n.title !== title) continue;
    const w = n.widgets?.find((x) => x.name === name);
    if (w) return { node: n, w };
  }
  return null;
}
function setWidget(node, w, v) {
  w.value = v;
  w.callback?.(v, app.canvas, node);
  node.setDirtyCanvas?.(true, true);
  app.graph.setDirtyCanvas?.(true, true);
}
async function upload(file) {
  const body = new FormData();
  body.append("image", file); // ComfyUI's one upload route takes video and audio too
  body.append("overwrite", "true");
  const r = await api.fetchApi("/upload/image", { method: "POST", body });
  if (r.status !== 200) throw new Error(`Upload failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
}

// What stops a lane from running here: missing node packs (red) or missing files (amber).
function issues(key) {
  const out = new Map();
  for (const n of laneNodes(key)) {
    if (!LiteGraph.registered_node_types[n.type]) { out.set(n.type, { level: "red", text: `${n.type} isn't installed` }); continue; }
    for (const w of n.widgets ?? []) {
      if (w.type !== "combo" || !/(_name$|^file$|^image$|^audio$)/.test(w.name)) continue;
      const vals = comboValues(w);
      if (vals.includes(w.value)) continue;
      const text = /_name$/.test(w.name) ? `Model not installed: ${w.value}` : `Add a file: ${w.value} isn't in ComfyUI/input`;
      out.set(text, { level: "amber", text });
    }
  }
  return [...out.values()];
}
const health = (key) => {
  const list = issues(key);
  return list.some((i) => i.level === "red") ? "red" : list.length ? "amber" : "ok";
};

function laneBounds(key) {
  const ns = laneNodes(key);
  if (!ns.length) return null;
  const xs = ns.flatMap((n) => [n.pos[0], n.pos[0] + n.size[0]]);
  const ys = ns.flatMap((n) => [n.pos[1], n.pos[1] + n.size[1]]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Unmute the chosen lane, mute the others, park the menu beside the lane and frame both.
function activate(menu, key) {
  for (const n of graphNodes()) {
    const lane = n.properties?.backlot_lane;
    if (lane) n.mode = lane === key ? 0 : 2;
  }
  menu.properties.lane = key;
  const b = laneBounds(key);
  if (b) {
    menu.pos = [b[0] - menu.size[0] - 120, b[1] - 100];
    const c = app.canvas, ds = c.ds;
    const vw = c.canvas.clientWidth || c.canvas.width, vh = c.canvas.clientHeight || c.canvas.height;
    const left = menu.pos[0] - 40, top = Math.min(menu.pos[1], b[1]) - 60;
    const w = b[2] + 60 - left, h = Math.max(b[3], menu.pos[1] + menu.size[1]) + 60 - top;
    ds.scale = Math.max(0.1, Math.min(1, vw / w, vh / h));
    ds.offset = [-left, -top];
  }
  app.graph.setDirtyCanvas(true, true);
}

function controlRow(menu, key, [title, name, label, upl]) {
  const hit = find(key, title, name);
  if (!hit) return el("div", { class: "bl-row" }, el("label", {}, label), el("span", { class: "bl-muted" }, `Not available here (${title} · ${name})`));
  const { node, w } = hit;
  const set = (v) => setWidget(node, w, v);
  let input;
  if (upl) {
    const vals = comboValues(w);
    const pick = el("input", { type: "file", accept: `${upl}/*`, hidden: true, onchange: async (e) => { const f = e.target.files?.[0]; if (f) await take(f); } });
    const take = async (f) => {
      drop.querySelector("b").textContent = "Uploading…";
      try {
        const name = await upload(f);
        if (!vals.includes(name)) vals.push(name);
        set(name);
      } catch (err) { alert(err.message); }
      render(menu);
    };
    const drop = el("div", { class: "bl-drop", onclick: () => pick.click(),
      ondragover: (e) => { e.preventDefault(); drop.classList.add("over"); }, ondragleave: () => drop.classList.remove("over"),
      ondrop: (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files?.[0]; if (f) void take(f); } },
      el("b", {}, vals.includes(w.value) ? w.value : `Add ${label.toLowerCase()}`), el("small", {}, "Click or drop a file"));
    const choose = el("select", { onchange: (e) => { set(e.target.value); render(menu); } },
      ...[...new Set([w.value, ...vals])].map((v) => el("option", { value: v, selected: v === w.value }, vals.includes(v) ? v : `${v} (missing)`)));
    input = el("div", { class: "bl-row-body" }, drop, pick, el("div", { style: "height:6px" }), choose);
  } else if (w.type === "combo") {
    input = el("select", { onchange: (e) => set(e.target.value) }, ...comboValues(w).map((v) => el("option", { value: v, selected: v === w.value }, String(v))));
  } else if (typeof w.value === "boolean") {
    input = el("span", { class: "bl-switch" }, el("input", { type: "checkbox", checked: w.value, onchange: (e) => set(e.target.checked) }), el("i"));
    return el("div", { class: "bl-row" }, el("label", {}, label, input));
  } else if (typeof w.value === "number") {
    const o = w.options ?? {};
    const num = el("input", { type: "number", value: w.value, min: o.min, max: o.max, step: /seed/.test(name) || o.precision === 0 || o.round === 1 ? 1 : "any",
      onchange: (e) => set(Number(e.target.value)) });
    input = /seed/.test(name)
      ? el("div", { class: "bl-inline" }, num, el("button", { title: "New seed", onclick: () => { const v = Math.floor(Math.random() * 2 ** 31); num.value = v; set(v); } }, "🎲"))
      : num;
  } else {
    input = el("textarea", { rows: 3, oninput: (e) => set(e.target.value) });
    input.value = w.value ?? "";
  }
  return el("div", { class: "bl-row" }, el("label", {}, label), input);
}

function outputMedia(files) {
  const f = files[0];
  const url = api.apiURL(`/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder ?? "")}&type=${f.type ?? "output"}`);
  if (/\.(mp4|webm|mov|mkv)$/i.test(f.filename)) return el("video", { src: url, controls: true, playsinline: true });
  if (/\.(wav|mp3|flac|ogg|m4a)$/i.test(f.filename)) return el("audio", { src: url, controls: true });
  return el("img", { src: url });
}

function render(menu) {
  const root = menu.__bl;
  if (!root) return;
  const key = menu.properties.lane in LANES ? menu.properties.lane : "direct";
  const lane = LANES[key];
  const tab = menu.properties.tab ?? lane.tab;
  const list = issues(key);
  const blocked = list.some((i) => i.level === "red");
  const st = menu.__status;

  root.replaceChildren(
    el("div", { class: "bl-head" }, el("b", {}, "MOGFIELD"), el("span", {}, "Backlot")),
    el("div", { class: "bl-tabs" }, ...TABS.map((t) => el("button", { class: t === tab ? "on" : "", onclick: () => { menu.properties.tab = t; render(menu); } }, t))),
    el("div", { class: "bl-scroll", onwheel: (e) => e.stopPropagation() },
      el("div", { class: "bl-cards" }, ...Object.entries(LANES).filter(([, l]) => l.tab === tab).map(([k, l]) =>
        el("button", { class: `bl-card ${k === key ? "on" : ""}`, onclick: () => { activate(menu, k); render(menu); } },
          el("b", {}, el("i", { class: `bl-dot ${health(k)}` }), l.name, l.paid && el("span", { class: "bl-badge" }, "CREDITS")),
          el("small", {}, l.desc)))),
      el("div", { class: "bl-muted", style: "margin:4px 2px 0" }, `${lane.name} · ${lane.tab}`),
      ...lane.controls.map((c) => controlRow(menu, key, c)),
      menu.__preview?.lane === key && el("div", { class: "bl-preview" }, outputMedia(menu.__preview.files)),
    ),
    el("div", { class: "bl-foot" },
      st && el("div", { class: "bl-status" }, st.text, st.pct != null && el("div", { class: "bar" }, el("i", { style: `width:${Math.round(st.pct * 100)}%` }))),
      el("button", { class: "bl-gen", disabled: blocked || st?.running, onclick: () => generate(menu, key) },
        st?.running ? "Generating…" : lane.paid ? "Generate · uses Comfy credits" : "Generate"),
      list.length ? el("div", { class: "bl-issues" }, ...list.slice(0, 6).map((i) => el("span", { class: i.level }, i.text))) : el("small", { class: "bl-muted" }, "Ready")),
  );
}

async function generate(menu, key) {
  const lane = LANES[key];
  if (lane.paid && !confirm(`${lane.name} runs the Seedance partner node and spends Comfy credits. Continue?`)) return;
  activate(menu, key);
  menu.__status = { text: "Queued…", running: true, pct: null };
  render(menu);
  try {
    await app.queuePrompt(0, 1);
  } catch (err) {
    menu.__status = { text: `Couldn't queue: ${err.message ?? err}`, running: false };
    render(menu);
  }
}

const menus = () => graphNodes().filter((n) => n.type === "BacklotMenu");
function onEvent(fn) {
  return (e) => { for (const m of menus()) { fn(m, e.detail); render(m); } };
}

app.registerExtension({
  name: "backlot.menu",
  setup() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    const laneOf = (id) => graphNodes().find((n) => String(n.id) === String(id))?.properties?.backlot_lane;
    api.addEventListener("progress", onEvent((m, d) => { if (m.__status?.running) m.__status.pct = d.max ? d.value / d.max : null; }));
    api.addEventListener("executing", onEvent((m, d) => {
      const id = d && typeof d === "object" ? d.node : d;
      if (!m.__status?.running) return;
      if (id == null) m.__status = { text: "Done", running: false };
      else m.__status.text = `Running ${graphNodes().find((n) => String(n.id) === String(id))?.title ?? id}…`;
    }));
    api.addEventListener("executed", onEvent((m, d) => {
      const files = d?.output?.images ?? d?.output?.gifs ?? d?.output?.video ?? d?.output?.audio;
      const lane = laneOf(d?.node);
      if (lane && files?.length) m.__preview = { lane, files };
    }));
    api.addEventListener("execution_error", onEvent((m, d) => { m.__status = { text: `Error in ${d?.node_type ?? "a node"}: ${d?.exception_message ?? ""}`, running: false }; }));
    api.addEventListener("execution_success", onEvent((m) => { if (m.__status) m.__status = { text: "Done", running: false }; }));
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "BacklotMenu") return;
    nodeType.prototype.isVirtualNode = true; // UI only: never sent to the server
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      created?.apply(this, arguments);
      this.properties ??= {};
      this.properties.lane ??= "direct";
      this.color = "#222";
      this.bgcolor = "#111113";
      const root = el("div", { class: "bl" });
      this.__bl = root;
      this.addDOMWidget("backlot_menu", "backlot-menu", root, { serialize: false, getMinHeight: () => 640 });
      this.size = [480, 820];
      setTimeout(() => render(this), 0);
    };
    const configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      configured?.apply(this, arguments);
      setTimeout(() => render(this), 300); // after the rest of the graph has loaded
    };
  },
});
