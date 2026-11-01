import { runtimeEnvironment } from './runtime-environment.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { until } from './fake-pimux.ts';
import { test, before, after, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket, type ClientOptions } from 'ws';
import type { AddressInfo } from 'node:net';
import { WebSocketClient } from '../public/websocket-client.js';
import { server, computeUrls, liveManager, wss, _setAuthForTest } from '../bin/tau.js';
import type { JsonRecord } from '../src/server/types.ts';

let base = '';
let wsUrl = '';

function fakeSession(id: string) {
  const metadata = { id, cwd: runtimeEnvironment.root, model: 'fx/one', isStreaming: false };
  return {
    ...metadata, modelSpec: '', thinkingLevel: 'off', sessionFile: path.join(runtimeEnvironment.sessions, `${id}.jsonl`),
    sessionName: null, contextUsage: null,
    metadata: () => metadata,
    snapshot: () => ({ session: metadata, entries: [], model: 'fx/one', isStreaming: false }),
    terminate: async () => {},
  };
}

before(async () => {
  _setAuthForTest(false);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    computeUrls(port);
    base = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
    resolve();
  }));
});
after(async () => {
  for (const client of wss.clients) client.terminate();
  await liveManager.shutdown();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const client of wss.clients) client.terminate();
  await liveManager.shutdown();
  liveManager.sessions.clear();
  await until(() => liveManager.clients.size === 0, 'previous browser connections closed');
});

type ConnectOptions = Omit<ClientOptions, 'origin' | 'headers'> & { origin?: string | null; headers?: Record<string, string> };
function connect(options: ConnectOptions = {}) {
  const { origin, headers: supplied, ...rest } = options;
  const headers = { ...supplied, Host: new URL(base).host };
  if (origin !== null) Object.assign(headers, { Origin: origin ?? base });
  return new WebSocket(wsUrl, { ...rest, headers });
}
function nextMessage(ws: WebSocket, timeout = 2000): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ws.off('message', message); ws.off('error', error); };
    const message = (data: Buffer) => { cleanup(); resolve(JSON.parse(data.toString()) as JsonRecord); };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for WebSocket message')); }, timeout);
    ws.once('message', message);
    ws.once('error', error);
  });
}
function collect(ws: WebSocket): JsonRecord[] {
  const records: JsonRecord[] = [];
  ws.on('message', data => records.push(JSON.parse(data.toString()) as JsonRecord));
  return records;
}
function list(value: unknown): JsonRecord[] {
  assert.ok(Array.isArray(value));
  return value as JsonRecord[];
}
async function browserRuntime(t: TestContext) {
  const fixture = await runtimeFixture(t);
  liveManager.sessions.set(fixture.session.id, fixture.session);
  // The socket fixture's real session sends to its own manager. Route that
  // manager's normal fanout to this test server's browser connections.
  t.mock.method(fixture.manager, 'broadcast', (record: unknown) => liveManager.broadcast(record));
  return fixture;
}

test('browser transport dispatches authoritative interaction state without treating it as an RPC event', () => {
  const client = new WebSocketClient('ws://127.0.0.1/unused');
  const message = { type: 'interaction_state', sessionId: 'live', interactionRevision: 3, pendingDialogs: [] };
  let received: unknown;
  let rpcEvents = 0;
  client.addEventListener('interactionState', event => { received = (event as CustomEvent).detail; });
  client.addEventListener('rpcEvent', () => { rpcEvents++; });
  client.handleMessage(message);
  assert.deepEqual(received, message);
  assert.equal(rpcEvents, 0);
});

test('cross-origin WebSocket upgrade is rejected rather than opening a connection', async () => {
  const ws = connect({ origin: 'http://untrusted.invalid' });
  await assert.rejects(new Promise<void>((resolve, reject) => { ws.once('error', reject); ws.once('open', resolve); }));
  ws.close();
});

test('same-origin WebSocket upgrade receives the initial live-session state', async () => {
  liveManager.sessions.set('tau_1', fakeSession('tau_1'));
  const ws = connect();
  const message = await nextMessage(ws);
  assert.equal(message.type, 'state');
  assert.equal(list(message.liveSessions).length, 1);
  assert.equal(list(message.liveSessions)[0].id, 'tau_1');
  ws.close();
});

test('RPC commands over WebSocket preserve authentication configuration and return a response', async () => {
  const ws = connect();
  await nextMessage(ws);
  ws.send(JSON.stringify({ type: 'get_auth' }));
  const response = await nextMessage(ws);
  assert.equal(response.type, 'response');
  assert.equal(response.success, true);
  assert.equal((response.data as JsonRecord).configured, false);
  ws.close();
});

test('browser disconnect leaves the backend view and agent untouched', async () => {
  const session = fakeSession('tau_1');
  let disconnected = false;
  session.terminate = async () => { disconnected = true; };
  liveManager.sessions.set(session.id, session);
  const ws = connect();
  await nextMessage(ws);
  await new Promise<void>(resolve => { ws.once('close', () => resolve()); ws.close(); });
  await until(() => liveManager.clients.size === 0, 'browser detached');
  assert.equal(disconnected, false);
  assert.equal(liveManager.sessions.has(session.id), true);
});

