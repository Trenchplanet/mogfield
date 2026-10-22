// 9:16 intro and outro cards for the shared video, drawn in the browser so
// they use the system font (the server's ffmpeg may lack drawtext).

const FONT = `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", system-ui, sans-serif`;

function base(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  return { c, g };
}

function mark(g: CanvasRenderingContext2D, x: number, y: number, size: number) {
  g.fillStyle = "#fff";
  g.beginPath();
  g.roundRect(x - size / 2, y - size / 2, size, size, size * 0.28);
  g.fill();
  g.fillStyle = "#000";
  g.beginPath();
  g.arc(x, y, size * 0.2, 0, Math.PI * 2);
  g.fill();
}

export async function titleCard(o: { take: number; lens: string; look: string; move: string }) {
  await document.fonts.ready;
  const { c, g } = base(1080, 1920);
  mark(g, 540, 700, 120);
  g.textAlign = "center";
  g.fillStyle = "#fff";
  g.font = `700 96px ${FONT}`;
  g.fillText("MOGFIELD", 540, 900);
  g.fillStyle = "#8e8e93";
  g.font = `500 40px ${FONT}`;
  g.fillText([o.move, o.lens, o.look].join("  ·  "), 540, 980);
  return c.toDataURL("image/png");
}

export async function endCard(repo: string) {
  await document.fonts.ready;
  const { c, g } = base(1080, 1920);
  mark(g, 540, 700, 120);
  g.textAlign = "center";
  g.fillStyle = "#fff";
  g.font = `700 80px ${FONT}`;
  g.fillText("Made with MOGFIELD", 540, 900);
  g.fillStyle = "#8e8e93";
  g.font = `500 40px ${FONT}`;
  g.fillText("Open source video studio", 540, 970);
  g.fillStyle = "#fff";
  g.font = `600 42px ${FONT}`;
  g.fillText(repo, 540, 1160);
  g.fillStyle = "#0a84ff";
  g.font = `600 48px ${FONT}`;
  g.fillText("#OpenSourceHiggsfield", 540, 1240);
  return c.toDataURL("image/png");
}
