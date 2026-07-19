// Minimal operation journal (spec N-22 / F-08c). Tracks in-flight turns so
// that after a GUI crash + restart, we can tell "did that turn/start
// actually land?" instead of guessing -- and, critically, never
// auto-resend a turn/start just because we don't know.
//
// Deliberately just localStorage (not SQLite, not a Tauri fs-backed file):
// this is a personal desktop tool, one journal entry per in-flight turn at
// most (N-17 already serializes sends per thread), and localStorage is
// already how every other piece of app config is persisted here. Only
// bookkeeping fields are stored -- never conversation text, command output,
// or reasoning content (N-22).

const STORAGE_KEY = "turnJournal";

export type JournalPhase = "prepared" | "sent" | "started" | "completed";

// Monotonic: turn/started can (and does, in practice) arrive before the
// turn/start RPC call itself resolves, so a naive "last writer wins" update
// would let the phase regress from "started" back down to "sent". Every
// mark* function below only ever moves an entry forward through this rank.
const PHASE_RANK: Record<JournalPhase, number> = {
  prepared: 0,
  sent: 1,
  started: 2,
  completed: 3,
};

export interface JournalEntry {
  threadId: string;
  turnId: string | null;
  requestId: string; // client-side correlation id (crypto.randomUUID()), not the wire-level JSON-RPC id
  phase: JournalPhase;
  updatedAt: number;
}

function readAll(): Record<string, JournalEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, JournalEntry>) : {};
  } catch {
    return {};
  }
}

function writeAll(entries: Record<string, JournalEntry>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function advance(e: JournalEntry, next: JournalPhase): boolean {
  if (PHASE_RANK[next] <= PHASE_RANK[e.phase]) return false;
  e.phase = next;
  e.updatedAt = Date.now();
  return true;
}

/** Step 1: record intent, before the turn/start RPC is even issued. */
export function journalPrepare(threadId: string, requestId: string): void {
  const all = readAll();
  all[threadId] = { threadId, turnId: null, requestId, phase: "prepared", updatedAt: Date.now() };
  writeAll(all);
}

/** Step 2: the turn/start RPC call resolved (app-server accepted it). */
export function journalMarkSent(threadId: string, requestId: string): void {
  const all = readAll();
  const e = all[threadId];
  if (e && e.requestId === requestId && advance(e, "sent")) {
    writeAll(all);
  }
}

/** Step 3: turn/started notification observed for this thread. */
export function journalMarkStarted(threadId: string, turnId: string): void {
  const all = readAll();
  const e = all[threadId];
  if (e) {
    e.turnId = turnId; // record regardless of phase advancement outcome
    advance(e, "started");
    writeAll(all);
  }
}

/** Step 4: turn/completed observed -- the entry's job is done, drop it. */
export function journalMarkCompleted(threadId: string): void {
  const all = readAll();
  if (all[threadId]) {
    delete all[threadId];
    writeAll(all);
  }
}

/**
 * Turn/start definitively did NOT reach app-server (e.g. the stdin write
 * itself failed, or app-server returned an explicit JSON-RPC rejection).
 * Only call this for failures where non-delivery is certain -- a timeout or
 * a dropped connection means the request's fate is genuinely unknown, and
 * the entry must be left for reconciliation instead of discarded here.
 */
export function journalAbort(threadId: string, requestId: string): void {
  const all = readAll();
  const e = all[threadId];
  if (e && e.requestId === requestId && e.phase === "prepared") {
    delete all[threadId];
    writeAll(all);
  }
}

/** Returns the open (non-completed) journal entry for a thread, if any. */
export function journalGet(threadId: string): JournalEntry | null {
  return readAll()[threadId] ?? null;
}

export function journalAll(): JournalEntry[] {
  return Object.values(readAll());
}
