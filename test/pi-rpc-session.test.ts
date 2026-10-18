import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { FakePi, flushIo } from './fake-pi.ts';

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pirs-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');

// Load the server after the env is in place: the module reads it at load
// time, and ESM hoists static imports ahead of this body.
const { PiRpcSession, LiveSessionManager, normalizeModel, parseModelSpecToModel, handleRpcCommand, liveManager, _setSpawnPiForTest, NAVIGATE_COMMAND } = (await import('../bin/tau.js')) as any;
import type { TestContext } from 'node:test';

interface BroadcastMsg {
  type: string;
  sessionId?: string;
  event?: { type: string; [k: string]: unknown };
  session?: { id: string; [k: string]: unknown };
  [k: string]: unknown;
}

type RpcCommand = { type: string; id?: string; message?: string; [k: string]: unknown };
type RpcOpts = { timeoutMs?: number };
type FakeWrite = (data: string, cb?: (err?: Error | null) => void) => void;

function makeManager() {
  const broadcasts: BroadcastMsg[] = [];
  const updated: string[] = [];
  const removed: Array<{ id: string; reason: string }> = [];
  return {
    broadcasts,
    updated,
    removed,
    broadcast(msg: BroadcastMsg) { broadcasts.push(msg); },
    broadcastUpdated(id: string) { updated.push(id); },
    removeExited(id: string, reason: string) { removed.push({ id, reason }); },
  };
}

function makeSession(modelSpec = '') {
  const manager = makeManager();
  const session = new PiRpcSession(manager, { cwd: '/tmp', modelSpec });
  return { session, manager };
}

test('agent_start/turn_start set isStreaming; agent_end/turn_end clear it', () => {
  const { session, manager } = makeSession();
  session.handleEvent({ type: 'turn_start' });
  assert.equal(session.isStreaming, true);
  session.handleEvent({ type: 'agent_start' });
  assert.equal(session.isStreaming, true);
  session.handleEvent({ type: 'turn_end' });
  assert.equal(session.isStreaming, false);
  session.handleEvent({ type: 'agent_end' });
  assert.equal(session.isStreaming, false);
  // each event is broadcast
  assert.equal(manager.broadcasts.length, 4);
  for (const b of manager.broadcasts) {
    assert.equal(b.type, 'event');
    assert.equal(b.sessionId, session.id);
  }
});

test('only tau-tree-navigate extension_error events are kept for navigate_tree diagnostics', () => {
  const { session } = makeSession();
  // Errors from other extensions (or other events from tau's command) must
  // never be blamed for a failed tree navigation.
  session.handleEvent({ type: 'extension_error', extensionPath: 'command:some-other-command', error: 'unrelated failure' });
  assert.equal(session.lastExtensionError, null);
  session.handleEvent({ type: 'extension_error', extensionPath: '/home/user/.pi/extensions/foo.ts', event: 'session_tree', error: 'hook exploded' });
  assert.equal(session.lastExtensionError, null);
  session.handleEvent({ type: 'extension_error', extensionPath: `command:${NAVIGATE_COMMAND}`, error: 'Entry x not found in the session tree' });
  assert.equal(session.lastExtensionError, 'Entry x not found in the session tree');
});

test('user message_start tracks an entry and derives a session title', () => {
  const { session, manager } = makeSession();
  session.handleEvent({
    type: 'message_start',
    message: { role: 'user', content: 'ok so please help me refactor the parser' },
  });
  assert.equal(session.entries.length, 1);
  assert.equal(session.userMessages.length, 1);
  assert.equal(session.titleSet, true);
  // only the first leading filler word is stripped, then capitalized
  assert.equal(session.sessionName, 'So please help me refactor the parser');
  // a session_name event is broadcast
  const nameEvent = manager.broadcasts.find(
    (b) => b.event && b.event.type === 'session_name',
  );
  assert.ok(nameEvent, 'expected a session_name broadcast');
});

test('generic session_name events do not block local title generation', () => {
  const { session, manager } = makeSession();
  session.handleEvent({ type: 'session_name', name: 'chat' });
  assert.equal(session.sessionName, null);
  assert.equal(manager.broadcasts.length, 0, 'generic session_name events must not reach clients');
  session.handleEvent({ type: 'message_start', message: { role: 'user', content: 'fix the resumed tab title' } });
  assert.equal(session.sessionName, 'Fix the resumed tab title');
});

