// Sandbox settings sent on every thread/start and thread/resume.
//
// Lives in its own module (rather than App.tsx) so the codex regression test
// (scripts/regression/codex-regression.mjs) exercises exactly the values the
// app sends, instead of a copy that could silently drift.

// codex's own trust list (~/.codex/config.toml [projects]) decides sandbox
// per exact cwd path with no inheritance from a trusted parent -- a project
// folder picked here that isn't separately trusted via the codex CLI (which
// this GUI has no equivalent flow for) silently defaults to a read-only
// sandbox, so every write fails and, under approvalPolicy "never", fails
// *silently* with no chance to escalate. Deliberately choosing a WSL path in
// this app's project picker is itself the trust decision, so we always send
// workspace-write here rather than deferring to codex's own trust list --
// approvalPolicy is unaffected and still governs whether commands need
// confirmation; this only controls what's technically permitted to execute.
export const PROJECT_SANDBOX = "workspace-write";

// workspace-write's default writable set excludes .git (confirmed via a live
// probe: `git commit` fails with "Unable to create '.../.git/index.lock':
// Read-only file system", with no approval request offered regardless of
// approvalPolicy -- this is a hard sandbox denial, not something the
// approval level can escalate past). thread/start's `config` field accepts
// the same dotted-path overrides as codex's `-c`, so widen
// sandbox_workspace_write.writable_roots to include cwd/.git explicitly.
// Setting this replaces the whole list rather than appending, so cwd itself
// must be listed too.
export function gitWritableRootsConfig(cwd: string): Record<string, unknown> {
  const trimmed = cwd.replace(/\/$/, "");
  return { "sandbox_workspace_write.writable_roots": [trimmed, `${trimmed}/.git`] };
}
