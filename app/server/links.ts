import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YTDLP, YTDLP_COOKIES, YTDLP_COOKIES_FROM_BROWSER } from "./config.js";
import { exec } from "./media.js";

/**
 * Download the video behind a TikTok / Instagram / X link into a fresh temp dir.
 * The caller normalises the file and must remove `dir` afterwards.
 * Instagram often wants a logged-in session: set BACKLOT_YTDLP_COOKIES_FROM_BROWSER
 * (e.g. "chrome") or BACKLOT_YTDLP_COOKIES (a cookies.txt path).
 */
export async function downloadLink(url: string): Promise<{ dir: string; path: string; title: string }> {
  const dir = await mkdtemp(join(tmpdir(), "backlot-link-"));
  const args = [
    "--no-playlist", "--no-progress", "--no-warnings", "--restrict-filenames",
    // best single file with video, H.264 MP4 preferred; normalise() re-encodes anyway
    "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
    "--merge-output-format", "mp4",
    "--max-filesize", "500M",
    "-o", join(dir, "video.%(ext)s"),
    "--print", "after_move:%(uploader,channel|)s\t%(title,description|)s",
    ...(YTDLP_COOKIES_FROM_BROWSER ? ["--cookies-from-browser", YTDLP_COOKIES_FROM_BROWSER] : []),
    ...(YTDLP_COOKIES ? ["--cookies", YTDLP_COOKIES] : []),
    url,
  ];
  try {
    const out = await exec(YTDLP, args);
    const file = (await readdir(dir)).find((f) => f.startsWith("video.") && !f.endsWith(".part"));
    if (!file) throw new Error("no video in that post");
    const [uploader = "", title = ""] = out.trim().split("\n").pop()!.split("\t");
    return { dir, path: join(dir, file), title: clipName(uploader, title) };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(explain((e as Error).message));
  }
}

function clipName(uploader: string, title: string) {
  const t = title.replace(/#\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  const who = uploader && uploader !== "NA" ? `@${uploader.replace(/^@/, "")}` : "";
  return [who, t && t !== "NA" ? t : ""].filter(Boolean).join(" · ") || "Linked video";
}

function explain(msg: string) {
  if (/ENOENT/.test(msg)) return "yt-dlp is not installed (brew install yt-dlp)";
  if (/login|cookies|rate-limit|private/i.test(msg)) return "that post needs a logged-in session — set BACKLOT_YTDLP_COOKIES_FROM_BROWSER in app/.env";
  if (/no video formats|There is no video/i.test(msg)) return "that post has no video";
  const line = msg.split("\n").reverse().find((l) => l.includes("ERROR:"));
  return (line ?? msg).replace(/^.*ERROR:\s*/, "").slice(0, 200);
}
