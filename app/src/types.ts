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
}
