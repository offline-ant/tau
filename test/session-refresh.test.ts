import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { LiveSessionManager, _setSpawnPiForTest } from '../bin/sessions.js';
import type { RpcCommand, RpcResponse } from '../src/server/types.ts';
import { FakePi, flushIo } from './fake-pi.ts';

class RefreshPi extends FakePi {
  override respond(command: RpcCommand, response: RpcResponse = {}) {
    super.respond(command, command.type === 'switch_session' ? { data: { cancelled: false }, ...response } : response);
  }
}

async function fixture(t: TestContext) {
  const file = '/tmp/tau-refresh.jsonl';
  const child = new RefreshPi({ sessionFile: file, state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } });
  let spawned = 0;
  _setSpawnPiForTest(() => { spawned++; return child.asChild(); });
  t.after(() => _setSpawnPiForTest(null));
  const manager = new LiveSessionManager();
  const options = { sessionFile: file, cwd: os.tmpdir() };
  const { session } = await manager.resume(options);
  t.after(() => manager.shutdown());
  return { child, manager, session, options, spawned: () => spawned };
}

test('refresh reloads the same child, its active branch and authoritative metadata', async (t) => {
  const { child, manager, session, options, spawned } = await fixture(t);
  const header = { type: 'session', id: 'conversation' };
  session.entries = [header, { type: 'message', id: 'stale' }];
  session.contextUsage = { tokens: { total: 999 } };
  session.sessionName = 'Old name';
  session.userMessages = ['stale user'];
  session.titleSet = true;
  const root = { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'latest question' } };
  const answer = { type: 'message', id: 'answer', parentId: 'root', message: { role: 'assistant', content: 'latest answer' } };
  const other = { type: 'message', id: 'other', parentId: 'root', message: { role: 'assistant', content: 'abandoned' } };
  child.tree = [{ entry: root, children: [{ entry: answer }, { entry: other }] }];
  child.leafId = 'answer';
  child.state.model = { provider: 'example', id: 'fresh-model' };
  child.state.thinkingLevel = 'high';
  const broadcasts: string[] = [];
  manager.addClient({ readyState: 1, send: (text: string) => broadcasts.push(text) });
  const start = child.commands.length;
  const result = await manager.resume({ ...options, refresh: true });
  assert.equal(result.session, session);
  assert.equal(result.started, false);
  assert.equal(result.refreshed, true);
  assert.equal(spawned(), 1);
  assert.equal(manager.sessions.size, 1);
  assert.deepEqual(child.commands.slice(start).map((command) => command.type), ['get_state', 'switch_session', 'get_state', 'get_tree']);
  assert.equal(child.commands[start + 1].sessionPath, options.sessionFile);
  assert.deepEqual(session.entries, [header, root, answer]);
  assert.deepEqual(session.model, { provider: 'example', id: 'fresh-model' });
  assert.equal(session.thinkingLevel, 'high');
  assert.equal(session.sessionName, null);
  assert.equal(session.contextUsage, null);
  assert.deepEqual(session.userMessages, []);
  assert.equal(session.titleSet, false);
  const snapshot = broadcasts.map((text) => JSON.parse(text)).find((event) => event.type === 'live_session_snapshot');
  assert.deepEqual(snapshot.entries, [header, root, answer]);
  assert.equal(snapshot.sessionId, session.id);
  assert.deepEqual(child.signals, []);
});

for (const state of [{ isStreaming: true }, { isCompacting: true }, { pendingMessageCount: 1 }, { pendingMessageCount: undefined }]) {
  test(`refresh refuses non-idle or unknown state ${JSON.stringify(state)}`, async (t) => {
    const { child, manager, session, options } = await fixture(t);
    Object.assign(child.state, state);
    const start = child.commands.length;
    await assert.rejects(manager.resume({ ...options, refresh: true }), /busy or has queued prompts/);
    assert.deepEqual(child.commands.slice(start).map((command) => command.type), ['get_state']);
    assert.deepEqual(child.signals, []);
    assert.equal(manager.get(session.id), session);
    assert.equal(session.refreshing, false);
  });
}

