import type { ModelOption } from "../api";

type Lora = NonNullable<ModelOption["loras"]>[number];

function Missing({ l }: { l: Lora }) {
  return (
    <small className="lora-missing">
      Not on your Comfy Cloud yet: Model Library → Import →{" "}
      <a href={l.url} target="_blank" rel="noreferrer">copy its link</a>
    </small>
  );
}

/** Pro: pick which LoRA H3 loads. */
export function LoraPicker(p: { loras: Lora[]; lora: string; setLora: (id: string) => void }) {
  return (
    <div className="row-card open lora-card">
      <div className="row-head static-head">
        <span className="row-text">
          <small>MiniMax H3</small>
          <b>LoRA</b>
        </span>
      </div>
      <div className="row-body lora-list" role="radiogroup" aria-label="LoRA">
        {p.loras.map((l) => (
          <button key={l.id} role="radio" aria-checked={p.lora === l.id} className={`lora-opt ${p.lora === l.id ? "on" : ""}`} onClick={() => p.setLora(l.id)}>
            <span className="lora-name">
              <b>{l.label}</b>
              {l.by && <small>by {l.by}</small>}
            </span>
            {!l.installed && <span className="lora-tag">Import first</span>}
          </button>
        ))}
        {(() => {
          const picked = p.loras.find((l) => l.id === p.lora);
          return picked && !picked.installed ? <Missing l={picked} /> : null;
        })()}
      </div>
    </div>
  );
}

/** Easy: character swap LoRA on (the first swap LoRA) or off (base H3). */
export function LoraToggle(p: { loras: Lora[]; lora: string; setLora: (id: string) => void }) {
  const swap = p.loras.find((l) => l.id !== "none");
  if (!swap) return null;
  const on = p.lora !== "none";
  const picked = p.loras.find((l) => l.id === p.lora);
  return (
    <div className={`row-card prompt ${on ? "open" : ""}`}>
      <label className="row-head toggle-row">
        <span className="row-text">
          <b>Character swap LoRA</b>
          <small>{on ? `${picked?.label ?? swap.label}${picked?.by ? ` · ${picked.by}` : ""}` : "Off: base H3 follows the prompt only"}</small>
        </span>
        <span className="switch">
          <input type="checkbox" checked={on} onChange={(e) => p.setLora(e.target.checked ? swap.id : "none")} aria-label="Character swap LoRA on/off" />
          <i />
        </span>
      </label>
      {on && picked && !picked.installed && <div className="row-body"><Missing l={picked} /></div>}
    </div>
  );
}
