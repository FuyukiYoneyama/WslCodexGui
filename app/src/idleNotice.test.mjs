import assert from "node:assert/strict";
import test from "node:test";
import {
  IDLE_NOTICE_THRESHOLD_MS,
  inputDetected,
  shouldFlashOnTurnEnd,
  shouldNotifyOnTurnEnd,
  shouldStopFlashing,
} from "./idleNotice.ts";

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

test("an unfocused window flashes even on an active desktop", () => {
  assert.equal(shouldFlashOnTurnEnd(0, false), true);
  assert.equal(shouldFlashOnTurnEnd(0, true), false);
});

test("a focused window still flashes once the desktop has been idle long enough", () => {
  assert.equal(shouldFlashOnTurnEnd(IDLE_NOTICE_THRESHOLD_MS, true), true);
  assert.equal(shouldFlashOnTurnEnd(IDLE_NOTICE_THRESHOLD_MS - 1, true), false);
});

test("either condition alone is enough to flash", () => {
  assert.equal(shouldFlashOnTurnEnd(IDLE_NOTICE_THRESHOLD_MS, false), true);
});

test("input elsewhere does not stop the flash while this window lacks focus", () => {
  assert.equal(shouldStopFlashing(false, 8000, 120), false);
  assert.equal(shouldStopFlashing(false, 8000, 0), false);
});

test("input stops the flash once this window has focus", () => {
  assert.equal(shouldStopFlashing(true, 8000, 120), true);
});

test("focus alone, with no fresh input yet, does not stop the flash", () => {
  assert.equal(shouldStopFlashing(true, 8000, 8500), false);
});
