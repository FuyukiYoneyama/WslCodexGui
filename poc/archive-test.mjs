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
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ method, params }) + "\n");
}

try {
  await request("initialize", { clientInfo: { name: "archive-test", title: "t", version: "0.0.1" }, capabilities: null });
  notify("initialized", {});

  const started = await request("thread/start", { cwd: "/home/user" });
  const threadId = started.result.thread.id;
  console.log("[created test thread]", threadId);

  // A thread only gets a rollout file on disk once it has at least one turn.
  await request("turn/start", { threadId, input: [{ type: "text", text: "Reply with exactly: OK" }] });
  await new Promise((r) => setTimeout(r, 6000));
  console.log("[ran a trivial turn to create the rollout file]");

  const before = await request("thread/list", { limit: 5 });
  console.log("[thread/list before archive] count:", before.result.data?.length ?? before.result.threads?.length);
  console.log("[contains test thread before]", JSON.stringify(before.result).includes(threadId));

  const archiveRes = await request("thread/archive", { threadId });
  console.log("[thread/archive result]", JSON.stringify(archiveRes));

  const after = await request("thread/list", { limit: 5 });
  console.log("[contains test thread after archive (should be false)]", JSON.stringify(after.result).includes(threadId));

  const archivedList = await request("thread/list", { limit: 5, archived: true });
  console.log("[contains test thread in archived=true list (should be true)]", JSON.stringify(archivedList.result).includes(threadId));

  // cleanup: delete the test thread entirely so it doesn't linger
  const delRes = await request("thread/delete", { threadId });
  console.log("[thread/delete result]", JSON.stringify(delRes));
} catch (e) {
  console.error("[FAILED]", e);
} finally {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 500));
  child.kill();
  process.exit(0);
}
