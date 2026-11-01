import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { FakePimux, until } from './fake-pimux.ts';
import { FakePi } from './fake-pi.ts';
import type { JsonRecord } from '../src/server/types.ts';

process.env.TAU_HOST = '127.0.0.1';
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pimux-tmp-'));
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pimux-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
process.env.PIMUX_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'mux');
process.env.TAU_USER = '';
process.env.TAU_PASS = '';
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ tau: { authEnabled: false } }));

const { server, liveManager, SESSIONS_DIR, _setSpawnPiForTest, handleRpcCommand } = (await import('../bin/tau.js')) as any;
const { AgentOverview } = (await import('../bin/agents.js')) as any;
const { PimuxAttachment } = (await import('../bin/pimux-attachment.js')) as any;
const { buildAgentGroups } = (await import('../public/agents-panel.js')) as any;

const MUX_DIR = process.env.PIMUX_DIR;
const PROJECT = path.join(process.env.PI_CODING_AGENT_DIR, 'project');
const PROJECT_SESSIONS = path.join(SESSIONS_DIR, '--project--');
let base = '';
let muxes: FakePimux[] = [];
const browserMessages: JsonRecord[] = [];
const browser = { readyState: 1, send: (payload: string) => browserMessages.push(JSON.parse(payload)), close() {}, terminate() {}, ping() {} };

