// Targeted follow-up PoC: approval flow (F-04/7.3) and Stop/turn-interrupt (F-06).
// Run from Windows with: node poc/phase1b-approval-stop.mjs

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const DISTRO = 'Ubuntu-24.04';
const CODEX_PATH = '/home/user/.nvm/versions/node/v22.22.2/bin/codex';
const CWD = '/home/user';

function spawnAppServer(label) {
  console.log(`[${label}] spawning app-server`);
  return spawn('wsl.exe', ['-d', DISTRO, '--exec', CODEX_PATH, 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

class JsonlClient {
  constructor(child, label) {
    this.child = child;
    this.label = label;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = [];
    this.serverRequestHandler = null;
    this.exited = new Promise((res) => {
      child.on('exit', (code, signal) => {
        console.log(`[${label}] process exit: code=${code} signal=${signal}`);
        res({ code, signal });
      });
    });
    child.stdout.on('data', (c) => this._onData(c));
    child.stderr.on('data', (c) => process.stdout.write(`[${label} STDERR] ${c}`));
    child.on('error', (err) => console.log(`[${label}] spawn error:`, err));
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { console.log(`[${this.label}] NON-JSON: ${line}`); continue; }

      if (msg.id !== undefined && ('result' in msg || 'error' in msg)) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if ('error' in msg) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      } else if (msg.id !== undefined && msg.method) {
        this._handleServerRequest(msg);
      } else if (msg.method) {
        for (const h of this.notificationHandlers) h(msg);
      }
    }
  }

  async _handleServerRequest(msg) {
    console.log(`[${this.label}] >>> ServerRequest ${msg.method} id=${msg.id}: ${JSON.stringify(msg.params).slice(0, 400)}`);
    let result = null;
    if (this.serverRequestHandler) {
      try {
        result = await this.serverRequestHandler(msg);
      } catch (e) {
        console.log(`[${this.label}] handler threw:`, e);
      }
    }
    console.log(`[${this.label}] <<< responding to ${msg.method} id=${msg.id} with`, JSON.stringify(result));
    this.child.stdin.write(JSON.stringify({ id: msg.id, result }) + '\n');
  }

  onNotification(h) { this.notificationHandlers.push(h); }
  onServerRequest(h) { this.serverRequestHandler = h; }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify(payload) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, timeoutMs);
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + '\n');
  }
}

async function initializeClient(client, label) {
  const res = await client.request('initialize', {
    clientInfo: { name: 'wsl-codex-gui-poc-b', title: 'WSL Codex GUI PoC B', version: '0.0.1' },
    capabilities: null,
  });
  client.notify('initialized');
  console.log(`[${label}] initialize+initialized OK`);
  return res;
}