test('title is truncated and trimmed for long user messages', () => {
  const { session } = makeSession();
  const long = 'Please generate a very detailed comprehensive plan for migrating the entire monolith into standalone rpc apps with tabs';
  session.handleEvent({ type: 'message_start', message: { role: 'user', content: long } });
  assert.ok(session.sessionName.length <= 60, `got ${session.sessionName.length}`);
  assert.ok(session.sessionName.endsWith('…'));
});

test('assistant message_end records usage but never overwrites model identity', () => {
  const { session } = makeSession('openai/gpt-5.5:high');
  // Precondition: server-tracked model is a full canonical object.
  assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-5.5' });
  const beforeModel = session.model;
  const usage = { input_tokens: 10, output_tokens: 5 };
  session.handleEvent({
    type: 'message_end',
    message: { role: 'assistant', content: 'done', model: 'gpt-5.5', usage },
  });
  assert.equal(session.entries.length, 1);
  // The bare id string on message_end must NOT overwrite the canonical object.
  assert.deepEqual(session.model, beforeModel);
  assert.equal(typeof session.model, 'object');
  assert.deepEqual(session.contextUsage.usage, usage);
});

test('handleResponse resolves a pending send command and updates state', async () => {
  const { session } = makeSession();
  // stub a child with a writable stdin that accepts the write
  session.child = {
    stdin: { writable: true, write: ((_data: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite },
  };
  const p = session.send({ type: 'get_session_stats' }, { timeoutMs: 500 });
  // find the assigned id from the pending map
  const id = [...session.pending.keys()][0];
  session.handleResponse({
    type: 'response',
    id,
    success: true,
    data: { sessionFile: '/tmp/s.jsonl', contextUsage: { tokens: 42 }, model: 'openai/gpt-5.5' },
  });
  const resp = await p;
  assert.equal(resp.data.sessionFile, '/tmp/s.jsonl');
  assert.equal(session.sessionFile, '/tmp/s.jsonl');
  // `data.model: 'openai/gpt-5.5'` (string) is normalized to a canonical object.
  assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-5.5' });
  assert.equal(session.pending.size, 0);
});

test('send rejects when the child stdin is not writable', async () => {
  const { session } = makeSession();
  session.child = { stdin: { writable: false } };
  await assert.rejects(() => session.send({ type: 'prompt', message: 'hi' }), /not running/);
});

test('send rejects when terminating', async () => {
  const { session } = makeSession();
  session.child = { stdin: { writable: true, write: ((_d: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite } };
  session.terminating = true;
  await assert.rejects(() => session.send({ type: 'prompt', message: 'hi' }), /not running/);
});

test('terminate rejects pending commands and waits for actual exit after SIGKILL', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session } = makeSession();
  const child = new FakePi({ autoRespond: false, exitOnSignal: null });
  session.child = child.asChild();
  const check = assert.rejects(session.send({ type: 'get_session_stats' }, { timeoutMs: 100000 }), /Session terminated/);
  const term = session.terminate('closed_by_user');
  assert.equal(session.terminate('duplicate'), term, 'concurrent termination joins the exit wait');
  let completed = false;
  term.then(() => { completed = true; });
  t.mock.timers.tick(1500);
  await flushIo();
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(completed, false, 'sending SIGKILL is not proof of exit');
  child.exit(null, 'SIGKILL');
  await Promise.all([term, check]);
  assert.equal(session.pending.size, 0);
  assert.equal(session.terminating, true);
});

test('terminate resolves immediately on SIGTERM exit without waiting out the grace period', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session } = makeSession();
  const child = new FakePi();
  session.child = child.asChild();
  await session.terminate('closed_by_user');
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.signalCode, 'SIGTERM');
});

test('terminate reports an uncertain outcome when neither signal produces an exit', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session } = makeSession();
  const child = new FakePi({ exitOnSignal: null });
  session.child = child.asChild();
  const failure = assert.rejects(session.terminate(), { childStopped: false, sessionId: session.id });
  t.mock.timers.tick(1500);
  await flushIo();
  t.mock.timers.tick(5000);
  await failure;
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(session.terminating, true);
});

