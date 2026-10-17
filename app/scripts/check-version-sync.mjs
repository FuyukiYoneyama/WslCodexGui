// The product version is duplicated across npm, Cargo, and Tauri metadata (no
// single source of truth exists in a Tauri 2 project without extra tooling
// this project doesn't otherwise need). Manual edits to only some entries
// silently drift apart -- catch that loudly here instead of shipping a build
// whose footer, lockfiles, Cargo package, and executable metadata disagree.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(ROOT, "..");

function readJsonVersion(relPath) {
  const raw = readFileSync(ROOT + relPath, "utf8");
  return JSON.parse(raw).version;
}

function readCargoTomlVersion(relPath) {
  const raw = readFileSync(ROOT + relPath, "utf8");
  const match = /^version\s*=\s*"([^"]+)"/m.exec(raw);
  return match ? match[1] : null;
}

function readPackageLockRootVersion(relPath) {
  const raw = readFileSync(ROOT + relPath, "utf8");
  return JSON.parse(raw).packages?.[""]?.version ?? null;
}

function readCargoLockVersion(relPath) {
  const raw = readFileSync(ROOT + relPath, "utf8");
  const match = /\[\[package\]\]\s*\r?\nname\s*=\s*"app"\s*\r?\nversion\s*=\s*"([^"]+)"/m.exec(raw);
  return match ? match[1] : null;
}

const versions = {
  "package.json": readJsonVersion("package.json"),
  "package-lock.json": readJsonVersion("package-lock.json"),
  'package-lock.json packages[""]': readPackageLockRootVersion("package-lock.json"),
  "src-tauri/tauri.conf.json": readJsonVersion("src-tauri/tauri.conf.json"),
  "src-tauri/Cargo.toml": readCargoTomlVersion("src-tauri/Cargo.toml"),
  "src-tauri/Cargo.lock": readCargoLockVersion("src-tauri/Cargo.lock"),
};

const distinct = new Set(Object.values(versions));
if (distinct.size > 1) {
  console.error("Version mismatch across project files:");
  for (const [file, v] of Object.entries(versions)) console.error(`  ${file}: ${v}`);
  console.error("\nBump every listed entry to the same value (see 残項目.md's versioning policy).");
  process.exit(1);
}

// The newest entry of CONFIRMED_CODEX_CLI_VERSIONS and the protocol baseline
// (docs/codex-protocol-baseline/VERSION, written by scripts/codex-protocol.mjs
// --save) must move together: AGENTS.md has us update both in the same
// commit, and a forgotten baseline makes the next codex update re-report this
// one's changes as new. Nothing enforced that, so fail here when they disagree.
const confirmedSource = readFileSync(ROOT + "src/codexVersion.ts", "utf8");
const confirmedList = /CONFIRMED_CODEX_CLI_VERSIONS\s*=\s*\[([^\]]*)\]/.exec(confirmedSource)?.[1] ?? "";
const newestConfirmed = [...confirmedList.matchAll(/"([^"]+)"/g)].map((m) => m[1]).at(-1) ?? null;
let protocolBaselineVersion = null;
try {
  protocolBaselineVersion = readFileSync(resolve(REPO_ROOT, "docs/codex-protocol-baseline/VERSION"), "utf8").trim();
} catch {
  // missing baseline is reported below as a mismatch
}
if (!newestConfirmed || newestConfirmed !== protocolBaselineVersion) {
  console.error("Codex CLI version mismatch:");
  console.error(`  newest CONFIRMED_CODEX_CLI_VERSIONS entry (src/codexVersion.ts): ${newestConfirmed}`);
  console.error(`  protocol baseline (docs/codex-protocol-baseline/VERSION):       ${protocolBaselineVersion}`);
  console.error(
    "\nAfter verifying a codex update, add it to CONFIRMED_CODEX_CLI_VERSIONS and run\n" +
      "`node scripts/codex-protocol.mjs --codex <path> --save` in the same commit (AGENTS.md section 1).",
  );
  process.exit(1);
}

// Advisory release check: source edits do not always require a version bump,
// so this must not fail a build. It exists to make a human/agent explicitly
// review the changed runtime files instead of overlooking the version field.
function git(args) {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${REPO_ROOT.replaceAll("\\", "/")}`, ...args],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

const versionCommit = git([
  "log",
  "-G",
  '"version"[[:space:]]*:',
  "-n",
  "1",
  "--format=%H",
  "--",
  "app/package.json",
]);

if (versionCommit) {
  const baselinePackage = git(["show", `${versionCommit}:app/package.json`]);
  const baselineVersion = baselinePackage ? JSON.parse(baselinePackage).version : null;
  const changedTracked = git([
    "diff",
    "--name-only",
    versionCommit,
    "--",
    "app/src",
    "app/src-tauri/src",
  ]);
  const changedUntracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "app/src",
    "app/src-tauri/src",
  ]);
  const changedRuntimeFiles = [changedTracked, changedUntracked]
    .flatMap((output) => (output ? output.split(/\r?\n/) : []))
    .filter(Boolean)
    .filter((file, index, files) => files.indexOf(file) === index)
    .sort();

  if (baselineVersion === versions["package.json"] && changedRuntimeFiles.length > 0) {
    console.warn(
      `\nVERSION REVIEW WARNING: runtime source changed after the ${baselineVersion} version update, ` +
        "but the product version is unchanged.",
    );
    console.warn("Review the following files and decide whether this change requires a version bump:");
    for (const file of changedRuntimeFiles) console.warn(`  ${file}`);
    console.warn("This warning is advisory; the command will continue.\n");
  }
} else {
  console.warn(
    "VERSION REVIEW WARNING: Git history was unavailable, so source changes since the last version update could not be checked.",
  );
}
