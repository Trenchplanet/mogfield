// Preparations live in memory while the server runs; this keeps a copy of each
// one in its own folder (state.json) so the queue and the review step survive
// a restart. Writes for one preparation are serialized so an older snapshot can
// never land after a newer one.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreparationResult } from "./genjustsu.js";
import type { Preparation } from "./shared.js";

export interface StoredPreparation extends Preparation {
  sourcePath: string;
  result?: PreparationResult;
}

const STATE_FILE = "state.json";
const chains = new Map<string, Promise<void>>();

/** Save a snapshot of the preparation; later calls for the same id queue behind earlier ones. */
export function persistPreparation(root: string, state: StoredPreparation): Promise<void> {
  const snapshot = structuredClone(state);
  const dir = join(root, state.id);
  const write = async () => {
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${STATE_FILE}.tmp`);
    await writeFile(tmp, JSON.stringify(snapshot, null, 2));
    await rename(tmp, join(dir, STATE_FILE));
  };
  const next = (chains.get(state.id) ?? Promise.resolve()).then(write).catch((e) => console.error(`saving preparation ${state.id} failed:`, e));
  chains.set(state.id, next);
  return next;
}

/**
 * Read every saved preparation. Work a restart cut short is marked failed, and
 * a ready one is re-verified against its manifest. `changed` says the stored
 * copy needs rewriting.
 */
export async function loadPreparations(
  root: string,
  verify: (dir: string, manifestHash: string) => Promise<string | null>,
): Promise<{ state: StoredPreparation; changed: boolean }[]> {
  if (!existsSync(root)) return [];
  const out: { state: StoredPreparation; changed: boolean }[] = [];
  for (const id of await readdir(root)) {
    const file = join(root, id, STATE_FILE);
    if (!existsSync(file)) continue; // preparations from before v1.0.1 kept no state
    let state: StoredPreparation;
    try {
      state = JSON.parse(await readFile(file, "utf8")) as StoredPreparation;
    } catch {
      continue;
    }
    if (state.id !== id) continue;
    let changed = false;
    if (state.status === "queued" || state.status === "running") {
      state = { ...state, status: "failed", message: "Preparation failed", error: "Interrupted: the server restarted during preparation. Prepare again." };
      changed = true;
    } else if (state.status === "ready") {
      const problem = state.manifestHash ? await verify(join(root, id), state.manifestHash) : "no manifest hash";
      if (problem) {
        state = { ...state, status: "failed", approved: false, message: "Preparation failed", error: `The prepared files no longer match what was reviewed (${problem}). Prepare again.` };
        changed = true;
      }
    }
    out.push({ state: { ...state, createdAt: state.createdAt ?? 0 }, changed });
  }
  return out.sort((a, b) => b.state.createdAt - a.state.createdAt);
}

/** A clip (or a trimmed cut of one) an older preparation may have been made from. */
export interface SourceCandidate {
  path: string;
  clipId: string;
  trim?: { start: number; end: number };
}

/**
 * Preparations made before v1.0.1 kept no state.json, so the app forgot which
 * clip each came from. Recover that by matching the audio samples of the
 * preparation's original-audio.wav against each candidate clip's audio, verify the files
 * against the manifest, and write a state.json so it is a reusable template.
 * Folders that are incomplete or match no clip are left alone.
 */
export async function adoptLegacyPreparations<Print>(
  root: string,
  candidates: SourceCandidate[],
  deps: {
    /** Fingerprint of a candidate clip's audio. */
    fingerprint: (path: string) => Promise<Print | null>;
    /** The same fingerprint of a preparation folder's original-audio.wav. */
    folderPrint: (dir: string) => Promise<Print | null>;
    matches: (a: Print, b: Print) => boolean;
    verify: (dir: string, manifestHash: string) => Promise<string | null>;
    describe: (id: string, dir: string, source: SourceCandidate, manifest: Record<string, unknown>) => Promise<StoredPreparation>;
  },
): Promise<StoredPreparation[]> {
  if (!existsSync(root)) return [];
  const adopted: StoredPreparation[] = [];
  const prints = new Map<string, Promise<Print | null>>();
  const printOf = (path: string) => {
    if (!prints.has(path)) prints.set(path, deps.fingerprint(path));
    return prints.get(path)!;
  };
  for (const id of await readdir(root)) {
    const dir = join(root, id);
    if (!/^[a-f0-9]{8}$/.test(id) || existsSync(join(dir, STATE_FILE)) || !existsSync(join(dir, "manifest.json"))) continue;
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    } catch {
      continue;
    }
    const hash = typeof manifest.manifestHash === "string" ? manifest.manifestHash : null;
    if (!hash || (await deps.verify(dir, hash))) continue;
    const print = await deps.folderPrint(dir);
    if (!print) continue;
    let source: SourceCandidate | undefined;
    for (const c of candidates) {
      const candidate = await printOf(c.path);
      if (candidate && deps.matches(candidate, print)) {
        source = c;
        break;
      }
    }
    if (!source) {
      console.warn(`preparation ${id}: no clip matches its audio, not adopted`);
      continue;
    }
    const state = await deps.describe(id, dir, source, manifest);
    await persistPreparation(root, state);
    adopted.push(state);
  }
  return adopted;
}