test('a pending command rejected by an exit reports the child stderr that explains it', async () => {
  const manager = makeManager();
  const session = new PiRpcSession(manager, { cwd: '/tmp' });
  session.child = { stdin: { writable: true, write: ((_d: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite } };
  // A child that dies during startup says why on stderr; the exit code alone
  // made an unknown provider look like a transport failure.
  for (let i = 0; i < 25; i++) session.stderrTail.push(`noise ${i}`);
  if (session.stderrTail.length > 20) session.stderrTail.splice(0, session.stderrTail.length - 20);
  session.stderrTail.push('Error: Unknown provider "claude-agent".');
  const pending = session.send({ type: 'get_session_stats' }, { timeoutMs: 100000 });
  const check = assert.rejects(pending, /Pi process exited \(1\):[\s\S]*Unknown provider "claude-agent"/);
  session.handleExit(1, null);
  await check;
});

test('handleExit rejects pending and notifies the manager once', async () => {
  const manager = makeManager();
  const session = new PiRpcSession(manager, { cwd: '/tmp' });
  session.child = { stdin: { writable: true, write: ((_d: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite } };
  const p = session.send({ type: 'get_session_stats' }, { timeoutMs: 100000 });
  const check = assert.rejects(p, /Pi process exited/);
  session.handleExit(1, null);
  await check;
  assert.equal(manager.removed.length, 1);
  assert.equal(manager.removed[0].id, session.id);
  // a second exit event is ignored
  session.handleExit(0, null);
  assert.equal(manager.removed.length, 1);
});

test('a signal-only exit is final even though its exit code is null', () => {
  const { session, manager } = makeSession();
  session.handleExit(null, 'SIGTERM');
  session.handleExit(null, 'SIGTERM');
  assert.equal(session.exited, true);
  assert.equal(manager.removed.length, 1);
});

test('handleLine parses JSON and routes responses vs events', () => {
  const { session, manager } = makeSession();
  session.handleLine(JSON.stringify({ type: 'response', id: 'nope', data: {} }));
  // unknown response id is a no-op for pending but still broadcast
  assert.equal(manager.broadcasts.length, 1);
  session.handleLine(JSON.stringify({ type: 'turn_start' }));
  assert.equal(session.isStreaming, true);
  // non-JSON lines are ignored without throwing
  session.handleLine('not json at all');
  session.handleLine('');
  assert.equal(session.isStreaming, true);
});

test('title is truncated at the first sentence-end punctuation inside the window', () => {
  const { session } = makeSession();
  session.handleEvent({
    type: 'message_start',
    message: { role: 'user', content: 'Fix the bug. Then deploy it everywhere please.' },
  });
  assert.equal(session.sessionName, 'Fix the bug');
});

test('snapshot and metadata expose the current session state', () => {
  const { session } = makeSession('openai/gpt-5.5:high');
  // Constructor canonicalizes the spec into a full object + level.
  assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-5.5' });
  assert.equal(session.thinkingLevel, 'high');
  session.isStreaming = true;
  session.sessionFile = '/tmp/s.jsonl';
  session.sessionName = 'Plan';
  const meta = session.metadata();
  assert.equal(meta.modelSpec, 'openai/gpt-5.5:high');
  assert.equal(meta.modelLabel, 'openai/gpt-5.5');
  assert.equal(meta.isStreaming, true);
  const snap = session.snapshot();
  assert.equal(snap.session.id, session.id);
  assert.equal(snap.isStreaming, true);
  assert.deepEqual(snap.entries, []);
});

test('normalizeModel parses provider/id strings and keeps full objects', () => {
  assert.equal(normalizeModel(null), null);
  assert.equal(normalizeModel(''), null);
  assert.deepEqual(normalizeModel('openai/gpt-4o'), { provider: 'openai', id: 'gpt-4o' });
  assert.deepEqual(normalizeModel('gpt-4o'), { provider: '', id: 'gpt-4o' });
  assert.deepEqual(normalizeModel({ provider: 'openai', id: 'gpt-4o', contextWindow: 128000 }), {
    provider: 'openai', id: 'gpt-4o', contextWindow: 128000,
  });
  assert.deepEqual(normalizeModel({ id: 'gpt-4o' }), { provider: '', id: 'gpt-4o' });
  assert.equal(normalizeModel({ foo: 'bar' }), null);
  // Model IDs containing slashes: split on first slash only.
  assert.deepEqual(normalizeModel('openrouter/z-ai/glm-5.2'), {
    provider: 'openrouter', id: 'z-ai/glm-5.2',
  });
});

test('parseModelSpecToModel parses provider/id[:level]', () => {
  assert.deepEqual(parseModelSpecToModel('openai/gpt-4o:high'), {
    model: { provider: 'openai', id: 'gpt-4o' }, level: 'high',
  });
  assert.deepEqual(parseModelSpecToModel('openai/gpt-4o'), {
    model: { provider: 'openai', id: 'gpt-4o' }, level: null,
  });
  assert.deepEqual(parseModelSpecToModel('openai/gpt-4o:max'), {
    model: { provider: 'openai', id: 'gpt-4o' }, level: 'max',
  });
  assert.deepEqual(parseModelSpecToModel(''), { model: null, level: null });
  // A colon followed by a non-level token is treated as part of the id, not a level.
  const r = parseModelSpecToModel('anthropic/claude-3.5:sonnet');
  assert.equal(r.level, null);
  assert.deepEqual(r.model, { provider: 'anthropic', id: 'claude-3.5:sonnet' });
  // Model IDs that themselves contain slashes (e.g. OpenRouter "z-ai/glm-5.2").
  assert.deepEqual(parseModelSpecToModel('openrouter/z-ai/glm-5.2:high'), {
    model: { provider: 'openrouter', id: 'z-ai/glm-5.2' }, level: 'high',
  });
  assert.deepEqual(parseModelSpecToModel('openrouter/z-ai/glm-5.2'), {
    model: { provider: 'openrouter', id: 'z-ai/glm-5.2' }, level: null,
  });
});

test('updateStateFromResponse stores a full {provider,id} object, never a bare string', () => {
  const { session } = makeSession();
  session.handleResponse({
    type: 'response', id: 'x', success: true,
    command: 'set_model',
    data: { model: { provider: 'openai', id: 'gpt-4o', contextWindow: 128000 } },
  });
  assert.equal(typeof session.model, 'object');
  assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-4o', contextWindow: 128000 });

  // A bare string model in a non-set_model response is normalized to an object.
  session.handleResponse({
    type: 'response', id: 'y', success: true,
    data: { model: 'anthropic/claude-3.5' },
  });
  assert.deepEqual(session.model, { provider: 'anthropic', id: 'claude-3.5' });

  // A null model (e.g. get_state before pi has a model) keeps the known model.
  session.handleResponse({
    type: 'response', id: 'z', success: true,
    command: 'get_state',
    data: { model: null },
  });
  assert.deepEqual(session.model, { provider: 'anthropic', id: 'claude-3.5' });
});

test('set_thinking_level echo: session.thinkingLevel updates even when pi returns no level', async () => {
  const { session } = makeSession('openai/gpt-4o');
  liveManager.sessions.set(session.id, session);
  try {
    session.child = { stdin: { writable: true, write: ((_d: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite } };
    session.send = (_command: RpcCommand, _opts: RpcOpts) =>
      Promise.resolve({ type: 'response', success: true, data: {} });
    const resp = await handleRpcCommand({
      type: 'set_thinking_level', level: 'high', sessionId: session.id,
    });
    assert.equal(resp.success, true);
    assert.equal(session.thinkingLevel, 'high');
  } finally {
    liveManager.sessions.delete(session.id);
  }
});

test('set_thinking_level restores previous level on pi failure', async () => {
  const { session } = makeSession('openai/gpt-4o:medium');
  liveManager.sessions.set(session.id, session);
  try {
    assert.equal(session.thinkingLevel, 'medium');
    session.child = { stdin: { writable: true, write: ((_d: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite } };
    session.send = (_command: RpcCommand, _opts: RpcOpts) =>
      Promise.resolve({ type: 'response', success: false, error: 'nope' });
    const resp = await handleRpcCommand({
      type: 'set_thinking_level', level: 'high', sessionId: session.id,
    });
    assert.equal(resp.success, false);
    assert.equal(session.thinkingLevel, 'medium');
  } finally {
    liveManager.sessions.delete(session.id);
  }
});

test('constructor accepts sessionFile, entries, and sessionName and they appear in snapshot/metadata', () => {
  const manager = makeManager();
  const entries = [{ type: 'message', message: { role: 'user', content: 'hello' } }, { type: 'message', message: { role: 'assistant', content: 'hi' } }];
  const session = new PiRpcSession(manager, {
    cwd: '/tmp',
    modelSpec: 'openai/gpt-4o',
    sessionFile: '/tmp/resumed.jsonl',
    entries,
    sessionName: 'Resumed Chat',
  });
  assert.equal(session.sessionFile, '/tmp/resumed.jsonl');
  assert.equal(session.sessionName, 'Resumed Chat');
  assert.equal(session.entries.length, 2);
  assert.deepEqual(session.entries[0], entries[0]);
  // Snapshot must include the pre-seeded fields.
  const snap = session.snapshot();
  assert.equal(snap.sessionFile, '/tmp/resumed.jsonl');
  assert.equal(snap.sessionName, 'Resumed Chat');
  assert.equal(snap.entries.length, 2);
  // Metadata must expose sessionFile and sessionName.
  const meta = session.metadata();
  assert.equal(meta.sessionFile, '/tmp/resumed.jsonl');
  assert.equal(meta.sessionName, 'Resumed Chat');
});

test('start() passes --session <file> and waits for state and tree responses', async (t: TestContext) => {
  const sessionFile = '/tmp/some-session.jsonl';
  const child = new FakePi({ sessionFile, autoRespond: false });
  const spawnArgs: Array<{ cmd: string; args: string[] }> = [];
  _setSpawnPiForTest((cmd: string, args: string[]) => {
    spawnArgs.push({ cmd, args });
    return child.asChild();
  });
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const starting = mgr.resume({ sessionFile, cwd: os.tmpdir(), model: 'openai/gpt-4o' });
  let completed = false;
  starting.then(() => { completed = true; });
  await flushIo();
  assert.equal(completed, false);
  assert.deepEqual(child.commands.map((command) => command.type), ['get_state']);
  child.respond(child.commands[0]);
  await flushIo();
  assert.equal(completed, false);
  assert.deepEqual(child.commands.map((command) => command.type), ['get_state', 'get_tree']);
  child.autoRespond = true;
  child.respond(child.commands[1]);
  await starting;
  assert.equal(spawnArgs.length, 1);
  const args = spawnArgs[0].args;
  assert.equal(args[args.indexOf('--mode') + 1], 'rpc');
  assert.equal(args[args.indexOf('--session') + 1], sessionFile);
  assert.equal(args[args.indexOf('--model') + 1], 'openai/gpt-4o');
  assert.deepEqual(child.commands.map((command) => command.type), ['get_state', 'get_tree', 'get_session_stats']);
});

test('startup only succeeds after get_state reports the current model', async (t: TestContext) => {
  const child = new FakePi({ autoRespond: false, state: { model: { provider: 'anthropic', id: 'claude-opus' }, thinkingLevel: 'medium' } });
  _setSpawnPiForTest(() => child.asChild());
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const broadcasts: BroadcastMsg[] = [];
  mgr.broadcast = (msg: BroadcastMsg) => { broadcasts.push(msg); };
  const starting = mgr.create({ cwd: os.tmpdir() });
  await flushIo();
  assert.equal(broadcasts.some((message) => message.type === 'live_session_created'), false);
  child.autoRespond = true;
  child.respond(child.commands[0]);
  const session = await starting;
  assert.deepEqual(session.model, { provider: 'anthropic', id: 'claude-opus' });
  assert.equal(session.thinkingLevel, 'medium');
  const created = broadcasts.find((message) => message.type === 'live_session_created');
  assert.deepEqual(created?.session?.model, { provider: 'anthropic', id: 'claude-opus' });
});

test('unsuccessful startup state waits for cleanup and reports childStopped only after exit', async (t: TestContext) => {
  const child = new FakePi({ autoRespond: false, exitOnSignal: null });
  _setSpawnPiForTest(() => child.asChild());
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  let rejected = false;
  const failing = assert.rejects(mgr.create({ cwd: os.tmpdir() }), (error: { message: string; childStopped: boolean }) => {
    rejected = true;
    assert.match(error.message, /startup state failed: invalid configuration/);
    assert.equal(error.childStopped, true);
    return true;
  });
  child.respond(child.commands[0], { success: false, error: 'invalid configuration' });
  await flushIo();
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(rejected, false);
  child.exit(null, 'SIGTERM');
  await failing;
  assert.equal(mgr.sessions.size, 0);
});

test('startup rejects a different session file and confirms cleanup', async (t: TestContext) => {
  const child = new FakePi({ sessionFile: '/tmp/wrong.jsonl' });
  _setSpawnPiForTest(() => child.asChild());
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  await assert.rejects(mgr.resume({ sessionFile: '/tmp/requested.jsonl', cwd: os.tmpdir() }), (error: { message: string; childStopped: boolean }) => {
    assert.match(error.message, /did not load the requested session/);
    assert.equal(error.childStopped, true);
    return true;
  });
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.commands.some((command) => command.type === 'get_tree'), false);
  assert.equal(mgr.sessions.size, 0);
});

test('an early startup exit retains stderr and never publishes a live session', async (t: TestContext) => {
  const child = new FakePi({ autoRespond: false });
  _setSpawnPiForTest(() => child.asChild());
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const failing = assert.rejects(mgr.create({ cwd: os.tmpdir() }), (error: { message: string; childStopped: boolean }) => {
    assert.match(error.message, /Unknown provider/);
    assert.equal(error.childStopped, true);
    return true;
  });
  child.stderr.write('Error: Unknown provider\n');
  child.exit(1);
  await failing;
  assert.equal(mgr.sessions.size, 0);
  assert.deepEqual(child.signals, []);
});

test('a child stdin error rejects startup without crashing the server or claiming exit early', async (t: TestContext) => {
  const child = new FakePi({ autoRespond: false, exitOnSignal: null });
  _setSpawnPiForTest(() => child.asChild());
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  let settled = false;
  const failing = assert.rejects(mgr.create({ cwd: os.tmpdir() }), { message: 'write EPIPE', childStopped: true }).then(() => { settled = true; });
  child.stdin.emit('error', new Error('write EPIPE'));
  await flushIo();
  assert.equal(settled, false);
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.exit(null, 'SIGTERM');
  await failing;
  assert.equal(mgr.sessions.size, 0);
});

test('spawn errors without a pid prove no child remains', async (t: TestContext) => {
  const child = new FakePi({ autoRespond: false });
  child.pid = undefined;
  _setSpawnPiForTest(() => child.asChild());
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const failing = assert.rejects(mgr.create({ cwd: os.tmpdir() }), { message: 'spawn pi ENOENT', childStopped: true });
  child.emit('error', new Error('spawn pi ENOENT'));
  await failing;
  assert.deepEqual(child.signals, []);
  assert.equal(mgr.sessions.size, 0);
});

test('a failed startup tree check is not accepted as a ready resumed session', async (t: TestContext) => {
  const sessionFile = '/tmp/tau-bad-tree.jsonl';
  const child = new FakePi({ sessionFile, autoRespond: false });
  _setSpawnPiForTest(() => child.asChild());
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const failing = assert.rejects(mgr.resume({ sessionFile, cwd: os.tmpdir() }), { childStopped: true });
  await flushIo();
  child.respond(child.commands[0]);
  await flushIo();
  assert.equal(child.commands[1].type, 'get_tree');
  child.respond(child.commands[1], { success: false, error: 'tree unavailable' });
  await failing;
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(mgr.sessions.size, 0);
});

test('startup deadline failure reaps the child before rejecting', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new FakePi({ autoRespond: false });
  _setSpawnPiForTest(() => child.asChild());
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const failing = assert.rejects(mgr.create({ cwd: os.tmpdir() }), { childStopped: true });
  t.mock.timers.tick(30000);
  await failing;
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(mgr.sessions.size, 0);
});

for (const command of ['prompt', 'steer', 'follow_up']) {
  test(`extension-refresh: ${command} acknowledgement refreshes state exactly once`, async (t) => {
    const child = new FakePi();
    _setSpawnPiForTest(() => child.asChild());
    t.after(() => _setSpawnPiForTest(null));
    const manager = new LiveSessionManager();
    const session = await manager.create({ cwd: os.tmpdir(), model: 'openai/gpt-4o:off' });
    liveManager.sessions.set(session.id, session);
    t.after(() => liveManager.sessions.delete(session.id));
    const broadcasts: BroadcastMsg[] = [];
    manager.broadcast = (message: BroadcastMsg) => broadcasts.push(message);
    child.commands.length = 0;
    child.state = { ...child.state, model: { provider: 'openai', id: 'gpt-4o-mini' }, thinkingLevel: 'high' };
    const response = await handleRpcCommand({
      type: command, message: '/session-model openai/gpt-4o-mini:high', sessionId: session.id,
    });
    await flushIo();
    assert.equal(response.success, true);
    assert.deepEqual(child.commands.map((item) => item.type), [command, 'get_state']);
    assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-4o-mini' });
    assert.equal(session.thinkingLevel, 'high');
    assert.ok(broadcasts.some((message) => message.type === 'live_session_updated'
      && message.session?.thinkingLevel === 'high'));
  });
}

for (const restored of [true, false]) {
  test(`late input acknowledgement refreshes the file after ${restored ? 'rollback' : 'session replacement'} without an ownership gap`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const original = '/tmp/tau-switch-original.jsonl';
    const temporary = '/tmp/tau-switch-temporary.jsonl';
    const child = new FakePi({ sessionFile: original });
    _setSpawnPiForTest(() => child.asChild());
    t.after(() => _setSpawnPiForTest(null));
    const manager = new LiveSessionManager();
    const session = await manager.create({ cwd: os.tmpdir() });
    liveManager.sessions.set(session.id, session);
    t.after(() => liveManager.sessions.delete(session.id));
    child.autoRespond = false;
    child.commands.length = 0;
    const pending = handleRpcCommand({ type: 'prompt', message: '/switch herdr', sessionId: session.id });
    const prompt = child.commands[0];
    t.mock.timers.tick(10000);
    assert.equal((await pending).success, true, 'HTTP timeout is not command completion');
    assert.equal(session.pending.has(prompt.id), false);
    // An unrelated get_state observes the temporary replacement while the
    // extension command is still running. The original remains associated.
    session.handleResponse({ type: 'response', command: 'get_state', success: true, data: { sessionFile: temporary } });
    assert.equal(session.sessionFile, temporary);
    assert.equal(manager.findBySessionFile(original), session);
    assert.equal((await manager.resume({ sessionFile: original, cwd: os.tmpdir() })).started, false);
    child.state.sessionFile = restored ? original : temporary;
    child.respond(prompt);
    await flushIo();
    assert.deepEqual(child.commands.map((item) => item.type), ['prompt', 'get_state']);
    assert.equal(manager.findBySessionFile(original), session, 'keep ownership until the post-command refresh responds');
    child.respond(child.commands[1]);
    await flushIo();
    assert.equal(session.sessionFile, child.state.sessionFile);
    assert.equal(manager.findBySessionFile(original), restored ? session : undefined);
    assert.equal(manager.findBySessionFile(child.state.sessionFile), session);
    if (restored) assert.equal((await manager.resume({ sessionFile: original, cwd: os.tmpdir() })).started, false);
  });
}

for (const failure of ['timeout', 'unsuccessful']) {
  test(`an unconfirmed post-input state (${failure}) retains the original file until exit`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const original = '/tmp/tau-unconfirmed-original.jsonl';
    const child = new FakePi({ sessionFile: original });
    _setSpawnPiForTest(() => child.asChild());
    t.after(() => _setSpawnPiForTest(null));
    const manager = new LiveSessionManager();
    const session = await manager.create({ cwd: os.tmpdir() });
    child.autoRespond = false;
    child.commands.length = 0;
    const sent = session.send({ type: 'prompt', message: '/switch herdr' });
    session.handleResponse({ type: 'response', command: 'get_state', success: true, data: { sessionFile: '/tmp/temporary.jsonl' } });
    child.respond(child.commands[0]);
    await sent;
    if (failure === 'timeout') t.mock.timers.tick(5000);
    else child.respond(child.commands[1], { success: false, data: undefined, error: 'state unavailable' });
    await flushIo();
    assert.equal(manager.findBySessionFile(original), session);
    assert.equal((await manager.resume({ sessionFile: original, cwd: os.tmpdir() })).started, false);
    child.exit();
    assert.equal(manager.findBySessionFile(original), undefined);
  });
}
