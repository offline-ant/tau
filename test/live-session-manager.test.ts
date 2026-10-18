import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { FakePi, flushIo } from './fake-pi.ts';
import type { JsonRecord } from '../src/server/types.ts';
import { WebSocket } from 'ws';

// The built server module is a plain JS artifact without declarations; the
// old require() call typed these as any, so keep that contract here.
const { LiveSessionManager, _setSpawnPiForTest } = (await import('../bin/tau.js')) as any;
import type { TestContext } from 'node:test';

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
  const shuttingDown = assert.rejects(mgr.shutdown(), /1 Pi child exit\(s\) unconfirmed/).then(() => { settled = true; });
  await flushIo();
  assert.equal(settled, false);
  finish();
  await shuttingDown;
  assert.equal(mgr.get(failed.id), failed);
  assert.equal(mgr.get(delayed.id), undefined);
});

test('create() waits for readiness before storing and broadcasting the real model', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new FakePi({ autoRespond: false, state: { model: { provider: 'openai', id: 'gpt-5.5' }, thinkingLevel: 'high' } });
  _setSpawnPiForTest(() => child.asChild());
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const client = openClient();
  mgr.addClient(client);
  const cwd = os.tmpdir();
  const creating = mgr.create({ cwd });
  t.mock.timers.tick(1000);
  await flushIo();
  assert.equal(mgr.sessions.size, 0);
  assert.equal(client.sent.length, 0);
  assert.deepEqual(child.commands.map((command) => command.type), ['get_state']);
  child.autoRespond = true;
  child.respond(child.commands[0]);
  const session = await creating;
  assert.equal(mgr.get(session.id), session);
  assert.equal(session.cwd, path.resolve(cwd));
  assert.equal(session.pid, 12345);
  const messages = client.sent.map((message) => JSON.parse(message));
  const created = messages.filter((message) => message.type === 'live_session_created');
  assert.equal(created.length, 1);
  assert.equal(created[0].session.id, session.id);
  assert.deepEqual(created[0].session.model, { provider: 'openai', id: 'gpt-5.5' });
  assert.equal(created[0].session.thinkingLevel, 'high');
  assert.ok(child.commands.some((command) => command.type === 'get_session_stats'));
});

test('resume() forwards args/env and uses the active branch while preserving header/name', async (t: TestContext) => {
  const cwd = os.tmpdir();
  const sessionFile = path.join(cwd, 'tau-resume-branch.jsonl');
  const root = { id: 'root', parentId: null, type: 'message', message: { role: 'user', content: 'question' } };
  const kept = { id: 'kept', parentId: 'root', type: 'message', message: { role: 'assistant', content: 'kept answer' } };
  const discarded = { id: 'discarded', parentId: 'root', type: 'message', message: { role: 'assistant', content: 'other branch' } };
  const header = { type: 'session', id: 'session-id', cwd };
  const child = new FakePi({ sessionFile, tree: [{ entry: root, children: [{ entry: kept }, { entry: discarded }] }], leafId: 'kept' });
  const calls: Array<{ args: string[]; options: JsonRecord }> = [];
  _setSpawnPiForTest((_command: string, args: string[], options: JsonRecord) => {
    calls.push({ args, options });
    return child.asChild();
  });
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const client = openClient();
  mgr.addClient(client);
  const args = ['--provider', 'openai', '--thinking', 'high'];
  const env = { PI_CODING_AGENT_DIR: '/tmp/private-agent', HERDR_SOCKET_PATH: '/tmp/herdr.sock' };
  const { session: session } = await mgr.resume({ sessionFile, cwd, model: 'gpt-4o', entries: [header, root, kept, discarded], sessionName: 'My Session', args, env });
  assert.equal(mgr.get(session.id), session);
  assert.deepEqual(session.entries, [header, root, kept]);
  assert.equal(session.sessionName, 'My Session');
  assert.equal(session.sessionFile, sessionFile);
  assert.equal(calls[0].args[calls[0].args.indexOf('--session') + 1], sessionFile);
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'gpt-4o');
  assert.deepEqual(calls[0].args.slice(-args.length), args);
  const childEnv = calls[0].options.env as Record<string, string>;
  for (const [key, value] of Object.entries(env)) assert.equal(childEnv[key], value);
  const created = client.sent.map((message) => JSON.parse(message)).find((message) => message.type === 'live_session_created');
  assert.equal(created.session.sessionFile, sessionFile);
  assert.equal(created.session.sessionName, 'My Session');
});

