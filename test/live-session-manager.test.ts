import { runtimeEnvironment, cwd } from './runtime-environment.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { flushIo } from './fake-pi.ts';
import fs from 'node:fs';
import { FakeRuntimeLauncher } from './runtime-launcher.ts';
import { until } from './fake-pimux.ts';
import { RuntimeOperationError } from '@phimacs/pimux/runtime';
import { acquireClaim, releaseClaim } from '@phimacs/pimux/ownership';
import { readProcessIdentity } from '@phimacs/pimux/process-identity';
import type { JsonRecord } from '../src/server/types.ts';
import { WebSocket } from 'ws';

// The built server module is a plain JS artifact without declarations; the
// old require() call typed these as any, so keep that contract here.
import * as tau from '../bin/tau.js';
const { LiveSessionManager, PiRpcSession } = tau as any;
import type { TestContext } from 'node:test';
after(() => fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }));

interface StubClient {
  readyState: number;
  send: (data: string) => void;
  sent: string[];
}

function openClient(): StubClient {
  // stub ws client that looks open to the broadcaster
  const sent: string[] = [];
  return { readyState: WebSocket.OPEN, send: (data: string) => sent.push(data), sent };
}
function closedClient(): StubClient {
  return { readyState: WebSocket.CLOSING, sent: [], send: () => { throw new Error('should not send to closed client'); } };
}

function fakeSession(id: string, opts: { name?: string } = {}) {
  const meta: {
    id: string; pid: number; cwd: string; modelSpec: string; model: string; modelLabel: string;
    thinkingLevel: string; sessionFile: string; sessionName: string | null; isStreaming: boolean;
    createdAt: string; lastActiveAt: string; contextUsage: null;
  } = {
    id,
    pid: 123,
    cwd: '/tmp',
    modelSpec: '',
    model: 'openai/gpt-5.5',
    modelLabel: 'openai/gpt-5.5',
    thinkingLevel: 'off',
    sessionFile: `/tmp/${id}.jsonl`,
    sessionName: opts.name || null,
    isStreaming: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    contextUsage: null,
  };
  const calls: { terminated: boolean[]; terminatedArgs: string[] } = { terminated: [], terminatedArgs: [] };
  return {
    id,
    metadata: () => ({ ...meta }),
    terminate: async (reason: string) => { calls.terminated.push(true); calls.terminatedArgs.push(reason); },
    calls,
  };
}

test('broadcast only delivers to OPEN clients', () => {
  const mgr = new LiveSessionManager();
  const a = openClient();
  const b = openClient();
  const c = closedClient();
  mgr.addClient(a); mgr.addClient(b); mgr.addClient(c);
  mgr.broadcast({ type: 'ping' });
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
  assert.equal(c.sent.length, 0);
  assert.deepEqual(JSON.parse(a.sent[0]), { type: 'ping' });
});

test('list and get expose session metadata', () => {
  const mgr = new LiveSessionManager();
  const s = fakeSession('tau_1');
  mgr.sessions.set(s.id, s);
  assert.equal(mgr.get('tau_1'), s);
  assert.equal(mgr.list().length, 1);
  assert.equal(mgr.list()[0].id, 'tau_1');
});

test('broadcastUpdated sends live_session_updated with metadata', () => {
  const mgr = new LiveSessionManager();
  const a = openClient();
  mgr.addClient(a);
  const s = fakeSession('tau_1');
  mgr.sessions.set(s.id, s);
  mgr.broadcastUpdated('tau_1');
  const msg = JSON.parse(a.sent[0]);
  assert.equal(msg.type, 'live_session_updated');
  assert.equal(msg.session.id, 'tau_1');
  // unknown id is a no-op (no broadcast)
  a.sent.length = 0;
  mgr.broadcastUpdated('missing');
  assert.equal(a.sent.length, 0);
});

test('delete removes the session, broadcasts closed, and terminates the child', async () => {
  const mgr = new LiveSessionManager();
  const a = openClient();
  mgr.addClient(a);
  const s = fakeSession('tau_1');
  mgr.sessions.set(s.id, s);
  const ok = await mgr.delete('tau_1', 'closed_by_user');
  assert.equal(ok, true);
  assert.equal(mgr.sessions.has('tau_1'), false);
  assert.equal(s.calls.terminated.length, 1);
  assert.equal(s.calls.terminatedArgs[0], 'closed_by_user');
  const msg = JSON.parse(a.sent[0]);
  assert.equal(msg.type, 'live_session_closed');
  assert.equal(msg.sessionId, 'tau_1');
  assert.equal(msg.reason, 'closed_by_user');
});

