// Hand-written subset of the app-server protocol types, transcribed from the
// output of `codex app-server generate-ts` on the pinned CLI version
// (codex-cli 0.144.5, see spec 4.3 ENV-01 / N-10). Only the fields the MVP
// actually consumes are declared; unknown fields flow through as `unknown`.

export type RequestId = string | number;

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
  connectionId?: string;
}

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: string[] };

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error: unknown | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface Thread {
  id: string;
  preview: string;
  cwd: string;
  status: ThreadStatus;
  name: string | null;
  updatedAt: number;
  turns: Turn[];
}

export type ThreadItem =
  | { type: "userMessage"; id: string; content: { type: string; text?: string }[] }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: string;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | { type: "fileChange"; id: string; changes: FileUpdateChange[]; status: string }
  | { type: string; id: string; [k: string]: unknown };

export interface FileUpdateChange {
  path?: string;
  [k: string]: unknown;
}

// --- server -> client notifications (subset) ---

export interface AgentMessageDelta {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ItemNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

export interface Notification {
  method: string;
  params?: unknown;
  // Set by the Rust side (appserver.rs emit_with_id) so stale events from a
  // replaced Connection can be told apart from the current one.
  connectionId?: string;
}

// --- server -> client requests (approvals; spec 7.3) ---

// A decision is either a plain string ("accept", "decline", ...) or an object
// wrapper like {"acceptWithExecpolicyAmendment": {...}}. availableDecisions
// enumerates what THIS request accepts — buttons are built from it (F-04).
export type ApprovalDecision = string | Record<string, unknown>;

export interface CommandApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  availableDecisions?: ApprovalDecision[];
}

export interface ServerRequest {
  id: RequestId;
  method: string;
  params: unknown;
  connectionId?: string;
}

export interface ConnectionTaggedEvent {
  connectionId?: string;
  line?: string;
  message?: string;
}

// Mirrors Rust's appserver::RpcFailure. `connect` and `rpc_request` reject
// with this shape; other commands (open_wsl_terminal, open_in_explorer,
// etc.) still reject with a plain string.
export type RpcFailureKind =
  | "write_failed"
  | "server_rejected"
  | "response_timeout"
  | "connection_lost"
  | "internal_error";

export interface RpcFailure {
  kind: RpcFailureKind;
  message: string;
}

// --- model/list (used by the /model slash command) ---

export interface Model {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
}

// --- usage / rate limits (used by the /usage slash command) ---

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AccountCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  planType: string | null;
  credits?: AccountCredits | null;
}

export interface GetAccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface ThreadTokenUsageUpdated {
  threadId: string;
  turnId: string;
  tokenUsage: ThreadTokenUsage;
}
