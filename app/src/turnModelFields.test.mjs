import assert from "node:assert/strict";
import test from "node:test";
import { turnModelFields } from "./turnModelFields.ts";

test("OpenAI turns carry model, effort and serviceTier as picked", () => {
  assert.deepEqual(turnModelFields("openai", "gpt-5.6-luna", "gpt-oss:20b", "max", "priority"), {
    model: "gpt-5.6-luna",
    effort: "max",
    serviceTier: "priority",
  });
});

test("OpenAI omits whichever of the three is unset", () => {
  assert.deepEqual(turnModelFields("openai", null, "gpt-oss:20b", null, null), {});
  assert.deepEqual(turnModelFields("openai", "gpt-5.6-sol", "gpt-oss:20b", null, null), { model: "gpt-5.6-sol" });
  assert.deepEqual(turnModelFields("openai", null, "gpt-oss:20b", "high", null), { effort: "high" });
  assert.deepEqual(turnModelFields("openai", null, "gpt-oss:20b", null, "default"), { serviceTier: "default" });
});

test("Ollama never carries the OpenAI model override, but does carry its own model", () => {
  // The whole point of dropping modelOverride: this is what made codex build
  // a GPT-5.6 payload (with an `additional_tools` input item) and send it to
  // Ollama, which 400s.
  assert.deepEqual(turnModelFields("ollama", "gpt-5.6-luna", "gpt-oss:20b", null, null), {
    model: "gpt-oss:20b",
  });
});

test("Ollama's own model rides every turn, not just the connect-time spawn", () => {
  // Reproduced live 2026-08-23: resuming a thread carries its own recorded
  // model forward regardless of what the current process was spawned with,
  // unless turn/start says otherwise. So this has to be sent even when
  // nothing else (effort, serviceTier) is picked.
  assert.deepEqual(turnModelFields("ollama", null, "qwen3.8:27b", null, null), { model: "qwen3.8:27b" });
  assert.deepEqual(turnModelFields("ollama", null, "", null, null), {});
});

test("Ollama never carries serviceTier", () => {
  assert.equal(turnModelFields("ollama", null, "gpt-oss:20b", null, "priority").serviceTier, undefined);
  assert.deepEqual(turnModelFields("ollama", null, "gpt-oss:20b", "high", "priority"), {
    model: "gpt-oss:20b",
    effort: "high",
  });
});

test("Ollama keeps the reasoning levels it accepts", () => {
  for (const effort of ["low", "medium", "high", "max"]) {
    assert.deepEqual(turnModelFields("ollama", "gpt-5.6-luna", "gpt-oss:20b", effort, null), {
      model: "gpt-oss:20b",
      effort,
    });
  }
});

test("Ollama drops xhigh, the one level it rejects", () => {
  assert.deepEqual(turnModelFields("ollama", null, "gpt-oss:20b", "xhigh", null), { model: "gpt-oss:20b" });
});

test("a known per-model list decides instead of the xhigh rule", () => {
  // qwen3.8:27b accepts xhigh (its /api/show thinking values, 2026-10-24).
  const qwen = ["none", "low", "medium", "xhigh"];
  assert.deepEqual(turnModelFields("ollama", null, "qwen3.8:27b", "xhigh", null, qwen), {
    model: "qwen3.8:27b",
    effort: "xhigh",
  });
  assert.deepEqual(turnModelFields("ollama", null, "qwen3.8:27b", "max", null, qwen), { model: "qwen3.8:27b" });
});

test("a model with no reasoning levels gets no effort", () => {
  assert.deepEqual(turnModelFields("ollama", null, "mistral-small3.2:latest", "high", null, []), {
    model: "mistral-small3.2:latest",
  });
});

test("the per-model list never applies to OpenAI", () => {
  assert.deepEqual(turnModelFields("openai", null, "gpt-oss:20b", "xhigh", null, []), { effort: "xhigh" });
});
