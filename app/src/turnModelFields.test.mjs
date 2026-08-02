import assert from "node:assert/strict";
import test from "node:test";
import { turnModelFields } from "./turnModelFields.ts";

test("OpenAI turns carry model, effort and serviceTier as picked", () => {
  assert.deepEqual(turnModelFields("openai", "gpt-5.6-luna", "max", "priority"), {
    model: "gpt-5.6-luna",
    effort: "max",
    serviceTier: "priority",
  });
});

test("OpenAI omits whichever of the three is unset", () => {
  assert.deepEqual(turnModelFields("openai", null, null, null), {});
  assert.deepEqual(turnModelFields("openai", "gpt-5.6-sol", null, null), { model: "gpt-5.6-sol" });
  assert.deepEqual(turnModelFields("openai", null, "high", null), { effort: "high" });
  assert.deepEqual(turnModelFields("openai", null, null, "default"), { serviceTier: "default" });
});

test("Ollama never carries the OpenAI model override", () => {
  // The whole point: this is what made codex build a GPT-5.6 payload (with
  // an `additional_tools` input item) and send it to Ollama, which 400s.
  assert.deepEqual(turnModelFields("ollama", "gpt-5.6-luna", null, null), {});
  assert.equal(turnModelFields("ollama", "gpt-5.6-luna", "high", null).model, undefined);
});

test("Ollama never carries serviceTier", () => {
  assert.equal(turnModelFields("ollama", null, null, "priority").serviceTier, undefined);
  assert.deepEqual(turnModelFields("ollama", null, "high", "priority"), { effort: "high" });
});

test("Ollama keeps the reasoning levels it accepts", () => {
  for (const effort of ["low", "medium", "high", "max"]) {
    assert.deepEqual(turnModelFields("ollama", "gpt-5.6-luna", effort, null), { effort });
  }
});

test("Ollama drops xhigh, the one level it rejects", () => {
  assert.deepEqual(turnModelFields("ollama", null, "xhigh", null), {});
});
