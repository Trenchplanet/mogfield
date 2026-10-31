// The local director model (Agent mode on LOCAL): which GGUF on Hugging Face,
// at which quantization, served by llama-server (or any OpenAI-style server)
// at MOGFIELD_AGENT_URL. The choice is saved in data/director.json; the
// quantizations are read from the repo's own file list.

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

export const LOCAL_AGENT_URL = (process.env.MOGFIELD_AGENT_URL?.trim() || "http://127.0.0.1:8090/v1").replace(/\/+$/, "");
const PORT = /:(\d+)/.exec(LOCAL_AGENT_URL.replace(/^\w+:\/\//, ""))?.[1] ?? "8090";

export interface DirectorModel {
  repo: string;
  label: string;
  note: string;
  /** the quantization picked when none is */
  quant: string;
  /** refusals removed: the storyboard rules are only prompt instructions to it */
  uncensored?: boolean;
}

export const DIRECTOR_MODELS: DirectorModel[] = [
  { repo: "google/gemma-4-12B-it-qat-q4_0-gguf", label: "Gemma 4 12B (Google QAT)", note: "Standard. About 9 GB to run: fits a 16 GB Mac.", quant: "Q4_0" },
  { repo: "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive", label: "Gemma 4 E4B Uncensored (HauhauCS)", note: "Small and fast, 5-8 GB. Weaker at long storyboards.", quant: "Q4_K_M", uncensored: true },
  { repo: "AtomicChat/DeepSeek-V4.1-Flash-1017-Uncensored-GSQ-RCO-GGUF", label: "DeepSeek V4.1 Flash Uncensored", note: "121-155 GB: a large GPU server only.", quant: "IQ1_M", uncensored: true },
];

export interface DirectorChoice {
  repo: string;
  quant: string;
}

const FILE = join(DATA_DIR, "director.json");
let choice: DirectorChoice = { repo: DIRECTOR_MODELS[0].repo, quant: DIRECTOR_MODELS[0].quant };
try {
  if (existsSync(FILE)) choice = JSON.parse(readFileSync(FILE, "utf8")) as DirectorChoice;
} catch {
  /* unreadable: the standard model */
}
// MOGFIELD_AGENT_LOCAL_MODEL=<repo>:<quant> sets the model from the environment instead
const fromEnv = process.env.MOGFIELD_AGENT_LOCAL_MODEL?.trim();
if (fromEnv?.includes("/")) {
  const [repo, quant = ""] = fromEnv.split(":");
  choice = { repo, quant };
}

export const directorChoice = () => choice;
export const directorLabel = () => `${DIRECTOR_MODELS.find((m) => m.repo === choice.repo)?.label ?? choice.repo} · ${choice.quant}`;
/** The name sent to the server; llama-server answers with whatever it loaded, Ollama loads hf.co/<repo>:<quant>. */
export const directorModelName = () => `hf.co/${choice.repo}:${choice.quant}`;
/** The command that starts the chosen model on this machine (or a GPU pod). */
export const startCommand = (c: DirectorChoice = choice) => `llama-server -hf ${c.repo}:${c.quant} --port ${PORT} -c 32768`;

export async function setDirector(c: DirectorChoice): Promise<void> {
  choice = { repo: c.repo, quant: c.quant };
  await writeFile(FILE, JSON.stringify(choice, null, 2));
}

/** "...-Q4_K_M.gguf", "...-IQ1_M-00001-of-00004.gguf", "...-qat-q4_0.gguf" -> the quantization */
export function quantOf(file: string): string | undefined {
  return /[-_.]((?:I?Q\d+(?:_[A-Z0-9]+)*)|BF16|F16|F32)(?:-\d{5}-of-\d{5})?\.gguf$/i.exec(file)?.[1]?.toUpperCase();
}

const quantCache = new Map<string, { at: number; quants: { quant: string; gb: number }[] }>();
/** The quantizations a repo offers, with their total download size (multi-part files added up). */
export async function quantsOf(repo: string): Promise<{ quant: string; gb: number }[]> {
  const hit = quantCache.get(repo);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.quants;
  const res = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Hugging Face answered HTTP ${res.status} for ${repo}`);
  const data = (await res.json()) as { siblings?: { rfilename: string; size?: number }[] };
  const sizes = new Map<string, number>();
  for (const f of data.siblings ?? []) {
    const name = f.rfilename.split("/").pop()!;
    // mmproj files are the vision part, not a quantization of the model
    if (!name.endsWith(".gguf") || name.startsWith("mmproj")) continue;
    const q = quantOf(name);
    if (q) sizes.set(q, (sizes.get(q) ?? 0) + (f.size ?? 0));
  }
  const quants = [...sizes].map(([quant, bytes]) => ({ quant, gb: Math.round(bytes / 1e8) / 10 })).sort((a, b) => a.gb - b.gb);
  quantCache.set(repo, { at: Date.now(), quants });
  return quants;
}

/** What the local server has loaded, if it answers. */
export async function loadedModels(): Promise<{ running: boolean; models: string[] }> {
  try {
    const res = await fetch(`${LOCAL_AGENT_URL}/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { running: false, models: [] };
    const data = (await res.json()) as { data?: { id: string }[] };
    return { running: true, models: (data.data ?? []).map((m) => m.id) };
  } catch {
    return { running: false, models: [] };
  }
}
