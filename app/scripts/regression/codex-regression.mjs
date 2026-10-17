// Live regression checks against the real codex app-server, run after a
// codex-cli update (AGENTS.md section 1) and after changing anything that
// touches thread/turn parameters or the zod schemas.
//
// These used to be ad-hoc scripts under poc/ (which is git-ignored), so they
// existed on one machine only and every run re-wrote them by hand. They live
// here instead and import the app's own modules -- schemas.ts for response
// validation and sandboxConfig.ts for the sandbox/.git settings -- so they
// test exactly what the app sends and accepts, not a copy that can drift.
//
//   node scripts/regression/codex-regression.mjs --codex <abs path of codex in WSL> [--distro <name>] [--skip-turn]
//
// --skip-turn skips the .git commit check, the only one that makes a model
// call. Exit 0 = all checks passed, 1 = a check failed, 2 = could not run.
// Run from PowerShell, not Git Bash (MSYS rewrites "/home/..." arguments).

import { spawn, spawnSync } from "node:child_process";
import {
  InitializeResponseSchema,
  ModelListResponseSchema,
  ThreadListResponseSchema,
  ThreadReadResponseSchema,
  ThreadStartResponseSchema,
} from "../../src/schemas.ts";
import { PROJECT_SANDBOX, gitWritableRootsConfig } from "../../src/sandboxConfig.ts";

const REQUEST_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 180_000;

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    distro: process.env.CODEX_DISTRO ?? "Ubuntu-24.04",
    codex: process.env.CODEX_PATH ?? null,
    skipTurn: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--distro") args.distro = argv[++i];
    else if (a === "--codex") args.codex = argv[++i];
    else if (a === "--skip-turn") args.skipTurn = true;
    else fail(`不明な引数: ${a}（--codex <path> [--distro <name>] [--skip-turn]）`);
  }
  if (!args.codex) fail("--codex（またはCODEX_PATH）でWSL内のcodex絶対パスを指定してください");
  if (!args.codex.startsWith("/") || /^[A-Za-z]:[\\/]/.test(args.codex)) {
    fail(`codexパスがWSLの絶対パスではありません: ${args.codex}（Git Bashではなくpowershellから実行してください）`);
  }
  return args;
}

function wslRun(distro, execArgs) {
  const r = spawnSync("wsl.exe", ["-d", distro, "--exec", ...execArgs], { encoding: "utf8" });
  if (r.error) fail(`wsl.exeを起動できません: ${r.error.message}`);
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.replaceAll("\0", "").trim() };
}

