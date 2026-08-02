import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsed } from "./formatElapsed.ts";

test("format seconds as M:SS", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(1000), "0:01");
  assert.equal(formatElapsed(59000), "0:59");
  assert.equal(formatElapsed(60000), "1:00");
  assert.equal(formatElapsed(61000), "1:01");
  assert.equal(formatElapsed(90000), "1:30");
  assert.equal(formatElapsed(599000), "9:59");
});

test("format minutes and seconds as MM:SS", () => {
  assert.equal(formatElapsed(600000), "10:00");
  assert.equal(formatElapsed(3599000), "59:59");
});

test("format hours as H:MM:SS", () => {
  assert.equal(formatElapsed(3600000), "1:00:00");
  assert.equal(formatElapsed(3661000), "1:01:01");
  assert.equal(formatElapsed(7322000), "2:02:02");
});

test("seconds are floored, not rounded", () => {
  assert.equal(formatElapsed(1999), "0:01");
  assert.equal(formatElapsed(1500), "0:01");
});
