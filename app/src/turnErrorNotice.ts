// How an `error` notification should be presented.
//
// The handler used to dump JSON.stringify(params) into the red banner, which
// produced things like:
//
//   {"error":{"additionalDetails":"stream disconnected before completion: An
//   error occurred while processing your request. ... Please include the
//   request ID 33bc91ca-... in your message.","codexErrorInfo":
//   {"responseStreamDisconnected":{"httpStatusCode":null}},"message":
//   "Reconnecting... 5/5"},"threadId":"...","turnId":"...","willRetry":true}
//
// Two things are wrong with that. It is unreadable, and -- more importantly --
// `willRetry: true` means codex is still working on it. Observed twice now
// against OpenAI (a 503 from the edge, and a mid-stream failure with no status
// code): both times the reconnect succeeded and the turn carried on, while the
// banner stayed on screen claiming a failure that had already been recovered.
//
// So a retryable notice is not an error yet. It gets a quieter presentation and
// is cleared as soon as work resumes. Anything with willRetry: false is a real
// failure and keeps the banner.
//
// Shape is from the app-server schema (v2/ErrorNotification): the params carry
// error / threadId / turnId / willRetry, and TurnError carries message plus an
// optional additionalDetails and codexErrorInfo.

export interface TurnErrorParams {
  error?: { message?: string; additionalDetails?: string | null; codexErrorInfo?: unknown } | null;
  threadId?: string;
  turnId?: string;
  willRetry?: boolean;
}

export interface TurnErrorNotice {
  /** Retryable: show it quietly and drop it once the turn produces anything. */
  transient: boolean;
  /** One line, for the visible notice. */
  summary: string;
  /** Everything else, for the tooltip -- including any request id. */
  detail: string | null;
  turnId: string | null;
}

export function turnErrorNotice(params: TurnErrorParams | null | undefined): TurnErrorNotice {
  const error = params?.error ?? null;
  const message = (error?.message ?? "").trim();
  const details = (error?.additionalDetails ?? "").trim();
  const transient = params?.willRetry === true;

  // codex puts its retry progress ("Reconnecting... 5/5") in `message`, which
  // is already the right one-liner. Fall back to additionalDetails when it is
  // missing, and only then to something generic -- never to raw JSON.
  const summary = message || firstSentence(details) || "エラーが発生しました";

  const detail = [details && details !== summary ? details : null]
    .filter(Boolean)
    .join("\n") || null;

  return { transient, summary, detail, turnId: params?.turnId ?? null };
}

// Server messages run long and bury the useful part; the tooltip keeps the
// whole thing, so the visible line only needs the opening statement.
function firstSentence(text: string): string {
  if (!text) return "";
  const cut = text.search(/[.。]\s|\n/);
  return cut > 0 ? text.slice(0, cut + 1).trim() : text;
}