// Minimal JSONL JSON-RPC client over `wsl.exe --exec <codex> app-server`,
// the same transport the app's Rust side uses.
class AppServer {
  constructor(distro, codex) {
    this.child = spawn("wsl.exe", ["-d", distro, "--exec", codex, "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", () => {}); // diagnostics only; drained so the pipe never blocks
  }
  onData(chunk) {
    this.buf += chunk.toString("utf8");
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      } else if (msg.id !== undefined && msg.method) {
        // Server request (e.g. an approval) -- decline; no check here expects one.
        this.child.stdin.write(`${JSON.stringify({ id: msg.id, result: { decision: "decline" } })}\n`);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    }
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if ("error" in msg) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      this.child.stdin.write(`${JSON.stringify(params === undefined ? { id, method } : { id, method, params })}\n`);
    });
  }
  notify(method) {
    this.child.stdin.write(`${JSON.stringify({ method })}\n`);
  }
  waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), timeoutMs);
      this.listeners.push((msg) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
  }
  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok === null ? "SKIP" : ok ? "OK  " : "NG  "} ${name}${detail ? ` — ${detail}` : ""}`);
}

function checkSchema(name, schema, value) {
  const parsed = schema.safeParse(value);
  record(name, parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 400));
  return parsed.success;
}

const args = parseArgs(process.argv.slice(2));
const scratch = `/tmp/wslcodexgui-regression-${process.pid}`;
const version = wslRun(args.distro, [args.codex, "--version"]).out;
console.log(`対象: ${version}（distro: ${args.distro}）\n`);

// Scratch git repo with one commit; also serves as the thread cwd.
const setup = wslRun(args.distro, [
  "sh",
  "-c",
  `set -e; mkdir -p ${scratch}; cd ${scratch}; git init -q; git config user.email regression@example.invalid; ` +
    `git config user.name regression; echo hello > file.txt; git add file.txt; git commit -q -m init`,
]);
if (setup.status !== 0) fail(`作業用リポジトリを作れません: ${setup.out}`);

const server = new AppServer(args.distro, args.codex);
let turnThreadId = null;
try {
  checkSchema(
    "initialize の応答がInitializeResponseSchemaを通る",
    InitializeResponseSchema,
    await server.request("initialize", {
      clientInfo: { name: "wslcodexgui-regression", title: "regression", version: "0.0.0" },
      capabilities: null,
    }),
  );
  server.notify("initialized");

  // Same parameter shape as App.tsx newThread(): approvalPolicy "untrusted"
  // is the strictest value the app offers, and it disappeared from
  // `codex --help` in 0.156.0 while staying valid in the protocol.
  const started = await server.request("thread/start", {
    cwd: scratch,
    approvalPolicy: "untrusted",
    sandbox: PROJECT_SANDBOX,
    config: gitWritableRootsConfig(scratch),
  });
  checkSchema("thread/start（approvalPolicy: untrusted・sandbox・config付き）が受理されスキーマを通る", ThreadStartResponseSchema, started);

  const list = await server.request("thread/list", { limit: 30, archived: false });
  checkSchema("thread/list の応答がThreadListResponseSchemaを通る", ThreadListResponseSchema, list);
  checkSchema(
    "thread/list（archived: true）の応答がThreadListResponseSchemaを通る",
    ThreadListResponseSchema,
    await server.request("thread/list", { limit: 3, archived: true }),
  );

  const firstThreadId = list?.data?.[0]?.id;
  if (firstThreadId) {
    checkSchema(
      "thread/read の応答がThreadReadResponseSchemaを通る",
      ThreadReadResponseSchema,
      await server.request("thread/read", { threadId: firstThreadId }),
    );
  } else {
    record("thread/read の応答がThreadReadResponseSchemaを通る", null, "スレッドが1件もないため省略");
  }

  checkSchema("model/list の応答がModelListResponseSchemaを通る", ModelListResponseSchema, await server.request("model/list", {}));

  if (args.skipTurn) {
    record(".git書き込み（workspace-write下でgit commit）", null, "--skip-turn 指定のため省略");
  } else {
    // A thread only gets persisted once it has a turn; this one is deleted
    // again below so it never lingers in the user's thread list.
    const thread = await server.request("thread/start", {
      cwd: scratch,
      approvalPolicy: "on-request",
      sandbox: PROJECT_SANDBOX,
      config: gitWritableRootsConfig(scratch),
    });
    turnThreadId = thread.thread.id;
    const completed = server.waitFor(
      (m) => m.method === "turn/completed" && m.params?.threadId === turnThreadId,
      TURN_TIMEOUT_MS,
      "turn/completed",
    );
    await server.request("turn/start", {
      threadId: turnThreadId,
      input: [
        {
          type: "text",
          text: 'Run exactly this command and nothing else: echo "line2" >> file.txt && git add file.txt && git commit -m "second"',
          text_elements: [],
        },
      ],
    });
    await completed;
    const count = wslRun(args.distro, ["git", "-C", scratch, "rev-list", "--count", "HEAD"]).out;
    record(
      ".git書き込み（workspace-write下でgit commit）",
      count === "2",
      count === "2" ? "" : `コミット数が${count}（2を期待）。.gitが読み取り専用に戻った可能性`,
    );
  }
} catch (e) {
  record("app-serverとのやり取り", false, e.message);
} finally {
  if (turnThreadId) {
    await server.request("thread/delete", { threadId: turnThreadId }).catch((e) => {
      console.warn(`警告: テスト用スレッド${turnThreadId}を削除できませんでした（${e.message}）。スレッド一覧から手動でアーカイブしてください`);
    });
  }
  server.close();
  wslRun(args.distro, ["rm", "-rf", scratch]);
}

const failed = results.filter((r) => r.ok === false).length;
const passed = results.filter((r) => r.ok === true).length;
console.log(`\n結果: 成功${passed} / 失敗${failed} / 省略${results.length - passed - failed}`);
process.exit(failed > 0 ? 1 : 0);
