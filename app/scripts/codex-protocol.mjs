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
//   node scripts/codex-protocol.mjs --codex ... --baseline <dir>
//       diff against another snapshot instead (e.g. an older baseline pulled out
//       of git history with `git archive <commit> docs/codex-protocol-baseline`)
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

// Files whose shape this app directly depends on (AGENTS.md section 1). A
// change in one of these is flagged and its diff always printed.
//
// Keep this in step with the code: every RPC App.tsx sends (`method: "..."`),
// every notification/server request it handles (`case "..."`), and every
// response schemas.ts validates must map to an entry below. The first
// version of this list only covered the request side, so when 0.163.0
// changed the thread/list and thread/read responses nothing was flagged.
const WATCHED = new Set([
  // Method/notification unions (reported as method-name diffs, see below)
  "ClientRequest.ts",
  "ServerNotification.ts",
  "ServerRequest.ts",
  // Sandbox / approval settings sent on thread/start and thread/resume
  "v2/SandboxMode.ts",
  "v2/SandboxWorkspaceWrite.ts",
  "v2/AskForApproval.ts",
  // RPC parameters (App.tsx `method: "..."`)
  "InitializeParams.ts",
  "v2/ThreadStartParams.ts",
  "v2/ThreadResumeParams.ts",
  "v2/ThreadListParams.ts",
  "v2/ThreadReadParams.ts",
  "v2/ThreadArchiveParams.ts",
  "v2/ThreadUnarchiveParams.ts",
  "v2/ThreadSetNameParams.ts",
  "v2/ThreadGoalSetParams.ts",
  "v2/ThreadCompactStartParams.ts",
  "v2/TurnStartParams.ts",
  "v2/TurnInterruptParams.ts",
  "v2/UserInput.ts",
  "v2/ModelListParams.ts",
  "v2/ConfigReadParams.ts",
  "GitDiffToRemoteParams.ts",
  // RPC responses (schemas.ts)
  "InitializeResponse.ts",
  "v2/ThreadStartResponse.ts",
  "v2/ThreadResumeResponse.ts",
  "v2/ThreadListResponse.ts",
  "v2/ThreadReadResponse.ts",
  "v2/Thread.ts",
  "v2/ThreadStatus.ts",
  "v2/Turn.ts",
  "v2/ThreadItem.ts",
  "v2/ModelListResponse.ts",
  "v2/Model.ts",
  "v2/GetAccountRateLimitsResponse.ts",
  "v2/RateLimitSnapshot.ts",
  "v2/RateLimitWindow.ts",
  "v2/ConfigReadResponse.ts",
  "GitDiffToRemoteResponse.ts",
  // Notifications handled in App.tsx
  "v2/TurnStartedNotification.ts",
  "v2/TurnCompletedNotification.ts",
  "v2/ItemStartedNotification.ts",
  "v2/ItemCompletedNotification.ts",
  "v2/AgentMessageDeltaNotification.ts",
  "v2/CommandExecutionOutputDeltaNotification.ts",
  "v2/ReasoningSummaryTextDeltaNotification.ts",
  "v2/ReasoningSummaryPartAddedNotification.ts",
  "v2/ThreadTokenUsageUpdatedNotification.ts",
  "v2/ThreadTokenUsage.ts",
  "v2/TokenUsageBreakdown.ts",
  "v2/ErrorNotification.ts",
  // Approval requests (approvalMethods.ts) and the decisions sent back
  "v2/CommandExecutionRequestApprovalParams.ts",
  "v2/CommandExecutionRequestApprovalResponse.ts",
  "v2/CommandExecutionApprovalDecision.ts",
  "v2/FileChangeRequestApprovalParams.ts",
  "v2/FileChangeRequestApprovalResponse.ts",
  "v2/FileChangeApprovalDecision.ts",
  "ExecCommandApprovalParams.ts",
  "ApplyPatchApprovalParams.ts",
  "ReviewDecision.ts",
]);

