import type { JournalEntry } from "./journal";
import { turnIsTerminal } from "./stateLogic.ts";
import type { TurnStatus } from "./types";

// F-08c reconciliation: given an open journal entry from a previous
// (possibly crashed) session, decide whether it can be cleared and what to
// tell the user -- against the thread's own last turn status, never by
// guessing. Never resends: every branch either keeps the entry (fate
// unknown) or clears it after a definitive answer.
export interface ReconciliationOutcome {
  clear: boolean;
  message: string | null;
}

export function decideJournalReconciliation(
  threadId: string,
  entry: JournalEntry,
  turns: { id: string; status: TurnStatus }[]
): ReconciliationOutcome {
  if (!entry.turnId) {
    // Never confirmed started server-side (still "prepared"/"sent" when the
    // app last closed) -- there's no ID to match against, so we genuinely
    // can't tell whether a turn exists. Leave the entry in place rather than
    // guessing; surface it so it isn't silently lost.
    return {
      clear: false,
      message: `前回のセッションで送信中だった可能性のあるturn（スレッド ${threadId.slice(0, 8)}…）の状態が確認できません。自動再送はしていません。`,
    };
  }

  const targetTurn = turns.find((t) => t.id === entry.turnId);
  if (!targetTurn) {
    // Matched by ID but not found in what thread/resume returned (could be
    // paginated out, or genuinely missing) -- still unresolved, keep it.
    return {
      clear: false,
      message: `前回のセッションのturn（${entry.turnId.slice(0, 8)}…）が見つかりません。状態不明のため自動再送はしていません。`,
    };
  }

  if (!turnIsTerminal(targetTurn.status)) {
    return {
      clear: false,
      message: `前回のturn（${entry.turnId.slice(0, 8)}…）は現在も実行中です。完了通知を待っています。`,
    };
  }

  // Only now do we have a definitive answer -- safe to clear.
  if (targetTurn.status !== "completed") {
    return {
      clear: true,
      message: `前回のセッションで未完了だったturn（${entry.turnId.slice(0, 8)}…）の状態: ${targetTurn.status}。自動再送はしていません。`,
    };
  }
  return { clear: true, message: null };
}
