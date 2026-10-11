// Codex app-server protocol drift check.
//
// `codex app-server generate-ts` emits the TypeScript types for the JSON-RPC
// protocol this app speaks. A codex-cli update can add/remove/rename fields
// without any version rule catching it, so AGENTS.md has us re-check after
// every update. Doing that against a throwaway /tmp copy meant the baseline
// vanished whenever WSL restarted, leaving only spot checks. This script keeps
// the baseline in the repo (docs/codex-protocol-baseline/) so the comparison
// is mechanical -- and, being plain files, `git log -p` shows how the
// protocol changed across codex versions.
//
//   node scripts/codex-protocol.mjs --codex <abs path of codex in WSL> [--distro <name>]
//       generate the current protocol, diff against the baseline (exit 0 = identical)
//   node scripts/codex-protocol.mjs --codex ... --save
//       overwrite the baseline with the current protocol (do this only after
//       confirming the diff does not affect the app)
//
// Run it from PowerShell, not Git Bash: MSYS rewrites a "/home/..." argument
// into a Windows path before node ever sees it.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = resolve(SCRIPT_DIR, "..", "..", "docs", "codex-protocol-baseline");
const VERSION_FILE = "VERSION";

// Files whose shape this app directly depends on (AGENTS.md section 1).
// A change in one of these is flagged and always printed in full.
const WATCHED = new Set([
  "ClientRequest.ts",
  "ServerNotification.ts",
  "ServerRequest.ts",
  "v2/ThreadStartParams.ts",
  "v2/ThreadResumeParams.ts",
  "v2/TurnStartParams.ts",
  "v2/SandboxMode.ts",
  "v2/SandboxWorkspaceWrite.ts",
  "v2/AskForApproval.ts",
  "v2/UserInput.ts",
]);

const MAX_DIFF_LINES_PER_FILE = 60;

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    distro: process.env.CODEX_DISTRO ?? "Ubuntu-24.04",
    codex: process.env.CODEX_PATH ?? null,
    save: false,
    full: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--distro") args.distro = argv[++i];
    else if (a === "--codex") args.codex = argv[++i];
    else if (a === "--save") args.save = true;
    else if (a === "--full") args.full = true;
    else fail(`不明な引数: ${a}（--codex <path> [--distro <name>] [--save] [--full]）`);
  }
  if (!args.codex) fail("--codex（またはCODEX_PATH）でWSL内のcodex絶対パスを指定してください");
  // A Windows-looking path means MSYS/Git Bash already mangled it.
  if (!args.codex.startsWith("/") || /^[A-Za-z]:[\\/]/.test(args.codex)) {
    fail(`codexパスがWSLの絶対パスではありません: ${args.codex}（Git Bashではなくpowershellから実行してください）`);
  }
  return args;
}

function wsl(distro, execArgs) {
  const r = spawnSync("wsl.exe", ["-d", distro, "--exec", ...execArgs], { encoding: "utf8" });
  if (r.error) fail(`wsl.exeを起動できません: ${r.error.message}`);
  if (r.status !== 0) {
    // wsl.exe's own error messages are UTF-16; drop the NULs so they read.
    const msg = `${r.stderr ?? ""}${r.stdout ?? ""}`.replaceAll("\0", "").trim();
    fail(`wsl ${execArgs.join(" ")} が失敗しました(exit ${r.status}): ${msg}`);
  }
  return r.stdout;
}

// Reads every file under `dir` into Map<posix relative path, LF-normalized text>.
function readTree(dir, skipTopLevel = new Set()) {
  const out = new Map();
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else if (!(prefix === "" && skipTopLevel.has(entry.name))) {
        out.set(rel, readFileSync(join(current, entry.name), "utf8").replace(/\r\n/g, "\n"));
      }
    }
  };
  walk(dir, "");
  return out;
}

