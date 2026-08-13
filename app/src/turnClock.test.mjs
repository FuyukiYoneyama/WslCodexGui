import assert from "node:assert/strict";
import test from "node:test";
import { elapsedMs, pauseClock, resumeClock, startClock } from "./turnClock.ts";

const T = 1_000_000; // arbitrary epoch base, keeps the arithmetic readable

test("runs as plain wall-clock while nothing is waiting", () => {
  const clock = startClock(T);
  assert.equal(elapsedMs(clock, T), 0);
  assert.equal(elapsedMs(clock, T + 5000), 5000);
});

test("the figure holds still while an approval is open", () => {
  let clock = startClock(T);
  clock = pauseClock(clock, T + 3000);
  assert.equal(elapsedMs(clock, T + 3000), 3000);
  assert.equal(elapsedMs(clock, T + 60_000), 3000, "must not advance during the wait");
});

test("the wait is excluded once the approval is answered", () => {
  let clock = startClock(T);
  clock = pauseClock(clock, T + 3000);
  clock = resumeClock(clock, T + 63_000); // a minute spent deciding
  assert.equal(elapsedMs(clock, T + 63_000), 3000);
  assert.equal(elapsedMs(clock, T + 65_000), 5000, "counting resumes from where it stopped");
});

test("several approvals in one turn each subtract their own wait", () => {
  let clock = startClock(T);
  clock = pauseClock(clock, T + 1000);
  clock = resumeClock(clock, T + 11_000); // waited 10s
  clock = pauseClock(clock, T + 12_000);
  clock = resumeClock(clock, T + 32_000); // waited 20s
  // 32s of wall clock, 30s of it waiting.
  assert.equal(elapsedMs(clock, T + 32_000), 2000);
});

test("pausing twice does not restart the wait", () => {
  let clock = startClock(T);
  clock = pauseClock(clock, T + 1000);
  const again = pauseClock(clock, T + 5000);
  assert.equal(again.pausedAt, T + 1000);
  assert.equal(elapsedMs(again, T + 9000), 1000);
});

test("resuming when not paused changes nothing", () => {
  const clock = startClock(T);
  assert.deepEqual(resumeClock(clock, T + 5000), clock);
});

test("a backwards system clock cannot shorten the turn", () => {
  let clock = startClock(T);
  clock = pauseClock(clock, T + 10_000);
  clock = resumeClock(clock, T + 4000); // clock jumped backwards
  assert.equal(clock.start, T, "start must not move backwards");
  assert.equal(elapsedMs(clock, T + 12_000), 12_000);
});

test("elapsed never goes negative", () => {
  const clock = startClock(T);
  assert.equal(elapsedMs(clock, T - 5000), 0);
});
