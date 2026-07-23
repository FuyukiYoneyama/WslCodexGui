import assert from "node:assert/strict";
import test from "node:test";
import { decideJournalReconciliation } from "./journalReconciliation.ts";

const baseEntry = { threadId: "t1", requestId: "r1", phase: "sent", updatedAt: 0 };

test("no turnId yet: kept, fate genuinely unknown", () => {
  const outcome = decideJournalReconciliation("t1", { ...baseEntry, turnId: null }, []);
  assert.equal(outcome.clear, false);
  assert.match(outcome.message, /状態が確認できません/);
});

test("turnId set but not found among the thread's turns: kept", () => {
  const outcome = decideJournalReconciliation("t1", { ...baseEntry, turnId: "missing" }, [
    { id: "other", status: "completed" },
  ]);
  assert.equal(outcome.clear, false);
  assert.match(outcome.message, /見つかりません/);
});

test("matching turn still inProgress: kept, waiting for completion", () => {
  const outcome = decideJournalReconciliation("t1", { ...baseEntry, turnId: "tu1" }, [
    { id: "tu1", status: "inProgress" },
  ]);
  assert.equal(outcome.clear, false);
  assert.match(outcome.message, /実行中です/);
});

test("matching turn completed: cleared silently", () => {
  const outcome = decideJournalReconciliation("t1", { ...baseEntry, turnId: "tu1" }, [
    { id: "tu1", status: "completed" },
  ]);
  assert.equal(outcome.clear, true);
  assert.equal(outcome.message, null);
});

test("matching turn terminal but not completed (failed/interrupted): cleared with a notice", () => {
  for (const status of ["failed", "interrupted"]) {
    const outcome = decideJournalReconciliation("t1", { ...baseEntry, turnId: "tu1" }, [
      { id: "tu1", status },
    ]);
    assert.equal(outcome.clear, true);
    assert.match(outcome.message, new RegExp(status));
  }
});
