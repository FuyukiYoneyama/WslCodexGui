// Verifies that codex app-server can be pointed at Ollama purely via -c
// runtime overrides, with no edits to ~/.codex/config.toml at all.
import { spawn } from "node:child_process";

const DISTRO = "Ubuntu-24.04";
const CODEX_PATH = "/home/user/.nvm/versions/node/v22.22.2/bin/codex";

const child = spawn(
  "wsl.exe",
  [
    "-d", DISTRO, "--exec", CODEX_PATH, "app-server",
    "-c", "model_provider=ollama",
    "-c", "model=gpt-oss:20b",
    "-c", "model_context_window=32768",
  ],
  { stdio: ["pipe", "pipe", "pipe"] }
);

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
    let msg;
    try { msg = JSON.parse(line); } catch { console.log("[non-json]", line); continue; }
    if (msg.method && msg.id === undefined) {
      console.log("[notify]", msg.method, JSON.stringify(msg.params).slice(0, 300));
      continue;
    }
    if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    } else {
      console.log("[other]", line.slice(0, 300));
    }
  }
});
child.stderr.on("data", (c) => process.stderr.write(`[stderr] ${c}`));
child.on("exit", (code) => console.log("[exit]", code));

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60000);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ method, params }) + "\n");
}

try {
  const init = await request("initialize", {
    clientInfo: { name: "ollama-provider-test", title: "t", version: "0.0.1" },
    capabilities: null,
  });
  console.log("[init]", JSON.stringify(init).slice(0, 300));
  notify("initialized", {});

  const started = await request("thread/start", { cwd: "/home/user" });
  console.log("[thread/start]", JSON.stringify(started).slice(0, 300));
  const threadId = started.result?.thread?.id ?? started.result?.threadId;

  console.log("[turn/start] sending trivial prompt...");
  const turn = await request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with exactly the single word: PONG" }],
  });
  console.log("[turn/start result]", JSON.stringify(turn).slice(0, 500));

  // Give notifications a moment to flush (agentMessage delta / turn/completed,
  // including thread/tokenUsage/updated which carries modelContextWindow).
  await new Promise((r) => setTimeout(r, 15000));
} catch (e) {
  console.error("[FAILED]", e);
} finally {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 1000));
  child.kill();
  process.exit(0);
}