test('delete returns false for an unknown session and does not broadcast', async () => {
  const mgr = new LiveSessionManager();
  const a = openClient();
  mgr.addClient(a);
  const ok = await mgr.delete('nope');
  assert.equal(ok, false);
  assert.equal(a.sent.length, 0);
});

test('removeExited broadcasts closed only when the session is present', () => {
  const mgr = new LiveSessionManager();
  const a = openClient();
  mgr.addClient(a);
  mgr.removeExited('nope', 'process_exit:0');
  assert.equal(a.sent.length, 0);
  const s = fakeSession('tau_1');
  mgr.sessions.set(s.id, s);
  mgr.removeExited('tau_1', 'process_exit:1');
  assert.equal(mgr.sessions.has('tau_1'), false);
  assert.equal(JSON.parse(a.sent[0]).type, 'live_session_closed');
});

test('shutdown terminates all managed sessions and clears the map', async () => {
  const mgr = new LiveSessionManager();
  const s1 = fakeSession('tau_1');
  const s2 = fakeSession('tau_2');
  mgr.sessions.set(s1.id, s1);
  mgr.sessions.set(s2.id, s2);
  await mgr.shutdown();
  assert.equal(mgr.sessions.size, 0);
  assert.equal(s1.calls.terminated.length, 1);
  assert.equal(s2.calls.terminated.length, 1);
  assert.equal(s1.calls.terminatedArgs[0], 'server_shutdown');
});

test('shutdown waits for every cleanup and reports failures without dropping uncertain children', async () => {
  const mgr = new LiveSessionManager();
  const failed = fakeSession('failed');
  failed.terminate = async () => { throw new Error('exit not confirmed'); };
  const delayed = fakeSession('delayed');
  let finish: () => void = () => { throw new Error('cleanup not started'); };
  delayed.terminate = () => new Promise<void>((resolve) => { finish = resolve; });
  mgr.sessions.set(failed.id, failed);
  mgr.sessions.set(delayed.id, delayed);
  let settled = false;
  const shuttingDown = assert.rejects(mgr.shutdown(), /1 view disconnect\(s\) unconfirmed/).then(() => { settled = true; });
  await flushIo();
  assert.equal(settled, false);
  finish();
  await shuttingDown;
  assert.equal(mgr.get(failed.id), failed);
  assert.equal(mgr.get(delayed.id), undefined);
});

function fixture(t: TestContext) {
  const launcher = new FakeRuntimeLauncher();
  const manager = new LiveSessionManager({ start: launcher.start });
  t.after(async () => { await manager.shutdown().catch(() => {}); await launcher.close(); });
  return { launcher, manager };
}

test('create() publishes a session only after managed commitment and the authoritative socket boundary', async t => {
  const { launcher, manager } = fixture(t);
  let ready!: () => void;
  launcher.gate = new Promise(resolve => { ready = resolve; });
  launcher.configure = mux => { mux.extraSnapshot = { model: { provider: 'fx', id: 'deep' }, thinkingLevel: 'high' }; };
  const client = openClient();
  manager.addClient(client);
  const creating = manager.create({ cwd });
  await until(() => launcher.calls.length === 1, 'launch entered');
  assert.equal(manager.sessions.size, 0);
  assert.equal(client.sent.length, 0);
  ready();
  const session = await creating;
  const created = client.sent.map(message => JSON.parse(message)).filter(message => message.type === 'live_session_created');
  assert.equal(created.length, 1);
  assert.equal(created[0].session.model.id, 'deep');
  assert.equal(created[0].session.thinkingLevel, 'high');
  assert.equal(created[0].session.runtime.protocol, 2);
  assert.equal(session.transport.kind, 'pimux');
});

test('resume() forwards overrides and takes its active branch and name from the mux, not the disk cache', async t => {
  const { launcher, manager } = fixture(t);
  const file = path.join(runtimeEnvironment.sessions, 'branch.jsonl');
  const root = { id: 'root', parentId: null, type: 'message' };
  const kept = { id: 'kept', parentId: 'root', type: 'message' };
  const other = { id: 'other', parentId: 'root', type: 'message' };
  launcher.configure = mux => { mux.entries = [root, kept, other]; mux.leafId = 'kept'; mux.extraSnapshot.session = { file, id: 'branch', name: 'Runtime title', cwd }; };
  const args = ['--provider', 'fx', '--thinking', 'high'];
  const env = { PI_CODING_AGENT_DIR: '/synthetic/agent', HERDR_SOCKET_PATH: '/synthetic/herdr.sock' };
  const result = await manager.resume({ sessionFile: file, cwd, model: 'fx/one', entries: [{ id: 'stale' }], sessionName: 'Stale title', args, env });
  assert.deepEqual(result.session.entries, [root, kept]);
  assert.equal(result.session.sessionName, 'Runtime title');
  assert.equal(launcher.calls[0].args[launcher.calls[0].args.indexOf('--session') + 1], file);
  assert.deepEqual(launcher.calls[0].args.slice(-args.length), args);
  for (const [key, value] of Object.entries(env)) assert.equal(launcher.calls[0].env?.[key], value);
});

