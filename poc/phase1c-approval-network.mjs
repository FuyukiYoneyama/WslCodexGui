// Follow-up to phase1b: TEST A/B there used safe read-only commands (ls, whoami)
// which did not trigger an approval prompt under approvalPolicy "untrusted".
// This test asks for a network-touching command (sandbox networkAccess: false)
// to try to force a real item/commandExecution/requestApproval round trip.

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const DISTRO = 'Ubuntu-24.04';
const CODEX_PATH = '/home/user/.nvm/versions/node/v22.22.2/bin/codex';
const CWD = '/home/user';

function spawnAppServer(label) {
  return spawn('wsl.exe', ['-d', DISTRO, '--exec', CODEX_PATH, 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

class JsonlClient {
  constructor(child, label) {
    this.child = child; this.label = label; this.buf = ''; this.nextId = 1;
    this.pending = new Map(); this.notificationHandlers = []; this.serverRequestHandler = null;
    this.exited = new Promise((res) => child.on('exit', (code, signal) => { console.log(`[${label}] exit code=${code} signal=${signal}`); res({ code, signal }); }));
    child.stdout.on('data', (c) => this._onData(c));
    child.stderr.on('data', (c) => process.stdout.write(`[${label} STDERR] ${c}`));
  }
  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx); this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { console.log(`[${this.label}] NON-JSON: ${line}`); continue; }
      if (msg.id !== undefined && ('result' in msg || 'error' in msg)) {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); ('error' in msg) ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
      } else if (msg.id !== undefined && msg.method) {
        this._handleServerRequest(msg);
      } else if (msg.method) {
        for (const h of this.notificationHandlers) h(msg);
      }
    }
  }
  async _handleServerRequest(msg) {
    console.log(`[${this.label}] >>> ServerRequest ${msg.method} id=${msg.id}: ${JSON.stringify(msg.params).slice(0, 500)}`);
    let result = null;
    if (this.serverRequestHandler) { try { result = await this.serverRequestHandler(msg); } catch (e) { console.log('handler err', e); } }
    console.log(`[${this.label}] <<< reply ${msg.method}:`, JSON.stringify(result));
    this.child.stdin.write(JSON.stringify({ id: msg.id, result }) + '\n');
  }
  onNotification(h) { this.notificationHandlers.push(h); }
  onServerRequest(h) { this.serverRequestHandler = h; }
  request(method, params, timeoutMs = 45000) {
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify(payload) + '\n');
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, timeoutMs);
    });
  }
  notify(method, params) { this.child.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + '\n'); }
}

async function initializeClient(client, label) {
  await client.request('initialize', { clientInfo: { name: 'wsl-codex-gui-poc-c', title: 'PoC C', version: '0.0.1' }, capabilities: null });
  client.notify('initialized');
  console.log(`[${label}] initialize+initialized OK`);
}

function waitFor(client, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), timeoutMs);
    client.onNotification((msg) => { if (predicate(msg)) { clearTimeout(t); resolve(msg); } });
  });
}

async function main() {
  console.log('=== TEST D: network-requiring command under networkAccess:false sandbox ===');
  const child = spawnAppServer('D');
  const client = new JsonlClient(child, 'D');
  const events = [];
  let approvalParams = null;
  let approvalDecisionSent = null;
  client.onNotification((m) => events.push(m.method));
  client.onServerRequest(async (msg) => {
    if (msg.method === 'item/commandExecution/requestApproval') {
      approvalParams = msg.params;
      approvalDecisionSent = 'accept';
      return { decision: 'accept' };
    }
    approvalDecisionSent = 'decline (unhandled method)';
    return { decision: 'decline' };
  });
  await initializeClient(client, 'D');
  const thread = await client.request('thread/start', { cwd: CWD, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  console.log('[D] thread', thread.thread.id);

  const completed = waitFor(client, (m) => m.method === 'turn/completed', 90000, 'turn/completed');
  await client.request('turn/start', {
    threadId: thread.thread.id,
    input: [{ type: 'text', text: 'Use curl to fetch the HTTP status code of https://example.com and tell me the number. Actually run the command, do not just describe it.', text_elements: [] }],
  });
  const done = await completed;
  console.log('[D] turn/completed status:', JSON.stringify(done.params.turn.status));
  console.log('[D] approval request observed?', !!approvalParams);
  if (approvalParams) {
    console.log('[D] approval params:', JSON.stringify(approvalParams));
    console.log('[D] decision sent:', approvalDecisionSent);
  }
  console.log('[D] event sequence:', events.join(', '));

  child.stdin.end();
  await Promise.race([client.exited, delay(8000)]);
  console.log('\n=== DONE ===');
}

main().catch((e) => { console.error('POC-C FAILED:', e); process.exitCode = 1; });
