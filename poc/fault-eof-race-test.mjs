// 残項目.md P0-4 "stdout EOFと新規接続が競合": kill an old connection's child
// and, without waiting for its stdout-EOF teardown to finish, immediately
// spawn a brand new connection to the same distro. Verifies the new
// connection's handshake succeeds cleanly and isn't corrupted by the old
// one's teardown racing in the background (each is a separate wsl.exe
// process/pipe set, so there is no shared state to race on -- but this
// confirms that empirically rather than by architecture reasoning alone).
import { spawn, execFileSync } from "node:child_process";

const DISTRO = "Ubuntu-20.04";
const CODEX_PATH = "/home/user/.local/bin/codex";

function makeClient() {
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
  return {
    child,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000);
        pending.set(id, (msg) => {
          clearTimeout(t);
          resolve(msg);
        });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ method, params }) + "\n");
    },
  };
}

const a = makeClient();
console.log("[a] connecting, PID =", a.child.pid);
await a.request("initialize", { clientInfo: { name: "fault-test-a", title: "t", version: "0.0.1" }, capabilities: null });
a.notify("initialized", {});
console.log("[a] handshake done. Killing it now (stdout EOF teardown begins)...");
a.child.kill("SIGKILL");

// Immediately -- no delay -- start a second, independent connection while
// (a)'s teardown is still in flight on the OS/pipe level.
const b = makeClient();
console.log("[b] connecting immediately while (a) is tearing down, PID =", b.child.pid);
const initB = await b.request("initialize", {
  clientInfo: { name: "fault-test-b", title: "t", version: "0.0.1" },
  capabilities: null,
});
b.notify("initialized", {});
const ok = !!initB.result;
console.log("[b] initialize result present:", ok);

const started = await b.request("thread/start", { cwd: "/home/user" });
console.log("[b] thread/start ok:", !!started.result?.thread?.id);

b.child.stdin.end();
await new Promise((r) => setTimeout(r, 500));
b.child.kill();

await new Promise((r) => setTimeout(r, 1500));
let remaining = "";
try {
  remaining = execFileSync("wsl.exe", ["-d", DISTRO, "--", "bash", "-lc", "ps aux | grep -i codex | grep -v grep"], {
    encoding: "utf8",
  }).trim();
} catch {}
console.log("[result] codex processes remaining:", remaining || "(none)");

const pass = ok && !!started.result?.thread?.id && !remaining;
console.log(pass ? "[PASS] new connection unaffected by concurrent old-connection teardown" : "[FAIL]");
process.exit(pass ? 0 : 1);
