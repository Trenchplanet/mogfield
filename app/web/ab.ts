import { AB_LAYOUT, type Clip } from "../server/shared";

const CAPTION = "Made with MOGFIELD  ·  Powered by ComfyUI";

function pill(g: CanvasRenderingContext2D, cx: number, y: number, text: string, fill: string) {
  g.font = "600 30px -apple-system, system-ui, sans-serif";
  const w = g.measureText(text).width + 44;
  g.fillStyle = fill;
  g.beginPath();
  g.roundRect(cx - w / 2, y, w, 52, 26);
  g.fill();
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, cx, y + 27);
}

/** The 1920x1080 label layer for the A/B export: Original / MOGFIELD and the credit line,
 *  placed on the same boxes the server puts the two videos in. */
export function abOverlay(clip: Pick<Clip, "width" | "height">): string {
  const c = document.createElement("canvas");
  c.width = 1920;
  c.height = 1080;
  const g = c.getContext("2d")!;
  const portrait = clip.width < clip.height;
  const box = AB_LAYOUT[portrait ? "portrait" : "landscape"];
  // portrait: labels sit inside the top of each video; landscape: above each pane
  const labelY = portrait ? box.a.y + 24 : box.a.y - 72;
  pill(g, box.a.x + box.a.w / 2, labelY, "ORIGINAL", "rgba(0,0,0,0.66)");
  pill(g, box.b.x + box.b.w / 2, labelY, "MOGFIELD", "rgba(10,132,255,0.92)");
  g.font = "500 34px -apple-system, system-ui, sans-serif";
  g.fillStyle = "rgba(235,235,245,0.9)";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(CAPTION, 960, portrait ? 1022 : box.a.y + box.a.h + 90);
  return c.toDataURL("image/png");
}
