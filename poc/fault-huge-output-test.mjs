// 残項目.md P0-4 "巨大command output" / "stderr大量出力": appserver.rs's stdout
// reader comment claims draining continuously is load-bearing (N-19) because
// an unread pipe eventually blocks the child. This runs a turn whose shell
// command prints several MB to stdout (well past any OS pipe buffer, which
// is typically 64KB), with a bounded overall timeout, to confirm the reader
// loop actually keeps up instead of deadlocking.
import { spawn } from "node:child_process";

const DISTRO = "Ubuntu-20.04";
const CODEX_PATH = "/home/user/.local/bin/codex";
const OVERALL_TIMEOUT_MS = 60_000;

const child = spawn("wsl.exe", ["-d", DISTRO, "--exec", CODEX_PATH, "app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
let totalStdoutBytes = 0;
let totalStderrBytes = 0;
const pending = new Map();
const notifications = [];
let nextId = 1;
child.stdout.on("data", (c) => {
  totalStdoutBytes += c.length;
  buf += c.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    } else {
      notifications.push(msg);
    }
  }
});
child.stderr.on("data", (c) => {
  totalStderrBytes += c.length;
});
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), OVERALL_TIMEOUT_MS);
    pending.set(id, (msg) => {
      clearTimeout(t);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ method, params }) + "\n");
}

const overallTimer = setTimeout(() => {
  console.error("[FAIL] overall timeout -- reader loop likely stalled (pipe backpressure deadlock)");
  child.kill("SIGKILL");
  process.exit(1);
}, OVERALL_TIMEOUT_MS);

try {
  await request("initialize", { clientInfo: { name: "fault-test", title: "t", version: "0.0.1" }, capabilities: null });
  notify("initialized", {});
  const started = await request("thread/start", { cwd: "/home/user" });
  const threadId = started.result.thread.id;
  console.log("[thread]", threadId, "-- asking for a command producing ~5MB of stdout, unsandboxed so it can actually run");

  await request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: "Run exactly this shell command via the shell tool and do not summarize its output, just run it: yes hello-wslcodexgui-fault-test | head -c 5000000 ; echo DONE_MARKER 1>&2",
      },
    ],
  });

  // Poll notifications for turn/completed instead of a fixed sleep.
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  let completed = false;
  while (Date.now() < deadline) {
    if (notifications.some((n) => n.method === "turn/completed")) {
      completed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  clearTimeout(overallTimer);
  console.log("[result] turn completed:", completed);
  console.log("[result] total stdout bytes read from app-server:", totalStdoutBytes);
  console.log("[result] total stderr bytes read from app-server:", totalStderrBytes);
  console.log(
    completed
      ? "[PASS] reader loop kept draining through a multi-MB command output without stalling"
      : "[FAIL] turn never completed within timeout"
  );
  process.exit(completed ? 0 : 1);
} catch (e) {
  clearTimeout(overallTimer);
  console.error("[FAIL]", e);
  process.exit(1);
} finally {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 300));
  child.kill();
}
