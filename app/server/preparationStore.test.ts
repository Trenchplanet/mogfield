import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MANIFEST_FILES, verifyPreparation } from "./genjustsu.js";
import { loadPreparations, persistPreparation, type StoredPreparation } from "./preparationStore.js";

const sha = (b: string) => createHash("sha256").update(b).digest("hex");

/** A finished preparation folder the way genjustsu writes it. */
async function readyFolder(root: string, id: string) {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const manifest: Record<string, string> = {};
  for (const [key, file] of Object.entries(MANIFEST_FILES)) {
    await writeFile(join(dir, file), `${id}:${file}`);
    manifest[key] = sha(`${id}:${file}`);
  }
  const hashed = { ...manifest, segmentPrompt: "person", preparationProvider: "test" };
  const manifestHash = sha(JSON.stringify(hashed));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...hashed, manifestHash, reviewRequired: true }));
  return manifestHash;
}

const base = (id: string, extra: Partial<StoredPreparation>): StoredPreparation => ({
  id, clipId: "clip1", segmentPrompt: "person", status: "ready", progress: 1, message: "", approved: false, sourcePath: "/x", createdAt: 1, ...extra,
});

test("a restart keeps ready preparations, fails interrupted and tampered ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "prep-"));
  try {
    const goodHash = await readyFolder(root, "aaaa0001");
    await persistPreparation(root, base("aaaa0001", { manifestHash: goodHash, approved: true, createdAt: 3 }));

    const badHash = await readyFolder(root, "aaaa0002");
    await writeFile(join(root, "aaaa0002", "seedance-input.mp4"), "edited after review");
    await persistPreparation(root, base("aaaa0002", { manifestHash: badHash, approved: true, createdAt: 2 }));

    await persistPreparation(root, base("aaaa0003", { status: "running", progress: 0.72, createdAt: 1 }));
    await mkdir(join(root, "legacy00")); // pre-1.0.1 folder without state.json

    const loaded = await loadPreparations(root, verifyPreparation);
    assert.deepEqual(loaded.map((l) => l.state.id), ["aaaa0001", "aaaa0002", "aaaa0003"]); // newest first, legacy skipped
    const [good, bad, interrupted] = loaded;
    assert.equal(good.state.status, "ready");
    assert.equal(good.state.approved, true);
    assert.equal(good.changed, false);
    assert.equal(bad.state.status, "failed");
    assert.equal(bad.state.approved, false);
    assert.match(bad.state.error ?? "", /seedance-input\.mp4 changed/);
    assert.equal(interrupted.state.status, "failed");
    assert.match(interrupted.state.error ?? "", /restarted/);
    assert.equal(interrupted.changed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rapid saves land in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "prep-"));
  try {
    const s = base("bbbb0001", { status: "running" });
    void persistPreparation(root, { ...s, message: "one" });
    void persistPreparation(root, { ...s, message: "two" });
    await persistPreparation(root, { ...s, message: "three" });
    assert.equal(JSON.parse(await readFile(join(root, "bbbb0001", "state.json"), "utf8")).message, "three");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("older preparations are adopted only when complete, intact and matched to a clip", async () => {
  const { adoptLegacyPreparations } = await import("./preparationStore.js");
  const root = await mkdtemp(join(tmpdir(), "prep-"));
  try {
    const okHash = await readyFolder(root, "cccc0001"); // matches clipA
    await readyFolder(root, "cccc0002"); // no matching clip
    await mkdir(join(root, "cccc0003")); // incomplete: no manifest
    const prints: Record<string, string> = { "/clips/a.mp4": "voice-a", "/clips/b.mp4": "voice-b" };
    const folder: Record<string, string> = { cccc0001: "voice-a", cccc0002: "voice-z" };
    const adopted = await adoptLegacyPreparations(root, [{ path: "/clips/b.mp4", clipId: "clipB" }, { path: "/clips/a.mp4", clipId: "clipA", trim: { start: 0, end: 5 } }], {
      fingerprint: async (p) => prints[p] ?? null,
      folderPrint: async (dir) => folder[dir.split("/").pop()!] ?? null,
      matches: (a, b) => a === b,
      verify: verifyPreparation,
      describe: async (id, _dir, source, manifest) => base(id, { clipId: source.clipId, trim: source.trim, manifestHash: String(manifest.manifestHash) }),
    });
    assert.deepEqual(adopted.map((p) => [p.id, p.clipId, p.trim?.end]), [["cccc0001", "clipA", 5]]);
    assert.equal(adopted[0].manifestHash, okHash);
    // written to disk, so the next start loads it like any other preparation
    const reloaded = await loadPreparations(root, verifyPreparation);
    assert.deepEqual(reloaded.map((l) => [l.state.id, l.state.status]), [["cccc0001", "ready"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
