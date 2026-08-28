import assert from "node:assert/strict";
import test from "node:test";
import { rateLimitWindowLabel } from "./rateLimitLabel.ts";

test("the 5-hour window reads as 5h, not a generic letter", () => {
  assert.equal(rateLimitWindowLabel(300), "5h");
});

test("the weekly window reads as a week count", () => {
  assert.equal(rateLimitWindowLabel(7 * 24 * 60), "1週");
  assert.equal(rateLimitWindowLabel(14 * 24 * 60), "2週");
});

test("a whole-day window that isn't a whole week reads as days", () => {
  assert.equal(rateLimitWindowLabel(3 * 24 * 60), "3日");
});

test("a sub-hour window reads in minutes", () => {
  assert.equal(rateLimitWindowLabel(30), "30分");
});

test("a non-whole-hour window keeps one decimal", () => {
  assert.equal(rateLimitWindowLabel(90), "1.5h");
});

test("a missing duration falls back to a generic label rather than throwing", () => {
  assert.equal(rateLimitWindowLabel(null), "枠");
});
