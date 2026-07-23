// 残項目.md P0-4 "turn/start直後にapp-serverをkill": mirrors what an abruptly
// terminated GUI process does mid-turn -- send turn/start, then kill the
// child (not wait for any response) and the parent both, exactly as the OS
// would when app.exe's whole process tree is torn down. Verifies no orphan
// wsl.exe/codex process is left running inside the distro afterward.
import { spawn, execFileSync } from "node:child_process";

const DISTRO = "Ubuntu-20.04";
const CODEX_PATH = "/home/user/.local/bin/codex";

function psCodex() {
  try {
    return execFileSync("wsl.exe", ["-d", DISTRO, "--", "bash", "-lc", "ps aux | grep -i codex | grep -v grep"], {
      encoding: "utf8",
    }).trim();
  } catch (e) {
    // grep exits 1 when no match -- that's the "clean" case, not an error.
    return "";
  }
}

const before = psCodex();
if (before) {
  console.error("[ABORT] codex process already running before test:\n" + before);
  process.exit(1);
}

const child = spawn("wsl.exe", ["-d", DISTRO, "--exec", CODEX_PATH, "app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (c) => {
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
    }
  }
});
child.stderr.on("data", () => {});
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ method, params }) + "\n");
}

console.log("[parent] connecting, wsl.exe PID =", child.pid);
await request("initialize", { clientInfo: { name: "fault-test", title: "t", version: "0.0.1" }, capabilities: null });
notify("initialized", {});
const started = await request("thread/start", { cwd: "/home/user" });
const threadId = started.result.thread.id;
console.log("[parent] thread started:", threadId, "-- firing turn/start and killing immediately, no await");

// Fire-and-forget: never await the response, never close stdin gracefully.
notify("turn/start", { threadId, input: [{ type: "text", text: "sleep and reply OK" }] });
// Kill both ends without any graceful shutdown -- the pipes just vanish, same
// as when Windows reclaims a torn-down process tree.
child.kill("SIGKILL");

await new Promise((r) => setTimeout(r, 3000));
const after = psCodex();
console.log("[result] codex processes remaining after kill:");
console.log(after || "(none)");
process.exit(after ? 1 : 0);
