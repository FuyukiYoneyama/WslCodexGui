// Model metadata handed to codex for an Ollama model, mirroring what Ollama's
// own `ollama launch codex` writes (cmd/launch/codex.go, Ollama 0.40.10).
//
// Without it codex knows nothing about the model: it warns "Model metadata
// for `<model>` not found. Defaulting to fallback metadata", and its
// background model refresh queries Ollama's /v1/models, fails to decode the
// OpenAI-shaped reply, and logs "failed to refresh available models" on
// every connect. With a catalog passed as `-c model_catalog_json=<file>` both
// go away and model/list returns the Ollama model itself (verified against
// codex 0.164.0 / Ollama 0.40.10 on 2026-10-24).
//
// Everything here is pure so the shape can be unit-tested; the Rust side
// only fetches the raw facts (list_ollama_model_details) and writes the file.

/** Raw facts about one model, as gathered by the Rust command. */
export interface OllamaModelDetails {
  name: string;
  /** /api/show `capabilities` (e.g. "tools", "vision", "thinking"). */
  capabilities: string[];
  /** /api/show `thinking`: the values Ollama accepts, and its default. */
  thinking: { values: (boolean | string)[]; default: boolean | string } | null;
  /** /api/show model_info `*.context_length` (the model's trained maximum). */
  showContextLength: number | null;
  /** /api/tags details.context_length. */
  listContextLength: number | null;
  /** /api/ps context_length when the model is loaded: what Ollama actually allocated. */
  loadedContextLength: number | null;
  /** OLLAMA_CONTEXT_LENGTH as seen by this app, if set. */
  envContextLength: number | null;
}

// Ollama launch's own fallback when nothing better is known.
const FALLBACK_CONTEXT_WINDOW = 128_000;

/** Cloud models are named `<model>:cloud` or `<model>:<tag>-cloud`. */
export function isCloudModel(name: string): boolean {
  const tag = name.trim().toLowerCase().split(":")[1] ?? "";
  return tag === "cloud" || tag.endsWith("-cloud");
}

const positive = (n: number | null | undefined): n is number => typeof n === "number" && n > 0;

/**
 * The context size codex should plan around. For a local model that is what
 * Ollama actually serves -- the loaded allocation, else OLLAMA_CONTEXT_LENGTH
 * -- not the trained maximum /api/tags reports: overstating it lets codex
 * believe there is room left while Ollama is already truncating the prompt.
 * Cloud models are served at their full size, so the model's own figure is
 * right there.
 */
export function effectiveContextWindow(d: OllamaModelDetails): number {
  const candidates = isCloudModel(d.name)
    ? [d.showContextLength, d.listContextLength]
    : [d.loadedContextLength, d.envContextLength, d.listContextLength, d.showContextLength];
  return candidates.find(positive) ?? FALLBACK_CONTEXT_WINDOW;
}

const CODEX_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function levelFor(value: boolean | string): string | null {
  if (value === true) return "high";
  if (value === false) return "none";
  return CODEX_LEVELS.has(value) ? value : null;
}

/**
 * codex reasoning levels for the values Ollama accepts for this model
 * (/api/show `thinking`). Same mapping as Ollama launch: `false` is "none",
 * `true` is "high" unless "high" is already a named value. An empty list
 * means the model takes no reasoning setting at all.
 */
export function reasoningLevels(thinking: OllamaModelDetails["thinking"]): {
  levels: string[];
  defaultLevel: string | null;
} {
  if (!thinking || !Array.isArray(thinking.values) || thinking.values.length === 0) {
    return { levels: [], defaultLevel: null };
  }
  const levels: string[] = [];
  for (const value of thinking.values) {
    if (value === true && thinking.values.includes("high")) continue;
    const level = levelFor(value);
    if (level && !levels.includes(level)) levels.push(level);
  }
  // Thinking that can only be switched off is no setting at all.
  if (thinking.values.length === 1 && thinking.values[0] === false) {
    return { levels: [], defaultLevel: null };
  }
  const defaultLevel = levelFor(thinking.default);
  return { levels, defaultLevel: defaultLevel && levels.includes(defaultLevel) ? defaultLevel : null };
}

/** One `models[]` entry of codex's model_catalog_json, in Ollama launch's shape. */
export function codexCatalogEntry(d: OllamaModelDetails, contextWindow: number): Record<string, unknown> {
  const { levels, defaultLevel } = reasoningLevels(d.thinking);
  return {
    slug: d.name,
    display_name: d.name,
    context_window: contextWindow,
    shell_type: "default",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    truncation_policy: { mode: isCloudModel(d.name) ? "tokens" : "bytes", limit: 10000 },
    input_modalities: d.capabilities.includes("vision") ? ["text", "image"] : ["text"],
    base_instructions: "",
    support_verbosity: true,
    default_verbosity: "low",
    // Ollama launch turns these off for every model: Ollama's tool-call
    // parsers handle one call per turn far more reliably.
    supports_parallel_tool_calls: false,
    supports_reasoning_summaries: false,
    supported_reasoning_levels: levels.map((effort) => ({ effort, description: effort })),
    default_reasoning_level: defaultLevel,
    experimental_supported_tools: [],
  };
}

export function codexCatalogJson(d: OllamaModelDetails, contextWindow: number): string {
  return JSON.stringify({ models: [codexCatalogEntry(d, contextWindow)] }, null, 2);
}
