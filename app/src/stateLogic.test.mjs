import assert from "node:assert/strict";
import test from "node:test";
import { latestInProgressTurnId, sameImageContext, turnIsTerminal } from "./stateLogic.ts";

test("an image context is scoped to connection, distro, and thread", () => {
  const base = { connectionId: "c1", distro: "Ubuntu", threadId: "t1" };
  assert.equal(sameImageContext(base, { ...base }), true);
  assert.equal(sameImageContext(base, { ...base, connectionId: "c2" }), false);
  assert.equal(sameImageContext(base, { ...base, distro: "Ubuntu-24.04" }), false);
  assert.equal(sameImageContext(base, { ...base, threadId: "t2" }), false);
});

test("the latest running turn is restored when a thread is resumed", () => {
  assert.equal(
    latestInProgressTurnId([
      { id: "old", status: "completed" },
      { id: "running", status: "inProgress" },
    ]),
    "running",
  );
  assert.equal(latestInProgressTurnId([{ id: "done", status: "failed" }]), null);
});

test("inProgress is the only non-terminal turn status", () => {
  assert.equal(turnIsTerminal("inProgress"), false);
  assert.equal(turnIsTerminal("completed"), true);
  assert.equal(turnIsTerminal("interrupted"), true);
  assert.equal(turnIsTerminal("failed"), true);
});
