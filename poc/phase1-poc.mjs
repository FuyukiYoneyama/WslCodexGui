// Phase 1 PoC for WSL Codex GUI wrapper spec (10節 P0 items).
// Run from Windows with: node poc/phase1-poc.mjs
//
// Verifies (against 仕様書.md 10節 P0):
//  - wsl.exe --exec <absolute codex path> app-server (stdio default) can be
//    driven end-to-end: initialize -> initialized -> thread/start ->
//    turn/start -> turn/completed
//  - stdout carries only JSONL (no contamination)
//  - stderr is separated from stdout
//  - graceful process termination (stdin close -> exit)
//  - a NEW app-server process can list and resume a thread created by a
//    previous process (F-08b)
//  - after an abrupt kill mid-turn, a NEW process's thread/read status can
//    be inspected to see what state recovery info is actually available
//    (F-08c groundwork)

import { spawn, execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const DISTRO = 'Ubuntu-24.04';
const CODEX_PATH = '/home/user/.nvm/versions/node/v22.22.2/bin/codex';
const CWD = '/home/user';

function spawnAppServer(label) {
  console.log(`[${label}] spawning: wsl.exe -d ${DISTRO} --exec ${CODEX_PATH} app-server`);
  const child = spawn('wsl.exe', ['-d', DISTRO, '--exec', CODEX_PATH, 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return child;
}

class JsonlClient {
  constructor(child, label) {
    this.child = child;
    this.label = label;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = [];
    this.contamination = [];
    this.exited = new Promise((res) => {
      child.on('exit', (code, signal) => {
        console.log(`[${label}] process exit: code=${code} signal=${signal}`);
        res({ code, signal });
      });
    });
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      process.stdout.write(`[${label} STDERR] ${text}`);
    });
    child.on('error', (err) => {
      console.log(`[${label}] spawn error:`, err);
    });
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        this.contamination.push(line);
        console.log(`[${this.label}] *** NON-JSON STDOUT LINE (contamination): ${line}`);
        continue;
      }
      if (msg.id !== undefined && ('result' in msg || 'error' in msg)) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if ('error' in msg) p.reject(new Error(`RPC error for id=${msg.id}: ${JSON.stringify(msg.error)}`));
          else p.resolve(msg.result);
        } else {
          console.log(`[${this.label}] response for unknown id ${msg.id}: ${line.slice(0, 300)}`);
        }
      } else if (msg.method) {
        for (const h of this.notificationHandlers) h(msg);
      } else {
        console.log(`[${this.label}] unrecognized message shape: ${line.slice(0, 300)}`);
      }
    }
  }

  onNotification(handler) {
    this.notificationHandlers.push(handler);
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify(payload) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for response to ${method} (id=${id})`));
        }
      }, timeoutMs);
    });
  }

  notify(method, params) {
    const payload = params === undefined ? { method } : { method, params };
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }
}

async function initializeClient(client, label) {
  const initRes = await client.request('initialize', {
    clientInfo: { name: 'wsl-codex-gui-poc', title: 'WSL Codex GUI PoC', version: '0.0.1' },
    capabilities: null,
  });
  console.log(`[${label}] initialize OK: userAgent=${initRes.userAgent} codexHome=${initRes.codexHome} platform=${initRes.platformOs}/${initRes.platformFamily}`);
  client.notify('initialized');
  console.log(`[${label}] sent initialized notification`);
  return initRes;
}

function waitForNotification(client, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for notification on ${label}`)), timeoutMs);
    client.onNotification((msg) => {
      if (predicate(msg)) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}

function checkOrphans() {
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-d', DISTRO, '--', 'bash', '-c', 'pgrep -af "app-server" || true'], (err, stdout, stderr) => {
      resolve((stdout || '').trim());
    });
  });
}

