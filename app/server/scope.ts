import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * Per-visitor privacy for a public demo (BACKLOT_PER_VISITOR=1).
 *
 * Every visitor gets a private id in a cookie. Whatever they create (uploads,
 * characters, takes, projects) is recorded as theirs, and every list and lookup
 * answers only for the visitor making the request. Their data is deleted after
 * BACKLOT_VISITOR_TTL_HOURS (24 by default). With the flag off, nothing changes:
 * one person, one library.
 */
export const PER_VISITOR = process.env.BACKLOT_PER_VISITOR === "1";
const TTL_MS = Number(process.env.BACKLOT_VISITOR_TTL_HOURS ?? 24) * 3600_000;

const store = new AsyncLocalStorage<{ vid: string }>();
export const currentVisitor = () => (PER_VISITOR ? store.getStore()?.vid : undefined);
export const runAs = <T>(vid: string, fn: () => T) => store.run({ vid }, fn);

// ---------------------------------------------------------------- who owns what

const OWNERS_FILE = join(DATA_DIR, "owners.json");
const owners = new Map<string, { v: string; at: number }>();
if (PER_VISITOR && existsSync(OWNERS_FILE)) {
  try {
    for (const [id, o] of Object.entries(JSON.parse(readFileSync(OWNERS_FILE, "utf8")) as Record<string, { v: string; at: number }>)) owners.set(id, o);
  } catch {
    /* unreadable: start empty */
  }
}
let persistTimer: NodeJS.Timeout | null = null;
function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void writeFile(OWNERS_FILE, JSON.stringify(Object.fromEntries(owners))).catch(() => {}), 300);
}

/** Record the visitor making this request as the owner of an id. */
export function claim(id: string) {
  const vid = currentVisitor();
  if (!vid || owners.has(id)) return;
  owners.set(id, { v: vid, at: Date.now() });
  persist();
}
export const ownerOf = (id: string) => owners.get(id)?.v;

/** With no visitor in context (startup, timers) everything is visible. */
function canSee(id: string, sample: boolean) {
  const vid = currentVisitor();
  if (!vid || sample) return true;
  return owners.get(id)?.v === vid;
}

// ---------------------------------------------------------------- a Map that shows each visitor only their own

const purgers: ((id: string) => void)[] = [];
const afterPurge: (() => void)[] = [];
/** Called once after expired data has been removed, so stores can save. */
export const onPurged = (fn: () => void) => void afterPurge.push(fn);

export class OwnedMap<V> extends Map<string, V> {
  constructor() {
    super();
    purgers.push((id) => void super.delete(id));
  }
  private shows(k: string, v: V) {
    return canSee(k, (v as { sample?: boolean } | null)?.sample === true);
  }
  override get(k: string) {
    const v = super.get(k);
    return v !== undefined && this.shows(k, v) ? v : undefined;
  }
  override has(k: string) {
    return this.get(k) !== undefined;
  }
  override set(k: string, v: V) {
    claim(k);
    return super.set(k, v);
  }
  override delete(k: string) {
    return this.has(k) ? super.delete(k) : false;
  }
  private visibleEntries(): [string, V][] {
    return [...super.entries()].filter(([k, v]) => this.shows(k, v));
  }
  override entries() {
    return this.visibleEntries()[Symbol.iterator]() as unknown as MapIterator<[string, V]>;
  }
  override keys() {
    return this.visibleEntries().map(([k]) => k)[Symbol.iterator]() as unknown as MapIterator<string>;
  }
  override values() {
    return this.visibleEntries().map(([, v]) => v)[Symbol.iterator]() as unknown as MapIterator<V>;
  }
  override [Symbol.iterator]() {
    return this.entries();
  }
  override forEach(fn: (v: V, k: string, m: Map<string, V>) => void) {
    for (const [k, v] of this.visibleEntries()) fn(v, k, this);
  }
  /** Everything, whoever owns it. For saving to disk. */
  all(): V[] {
    return [...super.values()];
  }
}

// ---------------------------------------------------------------- expiry

/** Delete a visitor's old data: records, then every file or folder named after the id. */
export async function sweepExpired(dirs: string[]) {
  if (!PER_VISITOR) return 0;
  const cutoff = Date.now() - TTL_MS;
  const old = [...owners].filter(([, o]) => o.at < cutoff).map(([id]) => id);
  if (!old.length) return 0;
  for (const id of old) {
    for (const purge of purgers) purge(id);
    owners.delete(id);
  }
  const gone = new Set(old);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const tokens = name.match(/(?<![0-9a-f])[0-9a-f]{8}(?![0-9a-f])/g) ?? [];
      if (tokens.some((t) => gone.has(t))) await rm(join(dir, name), { recursive: true, force: true });
    }
  }
  persist();
  for (const fn of afterPurge) fn();
  return old.length;
}
