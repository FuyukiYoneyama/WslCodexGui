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
  error?: unknown;
  threadId?: string;
  turnId?: string;
  willRetry?: boolean;
}

export interface TurnErrorNotice {
  /** Retryable: show it quietly and drop it once the turn produces anything. */
  transient: boolean;
  /** One line, for the visible notice. */
  summary: string;
  /** Recovery steps, shown with the summary rather than hidden in a tooltip. */
  action: string | null;
  /** Everything else, for the tooltip -- including any request id. */
  detail: string | null;
  turnId: string | null;
}

export function turnErrorNotice(params: TurnErrorParams | null | undefined): TurnErrorNotice {
  const rawError = params?.error;
  const error = rawError && typeof rawError === "object" ? rawError as Record<string, unknown> : null;
  const message = (typeof error?.message === "string" ? error.message : typeof rawError === "string" ? rawError : "").trim();
  const details = (typeof error?.additionalDetails === "string" ? error.additionalDetails : "").trim();
  // A model the provider has retired fails every attempt the same way, so
  // codex's retries can't help (observed 2026-10-17 with Ollama Cloud:
  // "deepseek-v4-flash:0731 was retired on September 25, 2026. Try ..."
  // after five reconnects). Surface it at once as a real failure and say what
  // to do, instead of a quiet "Reconnecting... n/5".
  const retired = RETIRED_MODEL.test(message) || RETIRED_MODEL.test(details);
  const transient = params?.willRetry === true && !retired;

  // The final turn/completed notification also carries this error. It must use
  // the same explanation as `error`, or it overwrites the notice with raw JSON.
  // Prefer the protocol code; the exact capacity wording covers providers or
  // older servers that omit it. A generic 503 is not enough to identify this.
  const errorCode = error?.codexErrorInfo;
  const overloaded = errorCode === "serverOverloaded"
    || ((errorCode == null || errorCode === "other")
      && (MODEL_AT_CAPACITY.test(message) || MODEL_AT_CAPACITY.test(details)));
  if (overloaded && !retired) {
    return {
      transient,
      summary: transient
        ? "選択中のモデルが混雑しています。"
        : "選択中のモデルが混雑しているため、処理を完了できませんでした。",
      action: transient
        ? "自動で再試行しています。そのままお待ちください。"
        : "少し時間を置いてから、もう一度メッセージを送信してください。\n急ぐ場合や繰り返す場合は、画面下部の「🧠」から別のモデルを選び、再送してください。",
      detail: [...new Set([message, details, errorCode === "serverOverloaded" ? "エラーコード: serverOverloaded" : ""].filter(Boolean))].join("\n") || null,
      turnId: params?.turnId ?? null,
    };
  }

  // codex puts its retry progress ("Reconnecting... 5/5") in `message`, which
  // is already the right one-liner. Fall back to additionalDetails when it is
  // missing, and only then to something generic -- never to raw JSON.
  const summary = retired
    ? "このモデルは提供が終了しています。別のモデルを選んでください（Ollamaなら `ollama rm <モデル名>` で一覧からも外せます）"
    : message || firstSentence(details) || "エラーが発生しました";

  // When the summary is our own retired-model text, the server's original
  // wording (which names the model and a suggested replacement) moves here.
  const detail = [retired && message && message !== details ? message : null, details && details !== summary ? details : null]
    .filter(Boolean)
    .join("\n") || null;

  return { transient, summary, action: null, detail, turnId: params?.turnId ?? null };
}

const RETIRED_MODEL = /\bwas retired on\b/i;
const MODEL_AT_CAPACITY = /\bselected model is at capacity\b/i;

// Server messages run long and bury the useful part; the tooltip keeps the
// whole thing, so the visible line only needs the opening statement.
function firstSentence(text: string): string {
  if (!text) return "";
  const cut = text.search(/[.。]\s|\n/);
  return cut > 0 ? text.slice(0, cut + 1).trim() : text;
}
