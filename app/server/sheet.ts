// Combines character references into one reference sheet: each image fitted
// into a 512x768 cell with a 20px gutter on flat grey (#7f7f7f), left to right.

import { exec } from "./media.js";

export async function buildSheet(images: string[], out: string): Promise<void> {
  if (!images.length) throw new Error("no character images");
  const cells = images.slice(0, 4);
  const inputs = cells.flatMap((p) => ["-i", p]);
  const fit = cells.map((_, i) => `[${i}:v]scale=512:768:force_original_aspect_ratio=decrease,pad=552:808:(ow-iw)/2:(oh-ih)/2:color=0x7f7f7f,setsar=1[c${i}]`);
  const join = cells.length > 1 ? `${cells.map((_, i) => `[c${i}]`).join("")}hstack=inputs=${cells.length}[row]` : `[c0]null[row]`;
  const filter = [...fit, join, `[row]pad=iw+16:ih+16:8:8:color=0x7f7f7f[out]`].join(";");
  await exec("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", out]);
}
