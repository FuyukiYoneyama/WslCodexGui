import assert from "node:assert/strict";
import test from "node:test";
import { shouldAbortJournal } from "./rpcFailurePolicy.ts";

test("only certain non-delivery kinds abort the journal entry", () => {
  assert.equal(shouldAbortJournal("write_failed"), true);
  assert.equal(shouldAbortJournal("server_rejected"), true);
});

test("uncertain-delivery kinds keep the journal entry for reconciliation", () => {
  assert.equal(shouldAbortJournal("connection_lost"), false);
  assert.equal(shouldAbortJournal("response_timeout"), false);
  assert.equal(shouldAbortJournal("internal_error"), false);
});

test("missing or unknown kinds default to keeping the entry (fail safe)", () => {
  assert.equal(shouldAbortJournal(undefined), false);
  assert.equal(shouldAbortJournal("some_future_kind_nobody_taught_this_list_about"), false);
});