test('a new browser recovers a mux-owned dialog and both browsers observe its first authoritative closure', async t => {
  const { session, mux, emit } = await browserRuntime(t);
  const dialog = { type: 'extension_ui_request', id: 'offline-request', method: 'confirm', title: 'Synthetic permission', timeout: 10000 };
  mux.replay = [dialog];
  await emit(dialog);
  await until(() => session.attachment?.dialogs.has(dialog.id), 'dialog retained by socket view');
  const ws1 = connect(), seen1 = collect(ws1);
  const first = await nextMessage(ws1);
  assert.equal(list(first.liveSessions)[0].pendingInteractionCount, 1);
  const ws2 = connect(), seen2 = collect(ws2);
  await nextMessage(ws2);
  t.after(() => { ws1.close(); ws2.close(); });
  for (const ws of [ws1, ws2]) ws.send(JSON.stringify({ type: 'live_session_snapshot_request', sessionId: session.id }));
  const snap1 = await until(() => seen1.find(record => record.type === 'live_session_snapshot'), 'first browser snapshot');
  const snap2 = await until(() => seen2.find(record => record.type === 'live_session_snapshot'), 'second browser snapshot');
  assert.deepEqual(snap1.pendingDialogs, snap2.pendingDialogs);
  assert.equal(list(snap1.pendingDialogs)[0].id, dialog.id);
  ws1.send(JSON.stringify({ type: 'extension_ui_response', sessionId: session.id, id: dialog.id, confirmed: false }));
  await until(() => mux.commands.find(command => command.type === 'extension_ui_response' && command.id === dialog.id), 'first response delivered');
  assert.equal(session.attachment?.dialogs.has(dialog.id), true, 'delivery alone does not remove mux-owned membership');
  mux.replay = [];
  await emit({ type: 'pimux_dialog_closed', id: dialog.id, reason: 'answered', clientId: session.attachment?.clientId });
  const closed = (record: JsonRecord) => record.type === 'event' && (record.event as JsonRecord)?.type === 'pimux_dialog_closed';
  await until(() => seen1.find(closed), 'first browser closure');
  await until(() => seen2.find(closed), 'second browser closure');
  ws2.send(JSON.stringify({ type: 'extension_ui_response', sessionId: session.id, id: dialog.id, confirmed: true }));
  await until(() => seen2.find(record => record.type === 'response' && record.success === false && record.id === dialog.id), 'stale second response rejected');
  assert.deepEqual(mux.commands.filter(command => command.type === 'extension_ui_response'), [{ type: 'extension_ui_response', id: dialog.id, confirmed: false }]);
  assert.equal(session.pending.size, 0);
});

test('shared queue clearing requires global confirmation and sends recovered input only to its requester', async t => {
  const { session, mux } = await browserRuntime(t);
  mux.responses.clear_queue = { success: true, data: { steering: ['private recovery text'], followUp: ['second item'] } };
  const ws1 = connect(), seen1 = collect(ws1);
  await nextMessage(ws1);
  const ws2 = connect(), seen2 = collect(ws2);
  await nextMessage(ws2);
  t.after(() => { ws1.close(); ws2.close(); });
  ws2.send(JSON.stringify({ type: 'clear_queue', sessionId: session.id, id: 'unconfirmed' }));
  await until(() => seen2.find(record => record.type === 'response' && record.id === 'unconfirmed' && record.success === false), 'unconfirmed clear rejected');
  assert.equal(mux.commands.some(command => command.type === 'clear_queue'), false);
  ws1.send(JSON.stringify({ type: 'clear_queue', sessionId: session.id, id: 'confirmed', confirmGlobal: true }));
  const response = await until(() => seen1.find(record => record.type === 'response' && record.id === 'confirmed'), 'requester acknowledgement');
  assert.equal(response.success, true);
  assert.deepEqual(response.data, { steering: ['private recovery text'], followUp: ['second item'] });
  assert.ok(response.recoveryContext);
  await until(() => seen2.find(record => record.type === 'event' && (record.event as JsonRecord)?.type === 'shared_queue_cleared'), 'other browser notified of destructive clear');
  assert.equal(JSON.stringify(seen2).includes('private recovery text'), false);
  assert.equal(JSON.stringify(seen2).includes('second item'), false);
});

test('manager broadcasts are delivered to connected WebSocket clients', async () => {
  const ws = connect();
  await nextMessage(ws);
  liveManager.broadcast({ type: 'live_session_created', session: fakeSession('tau_new').metadata() });
  const message = await nextMessage(ws);
  assert.equal(message.type, 'live_session_created');
  assert.equal((message.session as JsonRecord).id, 'tau_new');
  ws.close();
});