function generateCurrent({ distro, codex }) {
  const version = /(\d+\.\d+\.\d+)/.exec(wsl(distro, [codex, "--version"]))?.[1];
  if (!version) fail("codex --version の出力からバージョンを読み取れません");

  const linuxDir = `/tmp/codex-protocol-check-${process.pid}`;
  wsl(distro, [codex, "app-server", "generate-ts", "--out", linuxDir, "--experimental"]);
  const uncDir = `\\\\wsl.localhost\\${distro}${linuxDir.replaceAll("/", "\\")}`;
  try {
    return { version, files: readTree(uncDir) };
  } finally {
    spawnSync("wsl.exe", ["-d", distro, "--exec", "rm", "-rf", linuxDir]);
  }
}

function saveBaseline({ version, files }) {
  rmSync(BASELINE_DIR, { recursive: true, force: true });
  for (const [rel, text] of files) {
    const target = join(BASELINE_DIR, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  writeFileSync(join(BASELINE_DIR, VERSION_FILE), `${version}\n`);
  console.log(`基準を更新しました: codex-cli ${version}（${files.size}ファイル） → ${BASELINE_DIR}`);
}

function unifiedDiff(rel, oldText, newText) {
  const work = mkdtempSync(join(tmpdir(), "codex-protocol-diff-"));
  try {
    for (const [side, text] of [["a", oldText], ["b", newText]]) {
      const target = join(work, side, ...rel.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    const r = spawnSync("git", ["diff", "--no-index", "--no-color", "-U2", `a/${rel}`, `b/${rel}`], {
      cwd: work,
      encoding: "utf8",
    });
    const lines = (r.stdout ?? "").split("\n");
    const shown = lines.slice(0, MAX_DIFF_LINES_PER_FILE).join("\n");
    return lines.length > MAX_DIFF_LINES_PER_FILE
      ? `${shown}\n... (${lines.length - MAX_DIFF_LINES_PER_FILE}行省略。--full で全文)`
      : shown;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function compare(current, baselineFiles, baselineVersion, full) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [rel, text] of current.files) {
    if (!baselineFiles.has(rel)) added.push(rel);
    else if (baselineFiles.get(rel) !== text) changed.push(rel);
  }
  for (const rel of baselineFiles.keys()) if (!current.files.has(rel)) removed.push(rel);

  console.log(`現在: codex-cli ${current.version}（${current.files.size}ファイル） / 基準: ${baselineVersion}（${baselineFiles.size}ファイル）`);
  if (added.length + removed.length + changed.length === 0) {
    console.log("プロトコル差分なし。");
    return 0;
  }

  const mark = (rel) => (WATCHED.has(rel) ? " ★監視対象" : "");
  console.log(`差分あり: 追加${added.length} / 削除${removed.length} / 変更${changed.length}  （★=このアプリが直接依存する型）`);
  for (const [label, list] of [["追加", added], ["削除", removed], ["変更", changed]]) {
    for (const rel of list.sort()) console.log(`  ${label}: ${rel}${mark(rel)}`);
  }

  const toShow = changed.filter((rel) => full || WATCHED.has(rel)).sort();
  if (toShow.length > 0) console.log("\n--- 差分（監視対象のみ。全件は --full）---");
  for (const rel of toShow) console.log(`\n${unifiedDiff(rel, baselineFiles.get(rel), current.files.get(rel))}`);
  return 1;
}

const args = parseArgs(process.argv.slice(2));
const current = generateCurrent(args);

if (args.save) {
  saveBaseline(current);
  process.exit(0);
}

if (!existsSync(join(BASELINE_DIR, VERSION_FILE))) {
  fail(`基準がありません（${BASELINE_DIR}）。内容を確認したうえで --save で作成してください`);
}
const baselineVersion = readFileSync(join(BASELINE_DIR, VERSION_FILE), "utf8").trim();
process.exit(compare(current, readTree(BASELINE_DIR, new Set([VERSION_FILE])), baselineVersion, args.full));
