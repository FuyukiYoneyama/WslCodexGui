import assert from "node:assert/strict";
import test from "node:test";
import { appendSummaryDelta, liveReasoningText, startSummaryPart } from "./liveReasoning.ts";

test("deltas accumulate into the paragraph they belong to", () => {
  let s = appendSummaryDelta(null, { turnId: "t1", itemId: "rs1", summaryIndex: 0, delta: "まず" });
  s = appendSummaryDelta(s, { turnId: "t1", itemId: "rs1", summaryIndex: 0, delta: "調べる" });
  assert.deepEqual(s.parts, [{ itemId: "rs1", index: 0, text: "まず調べる" }]);
  assert.equal(liveReasoningText(s), "まず調べる");
});

test("a new summary part starts a paragraph, joined by a blank line", () => {
  let s = appendSummaryDelta(null, { turnId: "t1", itemId: "rs1", summaryIndex: 0, delta: "一段目" });
  s = startSummaryPart(s, { turnId: "t1", itemId: "rs1", summaryIndex: 1 });
  s = appendSummaryDelta(s, { turnId: "t1", itemId: "rs1", summaryIndex: 1, delta: "二段目" });
  assert.equal(liveReasoningText(s), "一段目\n\n二段目");
});

test("consecutive reasoning items stay separate even though summaryIndex restarts at 0", () => {
  let s = appendSummaryDelta(null, { turnId: "t1", itemId: "rs1", summaryIndex: 0, delta: "**一つ目**" });
  s = appendSummaryDelta(s, { turnId: "t1", itemId: "rs2", summaryIndex: 0, delta: "**二つ目**" });
  assert.equal(liveReasoningText(s), "**一つ目**\n\n**二つ目**");
});

test("an announced but still empty paragraph is not shown as a gap", () => {
  let s = appendSummaryDelta(null, { turnId: "t1", itemId: "rs1", summaryIndex: 0, delta: "一段目" });
  s = startSummaryPart(s, { turnId: "t1", itemId: "rs1", summaryIndex: 1 });
  assert.equal(s.parts.length, 2);
  assert.equal(liveReasoningText(s), "一段目");
});

test("paragraphs keep the order they arrived in", () => {
  let s = startSummaryPart(null, { turnId: "t1", itemId: "rs1", summaryIndex: 2 });
  s = appendSummaryDelta(s, { turnId: "t1", itemId: "rs1", summaryIndex: 2, delta: "先に来た" });
  s = appendSummaryDelta(s, { turnId: "t1", itemId: "rs1", summaryIndex: 0, delta: "後から来た" });
  assert.equal(liveReasoningText(s), "先に来た\n\n後から来た");
});

test("a delta from a different turn replaces the buffer instead of appending", () => {
  const first = appendSummaryDelta(null, { turnId: "t1", itemId: "rs1", summaryIndex: 0, delta: "前のターン" });
  const second = appendSummaryDelta(first, { turnId: "t2", itemId: "rs9", summaryIndex: 0, delta: "次のターン" });
  assert.deepEqual(second, { turnId: "t2", parts: [{ itemId: "rs9", index: 0, text: "次のターン" }] });
});

test("no buffer means no text", () => {
  assert.equal(liveReasoningText(null), "");
});
