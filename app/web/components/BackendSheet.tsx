import { useEffect, useState } from "react";
import { api, type BackendStatus } from "../api";

/** Pick where workflows run (Comfy Cloud or your own ComfyUI) and see which
 *  features that target can run, with the nodes and model files it lacks. */
export function BackendSheet(p: { initial?: "cloud" | "custom"; onClose: () => void; onChanged: () => void }) {
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [target, setTarget] = useState<"cloud" | "custom">(p.initial ?? "cloud");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .backend()
      .then((s) => {
        setStatus(s);
        if (!p.initial) setTarget(s.target);
        setUrl(s.url ?? "");
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const run = async (save: boolean) => {
    setBusy(save ? "save" : "check");
    setError(null);
    try {
      const s = await api.setBackend({ target, url: target === "custom" ? url : undefined, test: !save });
      setStatus(s);
      if (save) p.onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const unsaved = !!status && (status.target !== target || (target === "custom" && (status.url ?? "") !== url.trim().replace(/\/+$/, "")));

  return (
    <div className="sheet-backdrop" onClick={p.onClose}>
      <div className="be-sheet" role="dialog" aria-label="Backend" onClick={(e) => e.stopPropagation()}>
        <header className="be-head">
          <div>
            <h2>Where it runs</h2>
            <p>Every feature is a ComfyUI workflow. API runs it on Comfy Cloud; LOCAL runs the exact same workflow on your own ComfyUI. Partner models (Seedance, FLUX 3) use your Comfy API key from app/.env, which is only ever sent to Comfy.</p>
          </div>
          <button className="ghost" onClick={p.onClose} aria-label="Close">×</button>
        </header>

        <div className="rs-seg" role="radiogroup" aria-label="Backend">
          <button role="radio" aria-checked={target === "cloud"} className={target === "cloud" ? "on" : ""} onClick={() => setTarget("cloud")}>API · Comfy Cloud</button>
          <button role="radio" aria-checked={target === "custom"} className={target === "custom" ? "on" : ""} onClick={() => setTarget("custom")}>LOCAL · my ComfyUI</button>
        </div>

        {target === "custom" && (
          <label className="rs-field">
            <span>ComfyUI address (behind comfy-api-proxy)</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:8189 or https://<pod>-8189.proxy.runpod.net" inputMode="url" autoCapitalize="off" spellCheck={false} />
          </label>
        )}

        <div className="be-actions">
          <button disabled={!!busy || (target === "custom" && !url.trim())} onClick={() => run(false)}>{busy === "check" ? "Checking…" : "Check"}</button>
          <button className="accent" disabled={!!busy || !unsaved || (target === "custom" && !url.trim())} onClick={() => run(true)}>{busy === "save" ? "Switching…" : "Use this"}</button>
        </div>

        {error && <p className="be-error">{error}</p>}

        {status && (
          <div className="be-status">
            <p className="be-line">
              <i className={status.connected ? "ok" : "bad"} />
              {status.connected ? `Connected to ${status.target === "custom" ? status.url : "Comfy Cloud"} · ${status.nodes} nodes` : `Not connected: ${status.error}`}
              {unsaved ? " (not in use yet)" : ""}
            </p>
            <p className="be-line">
              <i className={status.apiKey ? "ok" : "bad"} />
              {status.apiKey ? "Comfy API key set: Seedance, Character Studio and Re-shoot can run" : "No COMFY_API_KEY in app/.env: Seedance, Character Studio and Re-shoot cannot run"}
            </p>
            {/* every missing file in one go, from Hugging Face; only for the ComfyUI in use (the script is made from its check) */}
            {status.connected && !unsaved && status.target === "custom" && status.features.some((f) => f.missingFiles.length || f.optionalFiles.length) && (
              <div className="be-download">
                <a className="btn accent" href="/api/backend/models.sh" download="mogfield-models.sh">Download models</a>
                <small>One script for every missing file: Pika H3 Flex, character swap, Genjutsu, Re-shoot and the director. Run <code>bash mogfield-models.sh</code> in your ComfyUI folder; SAM 3 also needs <code>HF_TOKEN</code>.</small>
              </div>
            )}
            {status.features.length > 0 && (
              <ul className="be-features">
                {status.features.map((f) => (
                  <li key={f.id} className={f.ok ? "ok" : "bad"}>
                    <b>{f.ok ? "✓" : "✕"} {f.label}</b>
                    {f.note && <small>{f.note}</small>}
                    {f.optionalFiles.length > 0 && <small>Optional LoRA not on this target (runs without it): {f.optionalFiles.join(", ")}</small>}
                    {!f.ok && (
                      <small>
                        {[
                          f.missingNodes.length ? `Missing nodes: ${f.missingNodes.join(", ")}` : "",
                          f.missingFiles.length ? `Missing files: ${f.missingFiles.join(", ")}` : "",
                          f.missingWorkflows.length ? `Missing workflows: ${f.missingWorkflows.join(", ")}` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
