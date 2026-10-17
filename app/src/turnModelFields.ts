// Provider-dependent half of turn/start's params.
//
// Ollama is reached by spawning codex with `-c model_provider=ollama -c
// model=<local model>`, but that connect-time override only decides which
// model a *brand-new* thread gets. Resuming an existing thread ignores it:
// codex carries the model forward from that thread's own last turn_context,
// recorded permanently in its rollout on disk -- reproduced live 2026-08-23
// by resuming a thread created under gemma4:12B from a freshly spawned
// process whose `-c model=` said qwen3.8:27b; `ollama ps` and the thread's
// own turn_context both showed gemma4:12B still ran. `turn/start`'s own
// `model` field is the one thing that wins regardless: sending it explicitly
// switched that same resumed thread to qwen3.8:27b immediately. So the
// picked Ollama model has to ride every turn/start, not just the spawn.
//
// The 🧠 picker's OpenAI id (gpt-6.1-sol by default) must never go through
// here instead -- that was the original bug this function guarded against:
// codex built a GPT-5.6 payload (including an `additional_tools` input item)
// and pointed it at Ollama, which 400s outright:
//
//   input[0]: unknown input item type: "additional_tools"
//
// Verified against Ollama 0.32.5 / codex 0.146.0 on 2026-08-02: the same
// `codex exec -c model_provider=ollama` run succeeds under
// `-c model=gpt-oss:20b` and fails with exactly that error under
// `-c model=gpt-5.6-luna`.
//
// serviceTier is an OpenAI-account concept with no Ollama equivalent (same
// reason the footer hides its badge there), and "xhigh" is the one reasoning
// level Ollama does not accept -- its own rejection enumerates the valid set
// as "high", "medium", "low", "max", "none". Both are dropped rather than
// passed through to fail the turn. Everything else is unchanged for OpenAI.
const OLLAMA_UNSUPPORTED_EFFORT = "xhigh";

export function turnModelFields<E extends string, S extends string>(
  provider: "openai" | "ollama",
  modelOverride: string | null,
  ollamaModel: string,
  effort: E | null,
  serviceTier: S | null
): { model?: string; effort?: E; serviceTier?: S } {
  if (provider === "ollama") {
    return {
      ...(ollamaModel.trim() ? { model: ollamaModel.trim() } : {}),
      ...(effort && effort !== OLLAMA_UNSUPPORTED_EFFORT ? { effort } : {}),
    };
  }
  return {
    ...(modelOverride ? { model: modelOverride } : {}),
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}