test('refresh refuses an unfinished run even after turn_end until agent_settled', async (t) => {
  const { manager, session, options } = await fixture(t);
  session.handleEvent({ type: 'agent_start' });
  session.handleEvent({ type: 'turn_end' });
  await assert.rejects(manager.resume({ ...options, refresh: true }), /busy/);
  session.handleEvent({ type: 'agent_end' });
  await assert.rejects(manager.resume({ ...options, refresh: true }), /busy/);
  session.handleEvent({ type: 'agent_settled' });
  assert.equal((await manager.resume({ ...options, refresh: true })).refreshed, true);
});

test('refresh refuses pending and timed-out mutating commands without cancellation', async (t) => {
  const { child, manager, session, options } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  child.autoRespond = false;
  const start = child.commands.length;
  const command = assert.rejects(session.send({ type: 'compact' }, { timeoutMs: 100 }), /timed out/);
  await assert.rejects(manager.resume({ ...options, refresh: true }), /busy/);
  t.mock.timers.tick(100);
  await command;
  await assert.rejects(manager.resume({ ...options, refresh: true }), /busy/);
  assert.deepEqual(child.commands.slice(start).map((value) => value.type), ['compact']);
  child.respond(child.commands[start]);
  child.autoRespond = true;
  assert.equal((await manager.resume({ ...options, refresh: true })).refreshed, true);
});

test('concurrent refreshes coalesce and refuse competing child commands', async (t) => {
  const { child, manager, session, options, spawned } = await fixture(t);
  child.autoRespond = false;
  const start = child.commands.length;
  const first = manager.resume({ ...options, refresh: true });
  const second = manager.resume({ ...options, refresh: true });
  await flushIo();
  assert.equal(session.refreshing, true);
  await assert.rejects(session.send({ type: 'prompt', message: 'do not send' }), /refresh is in progress/);
  await assert.rejects(session.send({ type: 'set_model', provider: 'other', modelId: 'other' }), /refresh is in progress/);
  child.autoRespond = true;
  child.respond(child.commands[start]);
  const results = await Promise.all([first, second]);
  assert.equal(results[0].session, results[1].session);
  assert.ok(results.every((result) => !result.started && result.refreshed));
  assert.equal(child.commands.filter((command) => command.type === 'switch_session').length, 1);
  assert.equal(spawned(), 1);
});

test('refresh joining a startup reloads after readiness rather than claiming an unperformed refresh', async (t) => {
  const file = '/tmp/tau-refresh-starting.jsonl';
  const child = new RefreshPi({ sessionFile: file, autoRespond: false, state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } });
  _setSpawnPiForTest(() => child.asChild());
  t.after(() => _setSpawnPiForTest(null));
  const manager = new LiveSessionManager();
  t.after(() => manager.shutdown());
  const options = { sessionFile: file, cwd: os.tmpdir() };
  const first = manager.resume(options);
  const second = manager.resume({ ...options, refresh: true });
  await flushIo();
  child.autoRespond = true;
  child.respond(child.commands[0]);
  const [created, refreshed] = await Promise.all([first, second]);
  assert.equal(created.started, true);
  assert.equal(created.refreshed, false);
  assert.equal(refreshed.session, created.session);
  assert.equal(refreshed.started, false);
  assert.equal(refreshed.refreshed, true);
  assert.equal(child.commands.filter((command) => command.type === 'switch_session').length, 1);
});

for (const failure of ['cancelled', 'unsuccessful', 'wrong-file', 'invalid-tree']) {
  test(`refresh failure ${failure} retains the tab without success or termination`, async (t) => {
    const { child, manager, session, options } = await fixture(t);
    const original = child.respond.bind(child);
    let switched = false;
    t.mock.method(child, 'respond', (command: RpcCommand) => {
      if (command.type === 'switch_session') {
        switched = true;
        if (failure === 'cancelled') return original(command, { data: { cancelled: true } });
        if (failure === 'unsuccessful') return original(command, { success: false, error: 'refused' });
      }
      if (switched && command.type === 'get_state' && failure === 'wrong-file') return original(command, { data: { sessionFile: '/tmp/other.jsonl' } });
      if (command.type === 'get_tree' && failure === 'invalid-tree') return original(command, { data: { tree: [], leafId: 'missing' } });
      original(command);
    });
    await assert.rejects(manager.resume({ ...options, refresh: true }), /refresh|reload/);
    assert.equal(manager.get(session.id), session);
    assert.equal(session.sessionFile, options.sessionFile);
    assert.equal(session.refreshing, false);
    assert.equal(manager.hasPendingResume(options.sessionFile), false);
    assert.deepEqual(child.signals, []);
  });
}