test('resume() joins concurrent startup and later reuses the same view without another managed launch', async t => {
  const { launcher, manager } = fixture(t);
  const file = path.join(runtimeEnvironment.sessions, 'concurrent.jsonl');
  let ready!: () => void;
  launcher.gate = new Promise(resolve => { ready = resolve; });
  const first = manager.resume({ sessionFile: file, cwd });
  const second = manager.resume({ sessionFile: file, cwd });
  await until(() => launcher.calls.length === 1, 'one launch');
  assert.equal(manager.hasPendingResume(file), true);
  ready();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.session, b.session);
  assert.equal(a.started, true);
  assert.equal(b.started, false);
  assert.equal((await manager.resume({ sessionFile: file, cwd })).session, a.session);
  assert.equal(launcher.calls.length, 1);
  assert.equal(manager.hasPendingResume(file), false);
});

test('resume during a disconnect refuses until the view settles, then reattaches without restarting Pi', async t => {
  const { launcher, manager } = fixture(t);
  const file = path.join(runtimeEnvironment.sessions, 'disconnecting.jsonl');
  const { session } = await manager.resume({ sessionFile: file, cwd });
  const transport = session.transport;
  const close = transport.close.bind(transport);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(transport, 'close', () => gate.then(close));
  const deletion = manager.delete(session.id);
  await assert.rejects(manager.resume({ sessionFile: file, cwd }), /disconnecting/);
  assert.equal(launcher.calls.length, 1);
  finish();
  await deletion;
  const successor = await manager.resume({ sessionFile: file, cwd });
  assert.notEqual(successor.session.id, session.id);
  assert.equal(successor.started, false);
  assert.equal(launcher.calls.length, 1);
});

test('failed disconnect retains the unavailable view and never grants permission to launch a second writer', async t => {
  const { launcher, manager } = fixture(t);
  const file = path.join(runtimeEnvironment.sessions, 'uncertain-disconnect.jsonl');
  const { session } = await manager.resume({ sessionFile: file, cwd });
  const transport = session.transport;
  const close = transport.close.bind(transport);
  t.mock.method(transport, 'close', async () => { throw new Error('disconnect unconfirmed'); });
  await assert.rejects(manager.delete(session.id), /disconnect unconfirmed/);
  assert.equal(manager.get(session.id), session);
  await assert.rejects(manager.resume({ sessionFile: file, cwd }), /disconnecting/);
  assert.equal(launcher.calls.length, 1);
  t.mock.method(transport, 'close', close);
  await manager.delete(session.id);
});

test('ambiguous startup identifies its retained operation and a live common claim blocks another launch', async t => {
  const { launcher, manager } = fixture(t);
  const file = path.join(runtimeEnvironment.sessions, 'uncertain-start.jsonl');
  launcher.failure = new RuntimeOperationError('startup uncertain', 'retained-operation', 'retained-runtime');
  await assert.rejects(manager.resume({ sessionFile: file, cwd }), /retained-operation/);
  const identity = readProcessIdentity(process.pid)!;
  const claim = acquireClaim(file, { id: 'retained-runtime', kind: 'rpc', protocol: 2, socket: path.join(process.env.PIMUX_DIR!, 'retained.sock'), operationId: 'retained-operation', wrapper: identity, pi: identity });
  t.after(() => releaseClaim(claim));
  await assert.rejects(manager.resume({ sessionFile: file, cwd }), /unavailable/);
  assert.equal(launcher.calls.length, 1);
});

test('create() rejects a missing directory before invoking the managed launcher', async t => {
  const { launcher, manager } = fixture(t);
  await assert.rejects(manager.create({ cwd: '/definitely/not/a/real/path/tau' }), /Directory not found/);
  assert.equal(launcher.calls.length, 0);
  assert.equal(manager.sessions.size, 0);
});

