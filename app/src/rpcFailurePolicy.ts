import type { RpcFailureKind } from "./types.ts";

// N-22 journal policy: an allowlist, not a blocklist. Only these two kinds
// mean non-delivery is certain, so only they may discard a journal entry.
// Every other kind -- including `undefined` (no structured RpcFailure at
// all) and any kind this list doesn't yet know about -- is "fate unknown"
// and must keep the entry for reconciliation instead of silently losing a
// turn that may have actually started server-side.
export function shouldAbortJournal(kind: RpcFailureKind | string | undefined): boolean {
  return kind === "write_failed" || kind === "server_rejected";
}