function waitFor(client, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting on ${label}`)), timeoutMs);
    client.onNotification((msg) => { if (predicate(msg)) { clearTimeout(t); resolve(msg); } });
  });
}

async function main() {
  console.log('\n=== TEST A: approval flow (accept) ===');
  const childA = spawnAppServer('A');
  const clientA = new JsonlClient(childA, 'A');
  const eventsA = [];
  let approvalSeenA = null;
  clientA.onNotification((m) => eventsA.push(m.method));
  clientA.onServerRequest(async (msg) => {
    if (msg.method === 'item/commandExecution/requestApproval') {
      approvalSeenA = msg.params;
      return { decision: 'accept' };
    }
    return { decision: 'decline' };
  });
  await initializeClient(clientA, 'A');
  const threadA = await clientA.request('thread/start', {
    cwd: CWD,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
  });
  console.log('[A] thread', threadA.thread.id, 'approvalPolicy=', threadA.approvalPolicy, 'sandbox=', threadA.sandbox);

  const completedA = waitFor(clientA, (m) => m.method === 'turn/completed', 60000, 'A turn/completed');
  await clientA.request('turn/start', {
    threadId: threadA.thread.id,
    input: [{ type: 'text', text: 'Run the shell command `ls -la` in the current directory and briefly tell me how many entries it printed.', text_elements: [] }],
  });
  const doneA = await completedA;
  console.log('[A] turn/completed status:', JSON.stringify(doneA.params.turn.status));
  console.log('[A] approval request observed?', !!approvalSeenA, approvalSeenA ? `command=${approvalSeenA.command}` : '');
  console.log('[A] event sequence:', eventsA.join(', '));
  childA.stdin.end();
  await Promise.race([clientA.exited, delay(8000)]);

  console.log('\n=== TEST B: approval flow (decline) — does turn continue or abort? ===');
  const childB = spawnAppServer('B');
  const clientB = new JsonlClient(childB, 'B');
  const eventsB = [];
  let approvalSeenB = null;
  clientB.onNotification((m) => eventsB.push(m.method));
  clientB.onServerRequest(async (msg) => {
    if (msg.method === 'item/commandExecution/requestApproval') {
      approvalSeenB = msg.params;
      return { decision: 'decline' };
    }
    return { decision: 'decline' };
  });
  await initializeClient(clientB, 'B');
  const threadB = await clientB.request('thread/start', {
    cwd: CWD,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
  });
  const completedB = waitFor(clientB, (m) => m.method === 'turn/completed', 60000, 'B turn/completed');
  await clientB.request('turn/start', {
    threadId: threadB.thread.id,
    input: [{ type: 'text', text: 'Run the shell command `whoami` and tell me the output.', text_elements: [] }],
  });
  const doneB = await completedB;
  console.log('[B] turn/completed status after DECLINE:', JSON.stringify(doneB.params.turn.status));
  console.log('[B] approval request observed?', !!approvalSeenB);
  console.log('[B] event sequence:', eventsB.join(', '));
  childB.stdin.end();
  await Promise.race([clientB.exited, delay(8000)]);

  console.log('\n=== TEST C: Stop / turn.interrupt mid-turn ===');
  const childC = spawnAppServer('C');
  const clientC = new JsonlClient(childC, 'C');
  const eventsC = [];
  clientC.onNotification((m) => { eventsC.push({ t: Date.now(), method: m.method }); });
  await initializeClient(clientC, 'C');
  const threadC = await clientC.request('thread/start', { cwd: CWD });

  const turnStartedPromise = waitFor(clientC, (m) => m.method === 'turn/started', 15000, 'C turn/started');
  const turnStartReqPromise = clientC.request('turn/start', {
    threadId: threadC.thread.id,
    input: [{ type: 'text', text: 'Write a detailed 600-word essay about the history of computing. Take your time and be thorough.', text_elements: [] }],
  });
  const turnStartedMsg = await turnStartedPromise;
  const turnId = turnStartedMsg.params.turn?.id ?? (await turnStartReqPromise).turn.id;
  console.log('[C] turn started, turnId=', turnId, '-- waiting 2s before interrupting');
  await delay(2000);

  console.log('[C] sending turn/interrupt ...');
  const interruptResult = await clientC.request('turn/interrupt', { threadId: threadC.thread.id, turnId });
  console.log('[C] turn/interrupt request acknowledged:', JSON.stringify(interruptResult));

  // keep listening for a few more seconds to catch any delayed events
  await delay(5000);
  console.log('[C] events observed (with relative timestamps):');
  const t0 = eventsC.length ? eventsC[0].t : Date.now();
  for (const e of eventsC) console.log(`    +${e.t - t0}ms  ${e.method}`);

  const readC = await clientC.request('thread/read', { threadId: threadC.thread.id, includeTurns: true });
  const lastTurn = readC.thread.turns[readC.thread.turns.length - 1];
  console.log('[C] final turn status per thread/read:', JSON.stringify(lastTurn.status), 'completedAt=', lastTurn.completedAt);

  childC.stdin.end();
  await Promise.race([clientC.exited, delay(8000)]);

  console.log('\n=== DONE ===');
}

main().catch((e) => { console.error('POC-B FAILED:', e); process.exitCode = 1; });
