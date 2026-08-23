// Ver.1.0必須条件4: 対応Codex CLIバージョンの宣言と、未確認バージョンの扱い。
// app-server's `initialize` response doesn't carry a dedicated version
// field, but `userAgent` is built as "<clientInfo.name>/<codex-cli-version>
// (<os>) ..." -- confirmed empirically against a real codex-cli 0.144.6
// install (see poc/ scripts and 仕様書.md ENV-01).
export function parseCodexCliVersion(userAgent: string): string | null {
  const match = /^\S+\/(\d+\.\d+\.\d+)\b/.exec(userAgent);
  return match ? match[1] : null;
}

// Versions this app has actually been run against (仕様書.md 4.3 ENV-01 /
// PoC records). Deliberately a plain allowlist, not a semver range check:
// a newer codex-cli could rename/remove a field this app depends on without
// any semver rule catching it, so "confirmed" means "actually tried",
// nothing more.
export const CONFIRMED_CODEX_CLI_VERSIONS = [
  "0.144.5",
  "0.144.6",
  "0.145.0",
  "0.146.0",
  "0.147.0",
  "0.148.0",
  "0.149.0",
];

export function isConfirmedCodexCliVersion(version: string): boolean {
  return CONFIRMED_CODEX_CLI_VERSIONS.includes(version);
}
