// Provider-dependent half of turn/start's params.
//
// Ollama is reached by spawning codex with `-c model_provider=ollama -c
// model=<local model>`, but codex shapes each request around whatever model
// the *turn* names, and turn/start's `model` wins over that connect-time
// override. The 🧠 picker defaults to an OpenAI id (gpt-5.6-luna), so an
// Ollama session was still asking codex to build a GPT-5.6 payload -- which
// includes an `additional_tools` input item -- and pointing it at Ollama,
// which rejects the request outright:
//
//   input[0]: unknown input item type: "additional_tools"
//
// Verified against Ollama 0.32.5 / codex 0.146.0 on 2026-08-02: the same
// `codex exec -c model_provider=ollama` run succeeds under
// `-c model=gpt-oss:20b` and fails with exactly that error under
// `-c model=gpt-5.6-luna`. So under Ollama the turn carries no model at all
// and the connect-time override stands.
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
  effort: E | null,
  serviceTier: S | null
): { model?: string; effort?: E; serviceTier?: S } {
  if (provider === "ollama") {
    return effort && effort !== OLLAMA_UNSUPPORTED_EFFORT ? { effort } : {};
  }
  return {
    ...(modelOverride ? { model: modelOverride } : {}),
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}
