import { useState } from "react";
import type { Clip, Render } from "../../server/shared";
import { api } from "../api";
import { abOverlay } from "../ab";
import { saveToPhotos } from "../save";

/** "A/B" on a finished take: builds the 16:9 side-by-side, then offers Save. */
export function AbButton({ render, clip, say }: { render: Render; clip?: Clip; say: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  if (!clip) return null;
  if (url)
    return (
      <a className="btn small" href={url} download={`mogfield-ab-${render.take}.mp4`} {...saveToPhotos(url, `mogfield-ab-${render.take}.mp4`)}>Save A/B</a>
    );
  return (
    <button
      className="small"
      disabled={busy}
      title="16:9 side-by-side with the original"
      onClick={async () => {
        setBusy(true);
        try {
          setUrl((await api.abExport(render.id, abOverlay(clip))).url);
        } catch (e) {
          say((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Making…" : "A/B"}
    </button>
  );
}