before(async () => {
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(PROJECT_SESSIONS, { recursive: true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  liveManager.addClient(browser);
});

after(async () => {
  await liveManager.shutdown();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

afterEach(async () => {
  await liveManager.shutdown();
  for (const mux of muxes) await mux.close();
  muxes = [];
  browserMessages.length = 0;
  _setSpawnPiForTest(null);
});

/** Spawning Pi in these tests means a second writer: fail loudly. */
function forbidSpawn() {
  _setSpawnPiForTest(() => { throw new Error('Tau spawned a Pi on a pimux-shared file'); });
}

function sessionFile(name: string) {
  const file = path.join(PROJECT_SESSIONS, `${name}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: name, cwd: PROJECT }) + '\n');
  return file;
}

async function sharedSession(name: string, options: JsonRecord = {}) {
  const file = sessionFile(name);
  const mux = new FakePimux(MUX_DIR!, `mux-${name}`, { sessionFile: file, cwd: PROJECT, ...options });
  mux.entries = [{ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'from emacs' } }];
  mux.leafId = 'u1';
  await mux.listen();
  muxes.push(mux);
  return { file, mux };
}

async function post(route: string, body: unknown) {
  const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as JsonRecord };
}

test('resume of a pimux-shared file attaches instead of spawning a second writer', async () => {
  forbidSpawn();
  const { file, mux } = await sharedSession('resume');
  const first = await post('/api/live-sessions/resume', { filePath: file });
  assert.equal(first.status, 200, String(first.body.error));
  assert.equal(first.body.attached, true);
  assert.equal(first.body.started, true);
  const session = first.body.session as JsonRecord;
  assert.equal((session.attached as JsonRecord).muxId, mux.muxId);
  assert.equal(session.pid, null, 'an attached tab owns no process');
  const live = liveManager.get(session.id);
  assert.deepEqual(live.entries.map((entry: JsonRecord) => entry.type), ['session', 'message'], 'history comes from the snapshot tree');
  const again = await post('/api/live-sessions/resume', { filePath: file });
  assert.equal(again.body.reused, true);
  assert.equal((again.body.session as JsonRecord).id, session.id);
  // Creating a tab on the file uses the same resolution.
  const created = await post('/api/live-sessions', { cwd: PROJECT, sessionFile: file });
  assert.equal(created.status, 200, String(created.body.error));
  assert.equal((created.body.session as JsonRecord).id, session.id);
  assert.equal(mux.connections.size, 1);
});

test('attach by mux id, refresh refusal and session-opening args', async () => {
  forbidSpawn();
  const { file, mux } = await sharedSession('byid');
  const attached = await post('/api/live-sessions/attach', { muxId: mux.muxId });
  assert.equal(attached.status, 200, String(attached.body.error));
  assert.equal(attached.body.started, true);
  const refresh = await post('/api/live-sessions/resume', { filePath: file, refresh: true });
  assert.equal(refresh.status, 409);
  assert.match(String(refresh.body.error), /always current/);
  const args = await post('/api/live-sessions', { cwd: PROJECT, args: ['--session', file] });
  assert.equal(args.status, 400);
  assert.match(String(args.body.error), /must not open a session/);
  const missing = await post('/api/live-sessions/attach', { muxId: 'nope' });
  assert.equal(missing.status, 404);
});

function deadPid() {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
}

test('a starting pimux is matched by its intended file: Tau attaches once it listens', async () => {
  forbidSpawn();
  const file = sessionFile('starting');
  const mux = new FakePimux(MUX_DIR!, 'mux-starting', { sessionFile: file, cwd: PROJECT, status: 'starting', piPid: null });
  muxes.push(mux);
  const opening = post('/api/live-sessions/resume', { filePath: file });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(liveManager.sessions.size, 0, 'nothing opens while it starts');
  await mux.listen();
  const opened = await opening;
  assert.equal(opened.status, 200, String(opened.body.error));
  assert.equal(opened.body.attached, true);
  assert.equal(((opened.body.session as JsonRecord).attached as JsonRecord).muxId, 'mux-starting');
});

test('a pimux that never finishes starting fails closed, never spawning', async (t) => {
  forbidSpawn();
  const waited = liveManager.pimuxStartWaitMs;
  liveManager.pimuxStartWaitMs = 100;
  t.after(() => { liveManager.pimuxStartWaitMs = waited; });
  const file = sessionFile('stuck');
  muxes.push(new FakePimux(MUX_DIR!, 'mux-stuck', { sessionFile: file, cwd: PROJECT, status: 'starting', piPid: null }));
  for (const open of [() => post('/api/live-sessions/resume', { filePath: file }), () => post('/api/live-sessions', { cwd: PROJECT, sessionFile: file }), () => post('/api/live-sessions/attach', { muxId: 'mux-stuck' })]) {
    const refused = await open();
    assert.equal(refused.status, 409, String(refused.body.error));
    assert.equal(refused.body.muxId, 'mux-stuck');
  }
  assert.equal(liveManager.sessions.size, 0);
});

test('a stale entry does not hide the live pimux of the same file', async () => {
  forbidSpawn();
  const { file, mux } = await sharedSession('beside');
  const stale = new FakePimux(MUX_DIR!, 'a-stale', { sessionFile: file, cwd: PROJECT, pid: deadPid(), piPid: deadPid() });
  muxes.push(stale);
  const opened = await post('/api/live-sessions/resume', { filePath: file });
  assert.equal(opened.status, 200, String(opened.body.error));
  assert.equal(((opened.body.session as JsonRecord).attached as JsonRecord).muxId, mux.muxId);
});

test('deleting a session: a live pimux refuses, a stale entry does not', async () => {
  const { file, mux } = await sharedSession('delete-live');
  assert.equal((await post('/api/sessions/delete', { filePath: file })).status, 409);
  mux.publish({ status: 'starting' });
  assert.equal((await post('/api/sessions/delete', { filePath: file })).status, 409);
  await mux.close();
  muxes = muxes.filter((item) => item !== mux);
  const staleFile = sessionFile('delete-stale');
  muxes.push(new FakePimux(MUX_DIR!, 'mux-delete-stale', { sessionFile: staleFile, cwd: PROJECT, pid: deadPid(), piPid: deadPid() }));
  const deleted = await post('/api/sessions/delete', { filePath: staleFile });
  assert.equal(deleted.status, 200, String(deleted.body.error));
  assert.equal(fs.existsSync(staleFile), false);
});

function collectingAttachment() {
  const applied: JsonRecord[] = [];
  return { applied, attachment: new PimuxAttachment('mux', '/nowhere', (published: JsonRecord) => applied.push(published)) };
}
const snapshotRecord = (generation: number, replay: number) => ({ type: 'pimux_snapshot', generation, replay, reason: 'request' });
const replayed = { type: 'message_update', delta: 'stale' };

for (const interruption of [
  { type: 'pimux_gap', generation: 8, dropped: 3 },
  snapshotRecord(8, 1),
]) {
  test(`a sequence cut short by ${interruption.type} is discarded and the next one published`, async () => {
    const { attachment, applied } = collectingAttachment();
    const waited = attachment.waitFor(7, 1000);
    attachment.handle(snapshotRecord(7, 2));
    attachment.handle(replayed);
    assert.equal(attachment.handle(interruption), true);
    if (interruption.type === 'pimux_gap') attachment.handle(snapshotRecord(8, 1));
    attachment.handle({ type: 'tool_execution_start', toolCallId: 'fresh' });
    assert.equal(attachment.handle({ type: 'pimux_live', generation: 7 }), true, 'the old end is no end of the new sequence');
    attachment.handle(snapshotRecord(9, 1));
    attachment.handle({ type: 'tool_execution_start', toolCallId: 'fresh' });
    attachment.handle({ type: 'pimux_live', generation: 9 });
    await waited;
    assert.equal(applied.length, 1);
    assert.equal((applied[0].snapshot as JsonRecord).generation, 9);
    assert.deepEqual(applied[0].replay, [{ type: 'tool_execution_start', toolCallId: 'fresh' }]);
    assert.equal(attachment.handle({ type: 'agent_start' }), false, 'records flow live again');
  });
}

test('a failed or ended sequence leaves the attachment live', async () => {
  const failed = collectingAttachment();
  const waited = failed.attachment.waitFor(5, 1000);
  failed.attachment.handle(snapshotRecord(5, 1));
  failed.attachment.handle(replayed);
  failed.attachment.handle({ type: 'pimux_snapshot_failed', generation: 5, error: 'no answer' });
  await assert.rejects(waited, /no answer/);
  assert.equal(failed.attachment.handle({ type: 'agent_start' }), false);
  const ended = collectingAttachment();
  ended.attachment.handle(snapshotRecord(5, 1));
  assert.equal(ended.attachment.handle({ type: 'pimux_exit', code: 0, signal: null, stderrTail: '' }), false, 'the session handles the exit');
  assert.equal(ended.attachment.exit.code, 0);
});

test('records beyond the announced replay end the sequence instead of accumulating', () => {
  const { attachment, applied } = collectingAttachment();
  attachment.handle(snapshotRecord(5, 1));
  assert.equal(attachment.handle(replayed), true);
  assert.equal(attachment.handle({ type: 'agent_start' }), false);
  assert.equal(attachment.handle({ type: 'agent_end' }), false);
  attachment.handle({ type: 'pimux_live', generation: 5 });
  assert.equal(applied.length, 0);
});

test('an attached tab recovers from an interrupted sequence through the live socket', async () => {
  forbidSpawn();
  const { mux } = await sharedSession('interrupted');
  const opened = await post('/api/live-sessions/attach', { muxId: mux.muxId });
  const session = liveManager.get((opened.body.session as JsonRecord).id);
  browserMessages.length = 0;
  mux.broadcast(snapshotRecord(++mux.generation, 2));
  mux.broadcast(replayed);
  mux.broadcast({ type: 'pimux_gap', generation: ++mux.generation, dropped: 9 });
  for (const socket of mux.connections) mux.snapshot(socket, 'gap', mux.generation);
  await until(() => session.attachment.appliedGeneration === mux.generation, 'the gap snapshot is published');
  assert.ok(browserMessages.every((message) => JSON.stringify(message).indexOf('stale') === -1), 'nothing of the old sequence reached browsers');
  assert.equal(browserMessages.filter((message) => message.type === 'live_session_snapshot').length, 1);
  await session.snapshot();
  assert.equal(session.attachment.appliedGeneration, mux.generation, 'later snapshots still complete');
});

test('Tau stopping is no detach: browsers keep what the user wrote for the agent', async () => {
  forbidSpawn();
  const { mux } = await sharedSession('shutdown');
  await post('/api/live-sessions/attach', { muxId: mux.muxId });
  browserMessages.length = 0;
  await liveManager.shutdown();
  assert.deepEqual(browserMessages.filter((message) => message.type === 'live_session_closed').map((message) => message.reason), ['server_shutdown']);
});

test('a browser that stopped reading is dropped, and the others keep receiving', () => {
  const stalled = { readyState: 1, bufferedAmount: liveManager.maxClientBacklogBytes + 1, sent: 0, terminated: 0,
    send() { this.sent++; }, close() {}, terminate() { this.terminated++; }, ping() {} };
  const reading = { readyState: 1, bufferedAmount: liveManager.maxClientBacklogBytes, sent: 0, terminated: 0,
    send() { this.sent++; }, close() {}, terminate() { this.terminated++; }, ping() {} };
  liveManager.addClient(stalled);
  liveManager.addClient(reading);
  liveManager.broadcast({ type: 'x' });
  liveManager.broadcast({ type: 'y' });
  liveManager.removeClient(reading);
  assert.deepEqual([stalled.sent, stalled.terminated, reading.sent, reading.terminated], [0, 1, 2, 0]);
  assert.equal(liveManager.clients.has(stalled), false);
});

test('a known but unreachable pimux fails closed; a stale one does not block', async (t) => {
  const file = sessionFile('unreachable');
  // The wrapper lives (this process) but its socket does not exist yet.
  const starting = new FakePimux(MUX_DIR!, 'mux-unreachable', { sessionFile: file, cwd: PROJECT });
  muxes.push(starting);
  forbidSpawn();
  const refused = await post('/api/live-sessions/resume', { filePath: file });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.muxId, 'mux-unreachable');
  assert.equal(liveManager.sessions.size, 0);
  // A dead wrapper and Pi: the entry is stale and the file may be opened.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  starting.publish({ pid: Number(dead), piPid: Number(dead) });
  const child = new FakePi();
  _setSpawnPiForTest((_cmd: string, args: string[]) => {
    child.state.sessionFile = args[args.indexOf('--session') + 1];
    return child.asChild();
  });
  t.after(() => _setSpawnPiForTest(null));
  const resumed = await post('/api/live-sessions/resume', { filePath: file });
  assert.equal(resumed.status, 200, String(resumed.body.error));
  assert.equal(resumed.body.attached, undefined);
});

test('selection bootstraps a boundary: snapshot first, then replay, with open dialogs', async () => {
  forbidSpawn();
  const { mux } = await sharedSession('boot');
  const { body } = await post('/api/live-sessions/attach', { muxId: mux.muxId });
  const id = (body.session as JsonRecord).id as string;
  mux.idle = false;
  mux.replay = [
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'extension_ui_request', id: 'd1', method: 'select', title: 'Pick', options: ['a', 'b'] },
  ];
  browserMessages.length = 0;
  const response = await fetch(`${base}/api/live-sessions/${encodeURIComponent(id)}/snapshot`);
  const snapshot = await response.json() as JsonRecord;
  assert.equal(response.status, 200);
  const bootstrap = mux.commands.find((command) => command.type === 'pimux_bootstrap')!;
  assert.deepEqual(bootstrap.include, ['entries']);
  assert.equal(snapshot.generation, mux.generation);
  assert.equal(snapshot.isStreaming, true);
  assert.deepEqual((snapshot.dialogs as JsonRecord[]).map((dialog) => dialog.id), ['d1']);
  const forSession = browserMessages.filter((message) => message.sessionId === id && (message.event as JsonRecord | undefined)?.type !== 'response');
  assert.deepEqual(forSession.map((message) => message.type === 'event' ? (message.event as JsonRecord).type : message.type),
    ['live_session_snapshot', 'agent_start', 'message_start'], 'dialogs travel in the snapshot, not as replayed events');
  mux.broadcast({ type: 'pimux_dialog_closed', id: 'd1', reason: 'answered', clientId: 9 });
  await until(() => liveManager.get(id).attachment.dialogs.size === 0, 'dialog closed');
  assert.ok(browserMessages.some((message) => (message.event as JsonRecord | undefined)?.type === 'pimux_dialog_closed'));
});

test('renames go through the Pi that writes the file; deleting a live file is refused', async () => {
  forbidSpawn();
  const { file, mux } = await sharedSession('rename');
  const before = fs.readFileSync(file, 'utf8');
  const renamed = await handleRpcCommand({ type: 'set_session_name', filePath: file, name: 'Shared title' });
  assert.equal(renamed.success, true, renamed.error);
  assert.equal(mux.commands.find((command) => command.type === 'set_session_name')?.name, 'Shared title');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'Tau never appended to the shared file');
  const deleted = await post('/api/sessions/delete', { filePath: file });
  assert.equal(deleted.status, 409);
  assert.ok(fs.existsSync(file));
  const { body } = await post('/api/live-sessions/resume', { filePath: file });
  assert.equal((await post('/api/sessions/delete', { filePath: file })).status, 409);
  const tree = await handleRpcCommand({ type: 'navigate_tree', sessionId: (body.session as JsonRecord).id, entryId: 'u1' });
  assert.equal(tree.success, false);
  assert.match(tree.error, /not available in a shared session/);
  const listing = await (await fetch(`${base}/api/sessions/--project--`)).json() as { sessions: JsonRecord[] };
  assert.equal(listing.sessions.find((session) => session.filePath === file)?.shared, mux.muxId);
});

test('closing an attached tab only disconnects', async () => {
  forbidSpawn();
  const { mux } = await sharedSession('detach');
  const { body } = await post('/api/live-sessions/attach', { muxId: mux.muxId });
  const id = (body.session as JsonRecord).id as string;
  assert.equal(mux.connections.size, 1);
  const response = await fetch(`${base}/api/live-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  await until(() => mux.connections.size === 0, 'socket closed');
  assert.equal(liveManager.get(id), undefined);
  const closed = browserMessages.find((message) => message.type === 'live_session_closed' && message.sessionId === id)!;
  assert.equal(closed.reason, 'detached');
  assert.equal(closed.message, undefined);
});

test('pimux_exit closes the tab with Pi\'s stderr; a lost connection says Pi may still run', async () => {
  forbidSpawn();
  const { mux } = await sharedSession('exit');
  let { body } = await post('/api/live-sessions/attach', { muxId: mux.muxId });
  let id = (body.session as JsonRecord).id as string;
  mux.broadcast({ type: 'pimux_exit', code: 1, signal: null, stderrTail: 'Error: provider exploded' });
  mux.drop();
  let closed = await until(() => browserMessages.find((message) => message.type === 'live_session_closed' && message.sessionId === id), 'exit close');
  assert.equal(closed.reason, 'pimux_exit:1');
  assert.match(String(closed.message), /Pi process exited \(1\):\nError: provider exploded/);
  assert.equal(closed.notice, false, 'a failure is an error');
  ({ body } = await post('/api/live-sessions/attach', { muxId: mux.muxId }));
  id = (body.session as JsonRecord).id as string;
  mux.broadcast({ type: 'pimux_exit', code: 0, signal: null, stderrTail: '' });
  mux.drop();
  closed = await until(() => browserMessages.find((message) => message.type === 'live_session_closed' && message.sessionId === id), 'orderly close');
  assert.equal(closed.notice, true, 'an orderly close is news');
  ({ body } = await post('/api/live-sessions/attach', { muxId: mux.muxId }));
  id = (body.session as JsonRecord).id as string;
  mux.drop();
  closed = await until(() => browserMessages.find((message) => message.type === 'live_session_closed' && message.sessionId === id), 'drop close');
  assert.equal(closed.reason, 'pimux_disconnected');
  assert.match(String(closed.message), /may still be running/);
  // The entry still names a live wrapper: reopening attaches again, never spawns.
  const again = await post('/api/live-sessions/attach', { muxId: mux.muxId });
  assert.equal(again.status, 200, String(again.body.error));
});

test('foreign events update shared tab state', async () => {
  forbidSpawn();
  const { mux } = await sharedSession('events');
  const { body } = await post('/api/live-sessions/attach', { muxId: mux.muxId });
  const session = liveManager.get((body.session as JsonRecord).id);
  // The owning frontend names a shared agent; a prompt there must not rename its tab.
  mux.broadcast({ type: 'message_start', message: { role: 'user', content: 'a prompt typed in Emacs' } });
  mux.broadcast({ type: 'agent_end' });
  mux.broadcast({ type: 'pimux_model_changed', model: { provider: 'fx', id: 'two' }, previousModel: null, source: 'set' });
  mux.broadcast({ type: 'thinking_level_changed', level: 'high' });
  await until(() => session.model?.id === 'two', 'model');
  assert.equal(session.sessionName, null);
  mux.broadcast({ type: 'session_info_changed', name: 'Named in Emacs' });
  await until(() => session.sessionName === 'Named in Emacs', 'name');
  assert.deepEqual(session.model, { provider: 'fx', id: 'two' });
  assert.equal(session.thinkingLevel, 'high');
  const other = sessionFile('events-new');
  mux.broadcast({ type: 'pimux_session_changed', generation: 99, reason: 'new', sessionFile: other, previousSessionFile: null, sessionId: 'x', sessionName: null, cwd: PROJECT });
  await until(() => session.sessionFile === other, 'session change');
  assert.equal(liveManager.findBySessionFile(other), session);
});

test('a gap rebuilds every view from the snapshot that follows', async () => {
  forbidSpawn();
  const { mux } = await sharedSession('gap');
  const { body } = await post('/api/live-sessions/attach', { muxId: mux.muxId });
  const id = (body.session as JsonRecord).id as string;
  const session = liveManager.get(id);
  mux.broadcast({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'lost later' }] } });
  await until(() => session.entries.length === 3, 'tracked message');
  browserMessages.length = 0;
  mux.entries = [];
  mux.leafId = null;
  mux.broadcast({ type: 'pimux_gap', generation: mux.generation + 1, dropped: 7 });
  for (const socket of mux.connections) mux.snapshot(socket, 'gap');
  await until(() => browserMessages.some((message) => message.type === 'live_session_snapshot'), 'snapshot after the gap');
  assert.deepEqual(session.entries.map((entry: JsonRecord) => entry.type), ['session']);
});

test('a shared session rebuilds a deep active path from flat entries, and leaves abandoned branches out', async () => {
  const { file, mux } = await sharedSession('deep');
  const line = Array.from({ length: 5000 }, (_, index) => ({ type: 'message', id: `e${index}`, parentId: index ? `e${index - 1}` : null,
    message: { role: 'user', content: `entry ${index}` } }));
  mux.entries = [...line, { type: 'message', id: 'abandoned', parentId: 'e10', message: { role: 'user', content: 'other branch' } }];
  mux.leafId = 'e4999';
  const { body } = await post('/api/live-sessions/resume', { filePath: file });
  const session = liveManager.get((body.session as JsonRecord).id as string);
  assert.equal(session.entries.filter((entry: JsonRecord) => entry.type === 'message').length, 5000);
  assert.equal(session.entries.some((entry: JsonRecord) => entry.id === 'abandoned'), false);
});

test('a change without history shows the new identity, no old conversation and a visible error', async () => {
  const { file, mux } = await sharedSession('no-history');
  const { body } = await post('/api/live-sessions/resume', { filePath: file });
  const id = (body.session as JsonRecord).id as string;
  const session = liveManager.get(id);
  browserMessages.length = 0;
  mux.entries = undefined;
  mux.extraSnapshot = { historyError: 'Invalid string length' };
  mux.leafId = 'elsewhere';
  for (const socket of mux.connections) mux.snapshot(socket, 'session_changed');
  await until(() => browserMessages.some((message) => (message.event as JsonRecord | undefined)?.notifyType === 'error'), 'history error');
  assert.deepEqual(session.entries.map((entry: JsonRecord) => entry.type), ['session']);
  const notice = browserMessages.find((message) => (message.event as JsonRecord | undefined)?.notifyType === 'error')!;
  assert.match(String((notice.event as JsonRecord).message), /history could not be loaded: Invalid string length/);
});

test('a snapshot failure on attach reports the reason at once', async () => {
  const { file, mux } = await sharedSession('failing');
  mux.failSnapshots = 'Invalid string length';
  const started = Date.now();
  const { status, body } = await post('/api/live-sessions/resume', { filePath: file });
  assert.equal(status, 503);
  assert.match(String(body.error), /could not take a snapshot: Invalid string length/);
  assert.ok(Date.now() - started < 5000, 'no timeout wait');
});

test('a stale pimux entry does not hide a terminal owner; a live one attaches despite force', async () => {
  const file = sessionFile('stale-owner');
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
  const stale = new FakePimux(MUX_DIR!, 'mux-stale', { sessionFile: file, cwd: PROJECT, pid: dead, piPid: dead });
  muxes.push(stale);
  const registry = path.join(process.env.TMPDIR!, 'pi-orchestration-targets');
  fs.mkdirSync(registry, { recursive: true });
  const record = path.join(registry, 'worker.json');
  fs.writeFileSync(record, JSON.stringify({ target: { host: 'tmux', name: 'w1', sessionFile: file } }));
  forbidSpawn();
  const refused = await post('/api/live-sessions/resume', { filePath: file });
  assert.equal(refused.status, 409);
  assert.equal((refused.body.owner as JsonRecord).host, 'tmux');
  fs.rmSync(record);
  const { file: shared } = await sharedSession('force');
  const forced = await post('/api/live-sessions/resume', { filePath: shared, force: true });
  assert.equal(forced.status, 200, String(forced.body.error));
  assert.equal(forced.body.attached, true);
});

test('spawned tabs do not inherit orchestration placement or parent', async (t) => {
  let env: Record<string, string> = {};
  const child = new FakePi({ sessionFile: '' });
  _setSpawnPiForTest((_cmd: string, _args: string[], options: { env: Record<string, string> }) => { env = options.env; return child.asChild(); });
  t.after(() => _setSpawnPiForTest(null));
  process.env.PI_ORCHESTRATION_PLACEMENT = 'worker';
  process.env.PI_ORCHESTRATION_PARENT = '{"host":"emacs"}';
  try {
    const session = await liveManager.create({ cwd: PROJECT });
    assert.equal(env.PI_ORCHESTRATION_PLACEMENT, undefined);
    assert.equal(env.PI_ORCHESTRATION_PARENT, undefined);
    assert.equal(env.PI_ORCHESTRATION_HOST, 'web');
    await liveManager.delete(session.id);
  } finally {
    delete process.env.PI_ORCHESTRATION_PLACEMENT;
    delete process.env.PI_ORCHESTRATION_PARENT;
  }
});

test('the overview nests workers, marks finished work done until seen, and links tabs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-overview-'));
  fs.chmodSync(dir, 0o700);
  const parentRef = { host: 'emacs', endpoint: '/tmp/emacs-test', id: '*pi:root*' };
  const root = new FakePimux(dir, 'root', { sessionFile: null, cwd: '/w/a', orchestration: parentRef, status: 'working' });
  const worker = new FakePimux(dir, 'worker', { sessionFile: null, cwd: '/w/a', placement: 'worker', parent: { ...parentRef, name: '*pi:root*' },
    orchestration: { host: 'emacs', endpoint: '/tmp/emacs-test', id: 'do-1' }, status: 'blocked', blocked: { reason: 'worker-waiting' } });
  const other = new FakePimux(dir, 'other', { sessionFile: null, cwd: '/w/b', status: 'idle' });
  const named = new FakePimux(dir, 'named', { sessionFile: null, cwd: '/w/c', status: 'idle', orchestration: { host: 'emacs', endpoint: '/e', id: '*pilish-chat:/w/c/<main>*' } });
  const plain = new FakePimux(dir, 'plain', { sessionFile: null, cwd: '/w/d', status: 'idle', orchestration: { host: 'emacs', endpoint: '/e', id: '*pilish-chat:/w/d/*' } });
  const opaque = new FakePimux(dir, 'opaque', { sessionFile: null, cwd: '/w/c', status: 'idle', placement: 'worker', orchestration: { host: 'emacs', endpoint: '/e', id: '0af625ed-4899-46bc-83b0-243fefaa51a7' } });
  const updates: JsonRecord[][] = [];
  const overview = new AgentOverview({ dir, tabFor: (muxId: string) => muxId === 'other' ? 'tab-1' : null, onChange: (agents: JsonRecord[]) => updates.push(agents) });
  overview.refresh();
  const byId = (id: string) => overview.list().find((agent: JsonRecord) => agent.muxId === id);
  assert.equal(byId('worker').parentId, 'root');
  assert.equal(byId('worker').detail, 'waiting for you');
  assert.equal(byId('other').tabId, 'tab-1');
  assert.equal(byId('named').name, 'main', 'an Emacs buffer name reads as its agent');
  assert.equal(byId('plain').name, 'd', 'an unnamed chat reads as its directory');
  assert.equal(byId('opaque').name, 'worker 0af625ed');
  assert.equal(byId('worker').name, 'do-1');
  root.publish({ status: 'idle' });
  overview.refresh();
  assert.equal(byId('root').status, 'done');
  overview.refresh();
  assert.equal(byId('root').status, 'done', 'done lasts until seen');
  overview.markSeen('root');
  assert.equal(byId('root').status, 'idle');
  const groups = buildAgentGroups(overview.list());
  assert.deepEqual(groups.map((group: JsonRecord) => group.cwd), ['/w/a', '/w/b', '/w/c', '/w/d'], 'the group with a blocked worker comes first');
  assert.equal(groups[0].nodes[0].agent.muxId, 'root');
  assert.equal(groups[0].nodes[0].children[0].agent.muxId, 'worker');
  assert.ok(updates.length >= 3);
  for (const mux of [root, worker, other, named, plain, opaque]) await mux.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
