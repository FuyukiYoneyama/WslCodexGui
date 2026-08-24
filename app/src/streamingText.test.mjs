import assert from "node:assert/strict";
import test from "node:test";
import { appendStreamingText, clearStreamingText, getStreamingText } from "./streamingText.ts";

// useSyncExternalStore itself needs a React renderer to exercise end-to-end;
// these tests cover the store's own bookkeeping (the part a regression here
// would silently break: notifying the wrong item, or not notifying at all).

test("appending accumulates text for that item id", () => {
  const id = `item-${Math.random()}`;
  assert.equal(getStreamingText(id), undefined);
  appendStreamingText(id, "Hello");
  appendStreamingText(id, ", world");
  assert.equal(getStreamingText(id), "Hello, world");
});

test("appending to one item id never touches another's buffer", () => {
  const a = `item-a-${Math.random()}`;
  const b = `item-b-${Math.random()}`;
  appendStreamingText(a, "for A");
  assert.equal(getStreamingText(a), "for A");
  assert.equal(getStreamingText(b), undefined);
});

test("clearing drops the buffer so a stray late delta can't resurrect it silently", () => {
  const id = `item-${Math.random()}`;
  appendStreamingText(id, "in progress");
  clearStreamingText(id);
  assert.equal(getStreamingText(id), undefined);
});

test("clearing an id with nothing buffered is a no-op, not an error", () => {
  const id = `item-${Math.random()}`;
  assert.doesNotThrow(() => clearStreamingText(id));
});

test("appending after a clear starts a fresh buffer rather than resuming the old one", () => {
  const id = `item-${Math.random()}`;
  appendStreamingText(id, "old turn");
  clearStreamingText(id);
  appendStreamingText(id, "new turn");
  assert.equal(getStreamingText(id), "new turn");
});