const MAX_DIFF_LINES_PER_FILE = 60;
// The method unions are a single line of several KB; cap each printed line.
const MAX_DIFF_LINE_CHARS = 300;

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    distro: process.env.CODEX_DISTRO ?? "Ubuntu-24.04",
    codex: process.env.CODEX_PATH ?? null,
    baseline: BASELINE_DIR,
    save: false,
    full: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--distro") args.distro = argv[++i];
    else if (a === "--codex") args.codex = argv[++i];
    else if (a === "--baseline") args.baseline = resolve(argv[++i]);
    else if (a === "--save") args.save = true;
    else if (a === "--full") args.full = true;
    else fail(`不明な引数: ${a}（--codex <path> [--distro <name>] [--baseline <dir>] [--save] [--full]）`);
  }
  if (args.save && args.baseline !== BASELINE_DIR) fail("--save と --baseline は同時に指定できません（--save は常にリポジトリ内の基準を更新します）");
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
    const lines = (r.stdout ?? "")
      .split("\n")
      .map((line) =>
        line.length > MAX_DIFF_LINE_CHARS
          ? `${line.slice(0, MAX_DIFF_LINE_CHARS)}…（${line.length - MAX_DIFF_LINE_CHARS}文字省略）`
          : line,
      );
    const shown = lines.slice(0, MAX_DIFF_LINES_PER_FILE).join("\n");
    return lines.length > MAX_DIFF_LINES_PER_FILE
      ? `${shown}\n... (${lines.length - MAX_DIFF_LINES_PER_FILE}行省略。--full で全文)`
      : shown;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// For the method unions (ClientRequest.ts etc.), the textual diff is one
// multi-KB line; the meaningful change is which methods were added/removed.
function methodNames(text) {
  return new Set([...text.matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]));
}

function methodDiff(oldText, newText) {
  const before = methodNames(oldText);
  const after = methodNames(newText);
  const added = [...after].filter((m) => !before.has(m)).sort();
  const removed = [...before].filter((m) => !after.has(m)).sort();
  if (before.size === 0 && after.size === 0) return null;
  const lines = [`  メソッド: ${before.size}件 → ${after.size}件`];
  for (const m of added) lines.push(`    + ${m}`);
  for (const m of removed) lines.push(`    - ${m}（削除）`);
  if (added.length + removed.length === 0) lines.push("    （メソッド名の増減なし。引数の型など中身の変更のみ）");
  return lines.join("\n");
}

function compare(current, baselineFiles, baselineVersion, full) {
  // A watched name that exists on neither side is a stale entry (renamed
  // upstream long ago, or a typo) -- it would silently never be flagged.
  const stale = [...WATCHED].filter((rel) => !current.files.has(rel) && !baselineFiles.has(rel));
  if (stale.length > 0) {
    console.warn(`警告: 監視対象のうち基準にも現在の出力にも無いファイルがあります（改名・打ち間違いの可能性。WATCHEDを見直してください）:`);
    for (const rel of stale) console.warn(`  ${rel}`);
  }

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
  for (const rel of toShow) {
    const oldText = baselineFiles.get(rel);
    const newText = current.files.get(rel);
    console.log(`\n=== ${rel}${mark(rel)} ===`);
    const methods = methodDiff(oldText, newText);
    if (methods) console.log(methods);
    console.log(unifiedDiff(rel, oldText, newText));
  }
  return 1;
}

const args = parseArgs(process.argv.slice(2));
const current = generateCurrent(args);

if (args.save) {
  saveBaseline(current);
  process.exit(0);
}

if (!existsSync(join(args.baseline, VERSION_FILE))) {
  fail(`基準がありません（${args.baseline}）。内容を確認したうえで --save で作成してください`);
}
const baselineVersion = readFileSync(join(args.baseline, VERSION_FILE), "utf8").trim();
process.exit(compare(current, readTree(args.baseline, new Set([VERSION_FILE])), baselineVersion, args.full));
