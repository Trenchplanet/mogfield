import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateUsd, formatUsd } from "./pricing.js";

const s25 = { kind: "seedance-tokens" as const, per1k: { "480p": 1.931, "720p": 1.931, "1080p": 2.112 } };

test("Seedance estimate follows the published token formula", () => {
  // the real test run: 5 s, 480p, vertical, depth video only
  const run = estimateUsd(s25, { seconds: 5, quality: "480p", aspect: 9 / 16, inputVideos: 1 })!;
  assert.ok(Math.abs(run - 0.88) < 0.02, `got ${run}`);
  // 10 s 720p vertical: ~$3.95; keep background adds a second input video
  const one = estimateUsd(s25, { seconds: 10, quality: "720p", aspect: 9 / 16, inputVideos: 1 })!;
  const two = estimateUsd(s25, { seconds: 10, quality: "720p", aspect: 9 / 16, inputVideos: 2 })!;
  assert.ok(Math.abs(one - 3.95) < 0.05, `got ${one}`);
  assert.ok(Math.abs(two / one - 1.5) < 0.01);
  assert.equal(formatUsd(one), "~$3.95");
});

test("no estimate without rates for that quality, or for own-GPU models", () => {
  assert.equal(estimateUsd({ kind: "seedance-tokens", per1k: { "720p": 1 } }, { seconds: 5, quality: "1080p", aspect: 1, inputVideos: 1 }), null);
  assert.equal(estimateUsd(undefined, { seconds: 5, quality: "720p", aspect: 1, inputVideos: 1 }), null);
});
