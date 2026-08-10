import assert from "node:assert/strict";
import test from "node:test";
import { BOTTOM_THRESHOLD_PX, isNearBottom } from "./scrollFollow.ts";

// A viewport 500 tall over 2000 of content: bottom is scrollTop === 1500.
const at = (scrollTop) => ({ scrollTop, scrollHeight: 2000, clientHeight: 500 });

test("pinned exactly at the bottom", () => {
  assert.equal(isNearBottom(at(1500)), true);
});

test("within the threshold still counts as following", () => {
  assert.equal(isNearBottom(at(1500 - BOTTOM_THRESHOLD_PX)), true);
});

test("past the threshold means the reader scrolled away", () => {
  assert.equal(isNearBottom(at(1500 - BOTTOM_THRESHOLD_PX - 1)), false);
  assert.equal(isNearBottom(at(0)), false);
});

test("overscroll past the bottom still counts", () => {
  // Momentum scrolling and fractional scrollTop under display scaling can
  // report slightly beyond the true bottom.
  assert.equal(isNearBottom(at(1502)), true);
});

test("content shorter than the viewport is always at the bottom", () => {
  assert.equal(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 500 }), true);
});

test("the threshold is adjustable", () => {
  assert.equal(isNearBottom(at(1400), 0), false);
  assert.equal(isNearBottom(at(1400), 100), true);
});
