import assert from "node:assert/strict";
import test from "node:test";
import { creditBadge } from "./creditBadge.ts";

const snapshot = (credits, primaryUsed = 0, secondaryUsed = null) => ({
  limitId: "codex",
  limitName: null,
  primary: primaryUsed === null ? null : { usedPercent: primaryUsed, windowDurationMins: 10080, resetsAt: null },
  secondary: secondaryUsed === null ? null : { usedPercent: secondaryUsed, windowDurationMins: 300, resetsAt: null },
  planType: "prolite",
  credits,
});

// Shape taken verbatim from a live account/rateLimits/read response.
const REAL = { hasCredits: true, unlimited: false, balance: "1234.5678900000" };

test("the balance shows even while plan quota remains", () => {
  assert.deepEqual(creditBadge(snapshot(REAL, 25)), { balance: "1234.57", drawing: false });
});

test("drawing flips once a window is exhausted", () => {
  assert.equal(creditBadge(snapshot(REAL, 100))?.drawing, true);
  assert.equal(creditBadge(snapshot(REAL, 0, 100))?.drawing, true);
  assert.equal(creditBadge(snapshot(REAL, 99, 99))?.drawing, false);
});

test("no badge without credits on the account", () => {
  assert.equal(creditBadge(snapshot(null)), null);
  assert.equal(creditBadge(snapshot(undefined)), null);
  assert.equal(creditBadge(snapshot({ hasCredits: false, unlimited: false, balance: "0" })), null);
});

test("no badge on an unlimited plan, where a remaining balance means nothing", () => {
  assert.equal(creditBadge(snapshot({ hasCredits: true, unlimited: true, balance: "1234.57" })), null);
});

test("the balance is rounded to two places", () => {
  assert.equal(creditBadge(snapshot({ ...REAL, balance: "0.005" }))?.balance, "0.01");
  assert.equal(creditBadge(snapshot({ ...REAL, balance: "12" }))?.balance, "12.00");
});

test("an unparseable balance is passed through rather than shown as NaN", () => {
  assert.equal(creditBadge(snapshot({ ...REAL, balance: "unknown" }))?.balance, "unknown");
  assert.equal(creditBadge(snapshot({ ...REAL, balance: null }))?.balance, "?");
});

test("a missing window counts as unexhausted, not as 100%", () => {
  assert.equal(creditBadge(snapshot(REAL, null))?.drawing, false);
});
