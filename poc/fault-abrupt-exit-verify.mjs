// Re-verification of the abrupt-exit-test.mjs scenario on this machine's
// actual distro/codex path, with an automated orphan-process check added
// (the original script only printed the PID and left verification manual).
// Spawns app-server, completes the initialize handshake, then the PARENT
// itself dies without closing stdin or waiting -- same as app.exe's whole
// process tree being torn down by the OS on window close.
import { spawn, execFileSync } from "node:child_process";

const DISTRO = "Ubuntu-20.04";
const CODEX_PATH = "/home/user/.local/bin/codex";

function psCodex() {
  try {
    return execFileSync("wsl.exe", ["-d", DISTRO, "--", "bash", "-lc", "ps aux | grep -i codex | grep -v grep"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

if (psCodex()) {
  console.error("[ABORT] codex process already running before test");
  process.exit(1);
}

const child = spawn("wsl.exe", ["-d", DISTRO, "--exec", CODEX_PATH, "app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  detached: false,
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

console.log("[parent] spawning, wsl.exe PID =", child.pid);
await request("initialize", { clientInfo: { name: "fault-test", title: "t", version: "0.0.1" }, capabilities: null });
notify("initialized", {});
console.log("[parent] handshake done. Spawning a *separate* checker process to verify orphans after this process dies without cleanup...");

// This process is about to process.exit(0) without touching child at all
// (no kill, no stdin.end, no wait) -- so the check has to run from a
// completely separate process, after this one is already gone.
const checker = spawn(
  process.execPath,
  [
    "-e",
    `
    const { execFileSync } = require("node:child_process");
    setTimeout(() => {
      try {
        const out = execFileSync("wsl.exe", ["-d", "${DISTRO}", "--", "bash", "-lc", "ps aux | grep -i codex | grep -v grep"], { encoding: "utf8" }).trim();
        console.log("[checker] codex processes remaining 3s after parent exit:");
        console.log(out || "(none)");
      } catch {
        console.log("[checker] codex processes remaining 3s after parent exit:\\n(none)");
      }
    }, 3000);
    `,
  ],
  { detached: true, stdio: "inherit" }
);
checker.unref();

process.exit(0);