test('resume() coalesces delayed concurrent and repeated resumes for the same file', async (t: TestContext) => {
  const sessionFile = '/tmp/tau-concurrent-resume.jsonl';
  const child = new FakePi({ sessionFile, autoRespond: false });
  let spawned = 0;
  _setSpawnPiForTest(() => { spawned++; return child.asChild(); });
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const first = mgr.resume({ sessionFile, cwd: os.tmpdir() });
  const second = mgr.resume({ sessionFile, cwd: os.tmpdir() });
  assert.equal(mgr.hasPendingResume(sessionFile), true);
  await flushIo();
  assert.equal(spawned, 1);
  assert.equal(mgr.sessions.size, 0);
  child.autoRespond = true;
  child.respond(child.commands[0]);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.session, b.session);
  assert.equal(a.started, true);
  assert.equal(b.started, false);
  const repeated = await mgr.resume({ sessionFile, cwd: os.tmpdir() });
  assert.equal(repeated.session, a.session);
  assert.equal(repeated.started, false);
  assert.equal(spawned, 1);
  assert.equal(mgr.hasPendingResume(sessionFile), false);
});

test('resume() waits for actual child exit during concurrent deletes', async (t: TestContext) => {
  const sessionFile = '/tmp/tau-wait-exit.jsonl';
  const children: FakePi[] = [];
  _setSpawnPiForTest(() => {
    const child = new FakePi({ sessionFile, exitOnSignal: null });
    children.push(child);
    return child.asChild();
  });
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const { session: first } = await mgr.resume({ sessionFile, cwd: os.tmpdir() });
  const deletion = mgr.delete(first.id);
  const duplicateDeletion = mgr.delete(first.id);
  assert.equal(mgr.hasTerminatingResume(sessionFile), true);
  assert.equal(mgr.get(first.id), first, 'retain ownership until exit');
  const resuming = mgr.resume({ sessionFile, cwd: os.tmpdir() });
  await flushIo();
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].signals, ['SIGTERM']);
  children[0].exit(null, 'SIGTERM');
  const [second] = await Promise.all([resuming, deletion, duplicateDeletion]);
  assert.notEqual(first.id, second.session.id);
  assert.equal(second.started, true);
  assert.equal(children.length, 2);
  assert.equal(mgr.sessions.size, 1);
  assert.equal(mgr.hasTerminatingResume(sessionFile), false);
});

test('failed cleanup rejects delete and concurrent resume without dropping ownership', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sessionFile = '/tmp/tau-uncertain-exit.jsonl';
  const child = new FakePi({ sessionFile, exitOnSignal: null });
  let spawned = 0;
  _setSpawnPiForTest(() => { spawned++; return child.asChild(); });
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const { session: session } = await mgr.resume({ sessionFile, cwd: os.tmpdir() });
  const deletion = assert.rejects(mgr.delete(session.id), { childStopped: false, sessionId: session.id });
  const resuming = assert.rejects(mgr.resume({ sessionFile, cwd: os.tmpdir() }), { childStopped: false, sessionId: session.id });
  await flushIo();
  t.mock.timers.tick(1500);
  await flushIo();
  t.mock.timers.tick(5000);
  await Promise.all([deletion, resuming]);
  assert.equal(mgr.get(session.id), session);
  assert.equal(spawned, 1);
  await assert.rejects(mgr.resume({ sessionFile, cwd: os.tmpdir() }), { childStopped: false, sessionId: session.id });
  assert.equal(spawned, 1);
  child.exit(null, 'SIGKILL');
  assert.equal(mgr.sessions.size, 0);
});

test('ambiguous startup retains the child and blocks later resumes until exit', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sessionFile = '/tmp/tau-failed-start.jsonl';
  const child = new FakePi({ sessionFile, autoRespond: false, exitOnSignal: null });
  let spawned = 0;
  _setSpawnPiForTest(() => { spawned++; return child.asChild(); });
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const failing = assert.rejects(mgr.resume({ sessionFile, cwd: os.tmpdir() }), { childStopped: false });
  await flushIo();
  child.respond(child.commands[0], { success: false, error: 'configuration rejected' });
  await flushIo();
  t.mock.timers.tick(1500);
  await flushIo();
  t.mock.timers.tick(5000);
  await failing;
  assert.equal(mgr.sessions.size, 1);
  assert.equal(mgr.hasPendingResume(sessionFile), false);
  await assert.rejects(mgr.resume({ sessionFile, cwd: os.tmpdir() }), { childStopped: false });
  assert.equal(spawned, 1);
  child.exit(null, 'SIGKILL');
  assert.equal(mgr.sessions.size, 0);
});

test('create() rejects a missing cwd without spawning a child', async (t: TestContext) => {
  let spawned = false;
  _setSpawnPiForTest(() => { spawned = true; return new FakePi().asChild(); });
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  await assert.rejects(mgr.create({ cwd: '/definitely/not/a/real/path/tau' }), { childStopped: true });
  assert.equal(spawned, false);
  assert.equal(mgr.sessions.size, 0);
});
