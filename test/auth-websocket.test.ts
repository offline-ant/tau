import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import type { TestContext } from 'node:test';
import type { WebSocket as WsWebSocket } from 'ws';

// Auth credentials configured, but disabled at startup so same-origin WS
// upgrades succeed without Basic headers. settings.json pins authEnabled:false
// so AUTH_CONFIGURED is true while authEnabled starts false.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-auth-ws-'));
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');
fs.mkdirSync(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
fs.writeFileSync(
  path.join(TMP, 'settings.json'),
  JSON.stringify({ tau: { user: 'admin', pass: 's3cret', authEnabled: false } }),
);

// Load the server after the env + settings are in place: the module reads
// them at load time, and ESM hoists static imports ahead of this body.
const { server, computeUrls, liveManager, _setAuthForTest } = (await import('../bin/tau.js')) as any;

let base = '';
let wsUrl = '';

before(async () => {
  _setAuthForTest(false);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      computeUrls(port);
      base = `http://127.0.0.1:${port}`;
      wsUrl = `ws://127.0.0.1:${port}/ws`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  liveManager.sessions.clear();
  _setAuthForTest(false);
});

function connect() {
  const headers = { Origin: base, Host: new URL(base).host };
  return new WebSocket(wsUrl, { headers });
}

// Arm a one-shot message listener and return a promise that resolves with the
// next received message. Must be called BEFORE the action that triggers the
// broadcast, so the listener is attached before the event fires.
function armNextMessage(ws: WsWebSocket, timeout = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for WS message')), timeout);
    ws.once('message', (data: Buffer) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
    ws.once('error', (e: Error) => { clearTimeout(timer); reject(e); });
  });
}

test('set_auth { enabled: true } broadcasts auth_changed and closes clients with code 4001', async () => {
  const ws = connect();
  await armNextMessage(ws); // swallow initial live-session state
  // arm the listener BEFORE the fetch so the auth_changed event is not lost
  const authMsgP = armNextMessage(ws);
  const closeP = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('client was not closed')), 2000);
    ws.on('close', (c: number) => { clearTimeout(timer); resolve(c); });
  });
  const res = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ type: 'set_auth', enabled: true }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.enabled, true);

  const msg = await authMsgP;
  assert.equal(msg.type, 'event');
  assert.equal(msg.event.type, 'auth_changed');
  assert.equal(msg.event.enabled, true);

  // the client is then closed with code 4001 after the 25ms grace timer
  const code = await closeP;
  assert.equal(code, 4001);
});

test('set_auth { enabled: false } broadcasts auth_changed but does not close clients', async () => {
  const ws = connect();
  await armNextMessage(ws); // swallow initial live-session state
  _setAuthForTest(true); // start enabled so the disable path is exercised
  const authMsgP = armNextMessage(ws);
  // auth is enabled for this request, so Basic credentials are required
  const basic = Buffer.from('admin:s3cret').toString('base64');
  const res = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host, Authorization: `Basic ${basic}` },
    body: JSON.stringify({ type: 'set_auth', enabled: false }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.enabled, false);
  const msg = await authMsgP;
  assert.equal(msg.event.type, 'auth_changed');
  assert.equal(msg.event.enabled, false);
  // the disable direction must not trigger the 4001 close
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ws.readyState, WebSocket.OPEN, 'client must stay open when auth is disabled');
  ws.close();
});

test('auth-enabled HTTP request without credentials is rejected with 401', async () => {
  _setAuthForTest(true);
  const res = await fetch(`${base}/api/live-sessions`);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Basic realm="Tau"');
});

test('auth-enabled HTTP request with wrong credentials is rejected with 401', async () => {
  _setAuthForTest(true);
  const bad = Buffer.from('admin:wrong').toString('base64');
  const res = await fetch(`${base}/api/live-sessions`, {
    headers: { Authorization: `Basic ${bad}` },
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Basic realm="Tau"');
});

test('auth-enabled HTTP request with valid credentials succeeds', async () => {
  _setAuthForTest(true);
  const good = Buffer.from('admin:s3cret').toString('base64');
  const res = await fetch(`${base}/api/live-sessions`, {
    headers: { Authorization: `Basic ${good}` },
  });
  assert.equal(res.status, 200);
});

test('/api/health is reachable without credentials even when auth is enabled', async () => {
  _setAuthForTest(true);
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

/** A request with this exact target: `fetch` would normalize it first. */
function rawRequest(target: string, headers: http.OutgoingHttpHeaders = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = http.request({ host: url.hostname, port: url.port, path: target, headers, agent: false });
    request.on('response', (res) => { res.resume(); resolve(res.statusCode!); });
    request.on('error', reject);
    request.end();
  });
}

const HEALTH_ALIASES = [
  '/api/health/../live-sessions', '/api/health/%2e%2e/live-sessions', '/api/health/%2E%2E/live-sessions',
  '/api/health/.%2e/live-sessions', '/api/health\\..\\live-sessions', '/api/health/..%2flive-sessions',
  '/api/health%2f..%2flive-sessions', '/api/health/../../api/live-sessions', '/api/health/./../live-sessions',
  '/api/healthz', '/api/health/', '/api/health/x', '//api/health', 'http://localhost/api/health',
];

test('only the exact health route is open: no path spelling reaches another route', async () => {
  _setAuthForTest(true);
  for (const target of HEALTH_ALIASES) assert.equal(await rawRequest(target), 401, target);
  assert.equal(await rawRequest('/api/health'), 200);
  assert.equal(await rawRequest('/api/health?probe=1'), 200);
  assert.equal(await rawRequest('/api/live-sessions/../health'), 200, 'it normalizes to the health route');
  const good = Buffer.from('admin:s3cret').toString('base64');
  assert.equal(await rawRequest('/api/health/../live-sessions', { Authorization: `Basic ${good}` }), 200, 'credentials still route it');
});

test('no path spelling upgrades without credentials', async () => {
  _setAuthForTest(true);
  const upgrade = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
  for (const target of ['/ws', '/api/health/../../ws', '/api/health/%2e%2e/%2e%2e/ws', '/api/health', '/api/voice']) {
    assert.equal(await rawRequest(target, upgrade), 401, target);
  }
});

test('auth-enabled WebSocket upgrade without credentials is rejected', async () => {
  _setAuthForTest(true);
  const ws = new WebSocket(wsUrl, { headers: { Origin: base, Host: new URL(base).host } });
  // ws client does not surface the HTTP 401 status on the error event, so we
  // only assert that the upgrade does not succeed.
  await assert.rejects(
    () => new Promise((_, reject) => {
      ws.on('error', reject);
      ws.on('open', () => reject(new Error('auth-enabled upgrade without creds should not succeed')));
    }),
  );
  try { ws.close(); } catch {}
});