// A live session wired to a manager with one open browser, driven by the
// JSONL lines Pi writes on stdout.
function liveSessionWithClient() {
  const mgr = new LiveSessionManager();
  const client = openClient();
  mgr.addClient(client);
  const session = new PiRpcSession(mgr, { cwd: '/tmp' });
  mgr.sessions.set(session.id, session);
  const piSays = (event: Record<string, unknown>) => session.handleLine(JSON.stringify(event));
  const lastMetadata = () => {
    const updates = client.sent.map(data => JSON.parse(data)).filter(msg => msg.type === 'live_session_updated');
    return updates.at(-1)?.session;
  };
  return { mgr, session, piSays, lastMetadata };
}

const RESULT = { summary: 'What happened so far.', firstKeptEntryId: 'k1', tokensBefore: 150000, estimatedTokensAfter: 32000, usage: {}, details: {} };

test('a running compaction is part of the tab metadata until it ends', () => {
  const { session, piSays, lastMetadata } = liveSessionWithClient();
  piSays({ type: 'compaction_start', reason: 'threshold' });
  assert.equal(session.compaction.reason, 'threshold');
  assert.equal(typeof session.compaction.startedAt, 'number');
  assert.deepEqual(lastMetadata().compaction, session.compaction);

  piSays({ type: 'compaction_end', reason: 'threshold', result: RESULT, aborted: false, willRetry: false });
  assert.equal(session.compaction, null);
  assert.equal(lastMetadata().compaction, null);
});

for (const reason of ['threshold', 'overflow']) {
  test(`${reason} compaction keeps the tab busy before agent_start until the reply settles`, () => {
    const { piSays, lastMetadata } = liveSessionWithClient();
    piSays({ type: 'compaction_start', reason });
    assert.equal(lastMetadata().isStreaming, true);

    piSays({ type: 'compaction_end', reason, result: RESULT, aborted: false, willRetry: false });
    assert.equal(lastMetadata().compaction, null);
    assert.equal(lastMetadata().isStreaming, true);

    piSays({ type: 'agent_start' });
    piSays({ type: 'agent_settled' });
    assert.equal(lastMetadata().isStreaming, false);
  });
}

test('a manual compaction leaves the tab idle and its divider comes from the appended entry', () => {
  const { session, piSays } = liveSessionWithClient();
  piSays({ type: 'message_start', message: { role: 'user', content: 'hello' } });
  piSays({ type: 'compaction_start', reason: 'manual' });
  assert.equal(session.isStreaming, false);
  const entry = { type: 'compaction', id: 'c1', summary: RESULT.summary, firstKeptEntryId: 'k1', tokensBefore: 150000 };
  piSays({ type: 'entry_appended', entry });
  piSays({ type: 'compaction_end', reason: 'manual', result: RESULT, aborted: false, willRetry: false });
  assert.equal(session.isStreaming, false);
  assert.deepEqual(session.entries.at(-1), entry);
  assert.equal(session.entries.length, 2);
});

test('a failed or cancelled compaction adds no entry and clears the running state', () => {
  const { session, piSays } = liveSessionWithClient();
  piSays({ type: 'compaction_start', reason: 'manual' });
  piSays({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, errorMessage: 'Compaction failed: Nothing to compact (session too small)' });
  assert.equal(session.compaction, null);
  piSays({ type: 'compaction_start', reason: 'overflow' });
  piSays({ type: 'compaction_end', reason: 'overflow', aborted: true, willRetry: false });
  assert.equal(session.compaction, null);
  assert.equal(session.entries.length, 0);
});

test('a Pi process that exits never leaves its tab compacting', () => {
  const { mgr, session, piSays } = liveSessionWithClient();
  piSays({ type: 'compaction_start', reason: 'manual' });
  session.handleExit(1, null);
  assert.equal(session.compaction, null);
  assert.equal(mgr.sessions.size, 0);
});

test('snapshots link to history images instead of carrying their data', () => {
  const { session } = liveSessionWithClient();
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const text = { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'no image' }] } };
  session.entries = [text, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: png, mimeType: 'image/png' }] } }];
  const entries = session.currentSnapshot().entries;
  assert.equal(entries[0], text, 'entries without images are sent as they are');
  assert.deepEqual(entries[1].message.content[1], { type: 'image', mimeType: 'image/png', url: `/api/live-sessions/${encodeURIComponent(session.id)}/images/0/1/1` });
  assert.ok(!JSON.stringify(entries).includes(png));
  assert.equal(session.entries[1].message.content[1].data, png, 'the live session keeps the image data');
  assert.deepEqual(session.historyImage(0, 1, 1), { data: png, mimeType: 'image/png' });
});
