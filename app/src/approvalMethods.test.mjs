import assert from "node:assert/strict";
import test from "node:test";
import { isApprovalMethod } from "./approvalMethods.ts";

test("known approval-flavored server-request methods are recognized", () => {
  assert.equal(isApprovalMethod("item/commandExecution/requestApproval"), true);
  assert.equal(isApprovalMethod("item/fileChange/requestApproval"), true);
  assert.equal(isApprovalMethod("execCommandApproval"), true);
  assert.equal(isApprovalMethod("applyPatchApproval"), true);
});

test("an unrelated or unknown server-request method is not treated as an approval", () => {
  assert.equal(isApprovalMethod("thread/list"), false);
  assert.equal(isApprovalMethod("someFutureRequestMethod"), false);
});
