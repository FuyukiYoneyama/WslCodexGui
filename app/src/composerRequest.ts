// Which RPC a composer send becomes: a new turn, or a message injected into
// the one already running.
//
// turn/steer exists precisely for "ask what it's doing / redirect it / add a
// condition" without stopping the work. Verified against codex 0.146.0 on
// 2026-08-10 by driving a live app-server: a turn counting to 40 was steered
// mid-flight to "reply with exactly STEERED", and it did -- same turn id
// through to turn/completed, no extra turn/started, no turn/interrupt.
//
// The two param shapes are NOT interchangeable. TurnSteerParams carries only
// threadId / expectedTurnId / input / clientUserMessageId: model, effort,
// serviceTier and summary are turn-level settings fixed when the turn began,
// and the schema has nowhere to put them. Sending turn/start's extra fields
// here would be a protocol error, not a no-op.
//
// expectedTurnId is a precondition the server enforces ("the request fails
// when it does not match the currently active turn"), so a steer aimed at a
// turn that just finished is rejected rather than silently misapplied.

export type UserInput =
  | { type: "text"; text: string; text_elements: never[] }
  | { type: "localImage"; path: string };

export interface ComposerRequest {
  method: "turn/start" | "turn/steer";
  params: Record<string, unknown>;
}

export function composerRequest(args: {
  threadId: string;
  activeTurnId: string | null;
  input: UserInput[];
  turnFields: Record<string, unknown>;
  summary: string;
}): ComposerRequest {
  const { threadId, activeTurnId, input, turnFields, summary } = args;
  if (activeTurnId) {
    return {
      method: "turn/steer",
      params: { threadId, expectedTurnId: activeTurnId, input },
    };
  }
  return {
    method: "turn/start",
    params: { threadId, input, ...turnFields, summary },
  };
}
