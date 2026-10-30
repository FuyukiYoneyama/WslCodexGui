// Render the real App with Tauri's IPC mock, without a Codex/model request.
// Uses an isolated headless Edge/Chrome profile; never opens the installed app.
// Run from app: node scripts/regression/turn-error-ui.mjs [--browser <exe>]
// Screenshots and the isolated browser profile go under ignored poc/.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const app = fileURLToPath(new URL("../../", import.meta.url));
const version = JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version;
const browserArg = process.argv.indexOf("--browser");
const browserExe = browserArg >= 0 ? process.argv[browserArg + 1] : [
  join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft/Edge/Application/msedge.exe"),
  join(process.env.ProgramFiles ?? "", "Google/Chrome/Application/chrome.exe"),
].find((path) => existsSync(path));
if (!browserExe || !existsSync(browserExe)) throw new Error("Specify Edge/Chrome with --browser <exe>");
const output = resolve(app, `../poc/turn-error-ui-${version}`);
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(output, "profile-"));

const bootstrap = `
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
const thread = { id: 'ui-thread', preview: '表示確認用スレッド', name: null,
  cwd: '/ui-test', status: { type: 'idle' }, updatedAt: 1, turns: [] };
mockWindows('main');
mockIPC((cmd, args) => {
  if (cmd === 'list_wsl_distros') return [{ name: 'UI-test', is_default: true }];
  if (cmd === 'detect_codex_path') return '/mock/codex';
  if (cmd === 'verify_codex_path' || cmd === 'is_window_focused') return true;
  if (cmd === 'plugin:app|version') return ${JSON.stringify(version)};
  if (cmd === 'connect') return { userAgent: 'ui-test/0.165.0', codexHome: '/mock/.codex',
    platformFamily: 'unix', platformOs: 'linux', connectionId: 'ui-connection' };
  if (cmd === 'rpc_request') {
    if (args.method === 'thread/list') return { data: [thread], nextCursor: null };
    if (args.method === 'thread/resume') return { thread };
    if (args.method === 'model/list') return { data: [] };
  }
  return null;
}, { shouldMockEvents: true });
window.uiNotify = (method, params) => emit('codex:notification', {
  connectionId: 'ui-connection', method, params });
await import('/src/main.tsx');
`;
const server = await createServer({
  root: app,
  configFile: join(app, "vite.config.ts"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "turn-error-ui-mock",
    transformIndexHtml: (html) => html.replace('src="/src/main.tsx"', 'src="/@id/virtual:turn-error-ui"'),
    resolveId: (id) => id === "virtual:turn-error-ui" ? "\0turn-error-ui" : null,
    load: (id) => id === "\0turn-error-ui" ? bootstrap : null,
  }],
});
let browser;
let socket;
let id = 0;
const pending = new Map();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(check, label) {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function cdp(method, params = {}) {
  return new Promise((done, fail) => {
    const callId = ++id;
    const timeout = setTimeout(() => { pending.delete(callId); fail(new Error(`CDP timeout: ${method}`)); }, 10_000);
    pending.set(callId, { done, fail, timeout });
    socket.send(JSON.stringify({ id: callId, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const overloaded = {
  additionalDetails: "request ID capacity-ui-123",
  codexErrorInfo: "serverOverloaded",
  message: "Selected model is at capacity. Please try a different model.",
  misalignment: null,
};
const notify = (method, params) => evaluate(`window.uiNotify(${JSON.stringify(method)}, ${JSON.stringify(params)})`);
async function screenshot(name) {
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(output, name), Buffer.from(data, "base64"));
}
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = spawn(browserExe, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  browser.on("error", (error) => console.error(error));
  const portFile = join(profile, "DevToolsActivePort");
  await waitFor(() => existsSync(portFile), "browser debugging endpoint");
  const debugPort = readFileSync(portFile, "utf8").split(/\r?\n/)[0];
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  socket.onmessage = (event) => {
    const result = JSON.parse(event.data);
    const call = pending.get(result.id);
    if (!call) return;
    clearTimeout(call.timeout);
    pending.delete(result.id);
    if (result.error) call.fail(new Error(JSON.stringify(result.error)));
    else call.done(result.result);
  };
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await cdp("Page.navigate", { url: `http://127.0.0.1:${port}` });
  await waitFor(() => evaluate(`!![...document.querySelectorAll('button')].find(b => b.textContent === '接続' && !b.disabled)`), "connect button");
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === '接続').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('.thread-row button')`), "thread list");
  await evaluate(`document.querySelector('.thread-row button').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('.thread-row button.active')`), "resumed thread");
  await notify("error", { threadId: "ui-thread", turnId: "ui-turn", error: overloaded, willRetry: false });
  await waitFor(() => evaluate(`!!document.querySelector('.turn-error-banner')`), "capacity explanation");
  // The completion must not overwrite the explanation with the original JSON.
  await notify("turn/completed", { threadId: "ui-thread", turn: { id: "ui-turn", status: "failed", error: overloaded } });
  await waitFor(() => evaluate(`!document.querySelector('.retry-notice')`), "completed turn");
  const visible = await evaluate(`document.querySelector('.turn-error-banner').innerText`);
  assert.match(visible, /モデルが混雑/);
  assert.match(visible, /対処法/);
  assert.match(visible, /時間を置いて/);
  assert.match(visible, /別のモデル/);
  assert.equal(visible.includes("Selected model"), false);
  assert.equal(visible.includes("Turn failed:"), false);
  await screenshot("capacity-light.png");
  await evaluate(`document.querySelector('.turn-error-details summary').click()`);
  assert.match(await evaluate(`document.querySelector('.turn-error-banner').innerText`), /capacity-ui-123/);
  assert.equal(await evaluate(`!!document.querySelector('.turn-error-banner')`), true);
  await screenshot("capacity-details.png");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 800, height: 650, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  assert.equal(await evaluate(`document.querySelector('.turn-error-banner').scrollWidth <= document.querySelector('.turn-error-banner').clientWidth`), true);
  await screenshot("capacity-dark-800.png");
  await evaluate(`document.querySelector('[aria-label="エラーを閉じる"]').click()`);
  await waitFor(() => evaluate(`!document.querySelector('.turn-error-banner')`), "dismissal");
  await notify("error", { threadId: "ui-thread", turnId: "ui-turn", error: overloaded, willRetry: true });
  await waitFor(() => evaluate(`!!document.querySelector('.retry-notice')`), "capacity retry");
  const retryText = await evaluate(`document.querySelector('.retry-notice').innerText`);
  assert.match(retryText, /自動で再試行/);
  assert.equal(retryText.includes("接続が切れた"), false);
  assert.equal(await evaluate(`!!document.querySelector('.turn-error-banner')`), false);
  await screenshot("capacity-retrying.png");
  await notify("item/agentMessage/delta", { threadId: "ui-thread", turnId: "ui-turn", itemId: "ui-item", delta: "再開" });
  await waitFor(() => evaluate(`!document.querySelector('.retry-notice')`), "retry cleared after recovery");
  console.log(`Turn error UI: PASS (failure, completion, details, dismiss, retry, recovery; light/dark). Screenshots: ${output}`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await cdp("Browser.close").catch(() => {});
    socket.close();
  }
  if (browser && browser.exitCode === null) browser.kill();
  await server.close();
}
