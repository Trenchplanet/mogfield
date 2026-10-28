import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// the flag and a throwaway data folder must be in place before the module loads
process.env.BACKLOT_PER_VISITOR = "1";
process.env.BACKLOT_DATA_DIR = mkdtempSync(join(tmpdir(), "mogfield-scope-"));
const { OwnedMap, runAs, ownerOf } = await import("./scope.js");

test("each visitor only sees what they made", () => {
  const items = new OwnedMap<{ name: string; sample?: boolean }>();
  runAs("alice", () => items.set("aaaaaaaa", { name: "alice's video" }));
  runAs("bob", () => items.set("bbbbbbbb", { name: "bob's video" }));

  runAs("alice", () => {
    assert.deepEqual([...items.values()].map((i) => i.name), ["alice's video"]);
    assert.equal(items.get("bbbbbbbb"), undefined);
    assert.equal(items.has("bbbbbbbb"), false);
    assert.equal(items.delete("bbbbbbbb"), false);
  });
  runAs("bob", () => assert.deepEqual([...items.keys()], ["bbbbbbbb"]));
  assert.equal(ownerOf("aaaaaaaa"), "alice");
});

test("samples are shared, and background work with no visitor sees everything", () => {
  const items = new OwnedMap<{ name: string; sample?: boolean }>();
  items.set("sample-cat", { name: "cat", sample: true });
  runAs("carol", () => items.set("cccccccc", { name: "carol's" }));
  runAs("dave", () => assert.deepEqual([...items.values()].map((i) => i.name), ["cat"]));
  assert.equal(items.all().length, 2);
  assert.equal(items.size, 2);
});
