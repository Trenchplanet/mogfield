/**
 * Download buttons that open the share sheet on phones, where "Save Video" puts
 * the take in Photos. Elsewhere the link's own `download` attribute runs as before.
 *
 * Phones only let a page open the share sheet straight after a tap, so the file is
 * fetched on touch-down and is usually ready by the time the tap lands.
 */

const blobs = new Map<string, Promise<Blob>>();

function fetchBlob(url: string) {
  let p = blobs.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.blob();
    });
    p.catch(() => blobs.delete(url));
    blobs.set(url, p);
  }
  return p;
}

let shareable: boolean | null = null;
function canShareVideo() {
  if (shareable === null) {
    const probe = new File([new Uint8Array(1)], "probe.mp4", { type: "video/mp4" });
    shareable = matchMedia("(pointer: coarse)").matches && !!navigator.canShare?.({ files: [probe] });
  }
  return shareable;
}

/** Spread onto an `<a href download>`: `<a href={url} download={name} {...saveToPhotos(url, name)}>`. */
export function saveToPhotos(url: string, name: string) {
  return {
    onPointerDown: () => {
      if (canShareVideo()) void fetchBlob(url).catch(() => {});
    },
    onClick: async (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!canShareVideo()) return; // plain download
      e.preventDefault();
      const a = e.currentTarget;
      try {
        const blob = await fetchBlob(url);
        const file = new File([blob], name.endsWith(".mp4") ? name : `${name}.mp4`, { type: blob.type || "video/mp4" });
        await navigator.share({ files: [file] });
      } catch (err) {
        if ((err as Error).name === "AbortError") return; // closed the share sheet
        // no share sheet (or the tap expired while the file loaded): plain download
        const link = document.createElement("a");
        link.href = a.href;
        link.download = name;
        link.click();
      }
    },
  };
}
