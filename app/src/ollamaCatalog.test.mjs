import assert from "node:assert/strict";
import test from "node:test";
import {
  codexCatalogEntry,
  codexCatalogJson,
  effectiveContextWindow,
  isCloudModel,
  reasoningLevels,
} from "./ollamaCatalog.ts";

const base = {
  capabilities: ["completion", "tools"],
  thinking: null,
  showContextLength: null,
  listContextLength: null,
  loadedContextLength: null,
  envContextLength: null,
};

test("cloud model names", () => {
  assert.equal(isCloudModel("gemma4:cloud"), true);
  assert.equal(isCloudModel("deepseek-v4.1-flash:1017-cloud"), true);
  assert.equal(isCloudModel("gpt-oss:20b"), false);
  assert.equal(isCloudModel("cloudy-model:latest"), false);
  assert.equal(isCloudModel("noTag"), false);
});

test("a local model uses what Ollama allocated, not its trained maximum", () => {
  const d = { ...base, name: "gpt-oss:20b", listContextLength: 131072, showContextLength: 131072 };
  assert.equal(effectiveContextWindow({ ...d, loadedContextLength: 8192, envContextLength: 32768 }), 8192);
  assert.equal(effectiveContextWindow({ ...d, envContextLength: 32768 }), 32768);
  assert.equal(effectiveContextWindow(d), 131072);
});

test("a cloud model uses its own size even when something is loaded locally", () => {
  const d = { ...base, name: "gemma4:cloud", showContextLength: 262144, envContextLength: 4096, loadedContextLength: 4096 };
  assert.equal(effectiveContextWindow(d), 262144);
});

test("nothing known falls back to Ollama launch's default", () => {
  assert.equal(effectiveContextWindow({ ...base, name: "x:cloud" }), 128000);
});

// Values below are what /api/show returned on 2026-10-24.
test("reasoning levels follow the values Ollama accepts", () => {
  assert.deepEqual(reasoningLevels({ values: [false, "low", "high", "max"], default: "high" }), {
    levels: ["none", "low", "high", "max"],
    defaultLevel: "high",
  });
  assert.deepEqual(reasoningLevels({ values: [false, true], default: false }), {
    levels: ["none", "high"],
    defaultLevel: "none",
  });
  assert.deepEqual(reasoningLevels({ values: [true], default: true }), { levels: ["high"], defaultLevel: "high" });
  assert.deepEqual(reasoningLevels({ values: [false, "low", "medium", "xhigh"], default: "medium" }), {
    levels: ["none", "low", "medium", "xhigh"],
    defaultLevel: "medium",
  });
});

test("no thinking, or thinking that can only be off, means no levels", () => {
  assert.deepEqual(reasoningLevels(null), { levels: [], defaultLevel: null });
  assert.deepEqual(reasoningLevels({ values: [false], default: false }), { levels: [], defaultLevel: null });
});

test("true is not doubled up when high is also a named value", () => {
  assert.deepEqual(reasoningLevels({ values: [true, "high", "low"], default: "low" }).levels, ["high", "low"]);
});

test("unknown values and a default outside the list are dropped", () => {
  assert.deepEqual(reasoningLevels({ values: ["turbo", "low"], default: "turbo" }), { levels: ["low"], defaultLevel: null });
});

test("catalog entry matches Ollama launch's shape", () => {
  const d = {
    ...base,
    name: "deepseek-v4.1-flash:cloud",
    capabilities: ["completion", "thinking", "tools", "vision"],
    thinking: { values: [false, "low", "high", "max"], default: "high" },
  };
  const e = codexCatalogEntry(d, 1048576);
  assert.equal(e.slug, "deepseek-v4.1-flash:cloud");
  assert.equal(e.context_window, 1048576);
  assert.deepEqual(e.input_modalities, ["text", "image"]);
  assert.deepEqual(e.truncation_policy, { mode: "tokens", limit: 10000 });
  assert.equal(e.supports_parallel_tool_calls, false);
  assert.deepEqual(
    e.supported_reasoning_levels.map((l) => l.effort),
    ["none", "low", "high", "max"],
  );
  assert.equal(e.default_reasoning_level, "high");
});

test("a local text-only model gets bytes truncation and text input only", () => {
  const e = codexCatalogEntry({ ...base, name: "mistral-small3.2:latest" }, 32768);
  assert.deepEqual(e.input_modalities, ["text"]);
  assert.equal(e.truncation_policy.mode, "bytes");
  assert.deepEqual(e.supported_reasoning_levels, []);
  assert.equal(e.default_reasoning_level, null);
});

test("the JSON wraps the entry in models[]", () => {
  const parsed = JSON.parse(codexCatalogJson({ ...base, name: "gpt-oss:20b" }, 131072));
  assert.equal(parsed.models.length, 1);
  assert.equal(parsed.models[0].slug, "gpt-oss:20b");
});
