import assert from "node:assert/strict";
import test from "node:test";
import { composerRequest } from "./composerRequest.ts";

const TEXT = [{ type: "text", text: "hello", text_elements: [] }];
const TURN_FIELDS = { model: "gpt-5.6-luna", effort: "max", serviceTier: "priority" };

const build = (activeTurnId, input = TEXT) =>
  composerRequest({
    threadId: "th-1",
    activeTurnId,
    input,
    turnFields: TURN_FIELDS,
    summary: "detailed",
  });

test("with no turn running it starts one, carrying the turn-level settings", () => {
  assert.deepEqual(build(null), {
    method: "turn/start",
    params: {
      threadId: "th-1",
      input: TEXT,
      model: "gpt-5.6-luna",
      effort: "max",
      serviceTier: "priority",
      summary: "detailed",
    },
  });
});

test("with a turn running it steers that turn instead", () => {
  assert.deepEqual(build("turn-9"), {
    method: "turn/steer",
    params: { threadId: "th-1", expectedTurnId: "turn-9", input: TEXT },
  });
});

test("steering never carries turn-level settings the schema has no slot for", () => {
  // TurnSteerParams accepts only threadId/expectedTurnId/input/
  // clientUserMessageId -- model, effort, serviceTier and summary would be
  // rejected, not ignored.
  const { params } = build("turn-9");
  for (const key of ["model", "effort", "serviceTier", "summary"]) {
    assert.equal(key in params, false, `steer params must not contain ${key}`);
  }
  assert.deepEqual(Object.keys(params).sort(), ["expectedTurnId", "input", "threadId"]);
});

test("the running turn's id becomes the expectedTurnId precondition", () => {
  assert.equal(build("turn-9").params.expectedTurnId, "turn-9");
});

test("images ride along either way", () => {
  const withImage = [{ type: "localImage", path: "/tmp/a.png" }, ...TEXT];
  assert.deepEqual(build(null, withImage).params.input, withImage);
  assert.deepEqual(build("turn-9", withImage).params.input, withImage);
});
