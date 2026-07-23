import assert from "node:assert/strict";
import test from "node:test";
import { ItemNotificationSchema } from "./schemas.ts";

const base = { threadId: "t1", turnId: "tu1" };

test("a well-formed known item type passes", () => {
  const result = ItemNotificationSchema.safeParse({
    ...base,
    item: { type: "agentMessage", id: "1", text: "hi" },
  });
  assert.equal(result.success, true);
});

test("a malformed known item type fails instead of silently falling back to the generic unknown-item schema", () => {
  const result = ItemNotificationSchema.safeParse({
    ...base,
    item: { type: "agentMessage", id: "1" }, // missing required `text`
  });
  assert.equal(result.success, false);
});

test("a type this app has never heard of still passes via the generic id/type-only schema", () => {
  const result = ItemNotificationSchema.safeParse({
    ...base,
    item: { type: "someFutureItemType", id: "1", whatever: 42 },
  });
  assert.equal(result.success, true);
});

test("an unknown item type without even an id still fails", () => {
  const result = ItemNotificationSchema.safeParse({
    ...base,
    item: { type: "someFutureItemType" },
  });
  assert.equal(result.success, false);
});
