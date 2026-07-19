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
  if (e && e.requestId === requestId) {
    e.phase = "sent";
    e.updatedAt = Date.now();
    writeAll(all);
  }
}

/** Step 3: turn/started notification observed for this thread. */
export function journalMarkStarted(threadId: string, turnId: string): void {
  const all = readAll();
  const e = all[threadId];
  if (e) {
    e.turnId = turnId;
    e.phase = "started";
    e.updatedAt = Date.now();
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

/** Returns the open (non-completed) journal entry for a thread, if any. */
export function journalGet(threadId: string): JournalEntry | null {
  return readAll()[threadId] ?? null;
}

export function journalAll(): JournalEntry[] {
  return Object.values(readAll());
}
