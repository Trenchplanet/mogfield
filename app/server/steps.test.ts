import assert from "node:assert/strict";
import { test } from "node:test";
import { failRunning, finishAll, makeSteps, PREPARATION_STEPS, setStep } from "./steps.js";

test("starting a step ticks off every earlier one", () => {
  const steps = makeSteps(PREPARATION_STEPS);
  setStep(steps, "normalize", "running", undefined, 1);
  setStep(steps, "sam", "running", "Comfy queue #2", 5);
  assert.deepEqual(steps.map((s) => s.state), ["done", "done", "running", "pending", "pending", "pending"]);
  assert.equal(steps[0].endedAt, 5);
  assert.equal(steps[2].startedAt, 5);
  assert.equal(steps[2].note, "Comfy queue #2");
});

test("a note change on the running step counts as a change, a repeat does not", () => {
  const steps = makeSteps(PREPARATION_STEPS);
  assert.equal(setStep(steps, "depth", "running", "Comfy queue #1"), true);
  assert.equal(setStep(steps, "depth", "running", "Comfy queue #1"), false);
  assert.equal(setStep(steps, "depth", "running", "running on Comfy"), true);
  assert.equal(setStep(steps, "nope", "running"), false);
});

test("failure lands on the running step; finishAll ticks the rest", () => {
  const steps = makeSteps(PREPARATION_STEPS);
  setStep(steps, "sam", "running", undefined, 3);
  failRunning(steps, 9);
  assert.equal(steps[2].state, "failed");
  assert.equal(steps[2].endedAt, 9);
  finishAll(steps);
  assert.ok(steps.every((s) => s.state === "done"));
});
