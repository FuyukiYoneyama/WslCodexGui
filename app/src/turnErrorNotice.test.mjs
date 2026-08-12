import assert from "node:assert/strict";
import test from "node:test";
import { turnErrorNotice } from "./turnErrorNotice.ts";

// Taken from a real notification (2026-08-10): mid-stream failure, codex
// retrying, and the turn did in fact carry on afterwards.
const RETRYING = {
  error: {
    additionalDetails:
      "stream disconnected before completion: An error occurred while processing your request. " +
      "You can retry your request, or contact us through our help center at help.openai.com if the " +
      "error persists. Please include the request ID 33bc91ca-a509-4235-8b53-1022ef73c5bb in your message.",
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    message: "Reconnecting... 5/5",
  },
  threadId: "019fb79d-fed0-78f0-bd6d-7ad03e3bf80f",
  turnId: "019ff26f-a77e-71a3-a677-9a132bc29f85",
  willRetry: true,
};

test("a retrying notification is not treated as a failure", () => {
  const notice = turnErrorNotice(RETRYING);
  assert.equal(notice.transient, true);
  assert.equal(notice.summary, "Reconnecting... 5/5");
  assert.equal(notice.turnId, "019ff26f-a77e-71a3-a677-9a132bc29f85");
});

test("the request id survives, in the detail rather than the visible line", () => {
  const notice = turnErrorNotice(RETRYING);
  assert.equal(notice.summary.includes("33bc91ca"), false);
  assert.match(notice.detail, /33bc91ca-a509-4235-8b53-1022ef73c5bb/);
});

test("nothing renders raw JSON", () => {
  const notice = turnErrorNotice(RETRYING);
  for (const value of [notice.summary, notice.detail]) {
    assert.equal(/[{}]/.test(value ?? ""), false, `found JSON punctuation in: ${value}`);
  }
});

test("willRetry false is a real failure", () => {
  const notice = turnErrorNotice({ ...RETRYING, willRetry: false });
  assert.equal(notice.transient, false);
});

test("a missing message falls back to the details, not to JSON", () => {
  const notice = turnErrorNotice({
    error: { additionalDetails: "upstream connect error. retried twice.", message: "" },
    willRetry: false,
  });
  assert.equal(notice.summary, "upstream connect error.");
  assert.equal(notice.detail, "upstream connect error. retried twice.");
});

test("an empty or malformed notification still says something", () => {
  assert.equal(turnErrorNotice(null).summary, "エラーが発生しました");
  assert.equal(turnErrorNotice({}).summary, "エラーが発生しました");
  assert.equal(turnErrorNotice({ error: null, willRetry: false }).summary, "エラーが発生しました");
  assert.equal(turnErrorNotice(undefined).transient, false);
});

test("detail is dropped when it would just repeat the summary", () => {
  const notice = turnErrorNotice({ error: { message: "boom", additionalDetails: "boom" }, willRetry: false });
  assert.equal(notice.summary, "boom");
  assert.equal(notice.detail, null);
});