async function main() {
  const results = {};

  console.log('\n=== STAGE 1: spawn A, initialize -> initialized ===');
  const child1 = spawnAppServer('A');
  const client1 = new JsonlClient(child1, 'A');
  const eventsA = [];
  client1.onNotification((msg) => { eventsA.push(msg.method); });
  await initializeClient(client1, 'A');
  results.initializeHandshake = 'OK';

  console.log('\n=== STAGE 2: thread/start ===');
  const threadStart = await client1.request('thread/start', { cwd: CWD });
  const threadId = threadStart.thread.id;
  console.log(`[A] thread/start OK. threadId=${threadId}`);
  results.threadStart = 'OK';
  results.threadId = threadId;

  console.log('\n=== STAGE 3: turn/start (simple prompt) ===');
  const turnCompletedPromise = waitForNotification(
    client1,
    (m) => m.method === 'turn/completed',
    60000,
    'A turn/completed'
  );
  const turnStart = await client1.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Reply with exactly the single word: pong', text_elements: [] }],
  });
  console.log(`[A] turn/start accepted. turnId=${turnStart.turn?.id ?? '(no id field)'}`);
  console.log('[A] waiting for turn/completed ...');
  const turnCompletedMsg = await turnCompletedPromise;
  console.log('[A] turn/completed params:', JSON.stringify(turnCompletedMsg.params).slice(0, 500));
  console.log('[A] notification sequence observed:', eventsA.join(', '));
  results.turnCompleted = 'OK';
  results.stdoutContamination = client1.contamination;

  console.log('\n=== STAGE 4: graceful termination + orphan check ===');
  child1.stdin.end();
  const exitInfo = await Promise.race([
    client1.exited,
    delay(10000).then(() => ({ code: null, signal: 'TIMEOUT' })),
  ]);
  console.log('[A] exit info after stdin close:', exitInfo);
  results.gracefulExit = exitInfo;
  await delay(1500);
  const orphansAfterGraceful = await checkOrphans();
  console.log('[orphan check after graceful exit]', orphansAfterGraceful || '(none found)');
  results.orphansAfterGraceful = orphansAfterGraceful;

  console.log('\n=== STAGE 5: spawn B (new process), verify thread/list + thread/resume (F-08b) ===');
  const child2 = spawnAppServer('B');
  const client2 = new JsonlClient(child2, 'B');
  const eventsB = [];
  client2.onNotification((msg) => { eventsB.push(msg.method); });
  await initializeClient(client2, 'B');

  const listRes = await client2.request('thread/list', { cwd: CWD, limit: 20 });
  const foundInList = listRes.data.some((t) => t.id === threadId);
  console.log(`[B] thread/list returned ${listRes.data.length} thread(s); our thread present? ${foundInList}`);
  results.threadFoundInList = foundInList;

  const resumeRes = await client2.request('thread/resume', { threadId });
  console.log(`[B] thread/resume OK. resumed thread id=${resumeRes.thread.id}, turns loaded=${resumeRes.thread.turns.length}, status=${JSON.stringify(resumeRes.thread.status)}`);
  results.resumeOk = true;
  results.resumeStatus = resumeRes.thread.status;

  console.log('\n=== STAGE 6: follow-up turn on resumed thread (continuity check) ===');
  const turn2CompletedPromise = waitForNotification(
    client2,
    (m) => m.method === 'turn/completed',
    60000,
    'B turn/completed'
  );
  await client2.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'What single word did I ask you to reply with in my previous message? Answer with just that word.', text_elements: [] }],
  });
  const turn2CompletedMsg = await turn2CompletedPromise;
  console.log('[B] follow-up turn/completed params:', JSON.stringify(turn2CompletedMsg.params).slice(0, 500));
  results.followUpTurnAfterResume = 'OK';

  child2.stdin.end();
  await Promise.race([client2.exited, delay(10000)]);

  console.log('\n=== STAGE 7: abrupt kill mid-turn, then inspect status from a NEW process (F-08c groundwork) ===');
  const child3 = spawnAppServer('C');
  const client3 = new JsonlClient(child3, 'C');
  await initializeClient(client3, 'C');
  const thread3Start = await client3.request('thread/start', { cwd: CWD });
  const thread3Id = thread3Start.thread.id;
  console.log(`[C] new thread for crash test: ${thread3Id}`);

  // fire turn/start but do NOT await turn/completed -- kill mid-flight instead
  client3.request('turn/start', {
    threadId: thread3Id,
    input: [{ type: 'text', text: 'Count slowly from 1 to 20, one number per line, pausing to think between each.', text_elements: [] }],
  }).catch(() => {}); // response may never arrive; ignore
  await delay(1500); // let it get underway
  console.log('[C] killing process abruptly (SIGKILL) mid-turn ...');
  child3.kill('SIGKILL');
  await Promise.race([client3.exited, delay(5000)]);
  await delay(1500);

  const orphansAfterKill = await checkOrphans();
  console.log('[orphan check after SIGKILL mid-turn]', orphansAfterKill || '(none found)');
  results.orphansAfterKill = orphansAfterKill;

  console.log('[D] spawning fresh process to inspect thread status after crash ...');
  const child4 = spawnAppServer('D');
  const client4 = new JsonlClient(child4, 'D');
  await initializeClient(client4, 'D');
  const readRes = await client4.request('thread/read', { threadId: thread3Id, includeTurns: true });
  console.log(`[D] thread/read after crash: status=${JSON.stringify(readRes.thread.status)}, turns=${readRes.thread.turns.length}`);
  if (readRes.thread.turns.length > 0) {
    const lastTurn = readRes.thread.turns[readRes.thread.turns.length - 1];
    console.log('[D] last turn snapshot (truncated):', JSON.stringify(lastTurn).slice(0, 800));
  }
  results.postCrashStatus = readRes.thread.status;
  results.postCrashTurnCount = readRes.thread.turns.length;

  child4.stdin.end();
  await Promise.race([client4.exited, delay(10000)]);

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error('\nPoC FAILED:', e);
  process.exitCode = 1;
});
