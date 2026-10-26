import { useState } from "react";
import { api } from "../api";
import type { ExportRequest } from "../../server/workflowExport";

/** Open in ComfyUI: downloads the graph this tool would run with the settings
 *  on screen, ready to drop onto ComfyUI. `settings` is read on click. */
export function OpenInComfy({ settings, say }: { settings: () => ExportRequest; say?: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const { name, graph } = await api.workflowExport(settings());
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" }));
      a.download = `mogfield-${name}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      say?.((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="open-comfy" onClick={() => void open()} disabled={busy} title="Drop the file onto ComfyUI to open it">
      {busy ? "Building…" : "Open in ComfyUI ↗"}
    </button>
  );
}
