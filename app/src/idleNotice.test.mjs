import assert from "node:assert/strict";
import test from "node:test";
import { IDLE_NOTICE_THRESHOLD_MS, inputDetected, shouldNotifyOnTurnEnd } from "./idleNotice.ts";

test("a finished turn only interrupts a desktop that has been idle", () => {
  assert.equal(shouldNotifyOnTurnEnd(0), false);
  assert.equal(shouldNotifyOnTurnEnd(IDLE_NOTICE_THRESHOLD_MS - 1), false);
  assert.equal(shouldNotifyOnTurnEnd(IDLE_NOTICE_THRESHOLD_MS), true);
  assert.equal(shouldNotifyOnTurnEnd(60_000), true);
});

test("the threshold is adjustable per call", () => {
  assert.equal(shouldNotifyOnTurnEnd(3000, 10_000), false);
  assert.equal(shouldNotifyOnTurnEnd(30_000, 10_000), true);
});

test("a drop in the idle counter is the input signal", () => {
  assert.equal(inputDetected(8000, 120), true);
  assert.equal(inputDetected(8000, 0), true);
});

test("a still-growing idle counter is not input", () => {
  assert.equal(inputDetected(8000, 8500), false);
  assert.equal(inputDetected(8000, 8000), false); // same tick read twice
});
