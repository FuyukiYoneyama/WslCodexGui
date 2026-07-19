// Simulates "GUI window closed without clicking 切断": spawn wsl.exe/app-server
// exactly like appserver.rs does, get a connection established, then let the
// PARENT process itself exit abruptly (process.exit) WITHOUT calling
// stdin.end() or any graceful shutdown -- no different from what happens
// when app.exe's whole process is torn down by the OS on window close,
// since in both cases the kernel is the one closing the pipe handle.
import { spawn } from "node:child_process";

const DISTRO = "Ubuntu-24.04";
const CODEX_PATH = "/home/user/.nvm/versions/node/v22.22.2/bin/codex";

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
child.stderr.on("data", (c) => process.stderr.write(`[stderr] ${c}`));

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
function notify(method) {
  child.stdin.write(JSON.stringify({ method }) + "\n");
}

console.log("[parent] spawning and connecting, PID =", child.pid);
await request("initialize", {
  clientInfo: { name: "abrupt-exit-test", title: "t", version: "0.0.1" },
  capabilities: null,
});
notify("initialized");
console.log("[parent] initialize+initialized done. Now exiting abruptly WITHOUT closing stdin or waiting.");
console.log("[parent] child PID was", child.pid, "-- checking for orphans from a separate process next.");

// No child.stdin.end(), no child.kill(), no wait. Just die, like an
// abruptly-terminated GUI process would (OS reclaims handles either way).
process.exit(0);
