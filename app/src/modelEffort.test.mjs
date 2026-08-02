import assert from "node:assert/strict";
import test from "node:test";
import { forcedEffortForModel } from "./modelEffort.ts";

test("selecting Luna forces the reasoning level to max", () => {
  assert.equal(forcedEffortForModel("gpt-5.6-luna"), "max");
  assert.equal(forcedEffortForModel("GPT-5.6-Luna"), "max");
  assert.equal(forcedEffortForModel("gpt-5.6-luna-preview"), "max");
});

test("selecting Sol or Terra forces the reasoning level to high", () => {
  assert.equal(forcedEffortForModel("gpt-5.6-sol"), "high");
  assert.equal(forcedEffortForModel("GPT-5.6-Sol"), "high");
  assert.equal(forcedEffortForModel("gpt-5.6-terra"), "high");
  assert.equal(forcedEffortForModel("GPT-5.6-Terra"), "high");
});

test("an unrelated model is left alone", () => {
  assert.equal(forcedEffortForModel("o3"), null);
});

test("a model that merely contains the letters is not matched", () => {
  assert.equal(forcedEffortForModel("lunar-1"), null);
  assert.equal(forcedEffortForModel("plutoluna"), null);
  assert.equal(forcedEffortForModel("terraform-1"), null);
  assert.equal(forcedEffortForModel("console-1"), null);
});

test("no model means no forced level", () => {
  assert.equal(forcedEffortForModel(null), null);
  assert.equal(forcedEffortForModel(undefined), null);
  assert.equal(forcedEffortForModel(""), null);
});
