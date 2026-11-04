import { runtimeEnvironment, cwd } from './runtime-environment.ts';
import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveryRecord } from '@phimacs/pimux/discovery';
import { LiveSessionManager } from '../bin/sessions.js';
import { FakePimux, until } from './fake-pimux.ts';
import { workerTaskFixture } from './worker-task-fixture.ts';

after(() => fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }));
async function unavailable(t: TestContext, id: string, directory = process.env.PIMUX_DIR!) {
  const file = path.join(runtimeEnvironment.sessions, `${id}.jsonl`);
  const mux = new FakePimux(directory, id, { sessionFile: file, cwd });
  await mux.listen();
  let launches = 0;
  const manager = new LiveSessionManager({ start: async () => { launches++; throw new Error('Recovery must not launch'); } });
  const { session } = await manager.attach(mux.entry as unknown as DiscoveryRecord);
  mux.drop();
  await until(() => session.exited, 'original connection lost');
  t.after(async () => { await manager.shutdown(); await mux.close(); });
  return { mux, file, manager, session, launches: () => launches };
}
function terminalReceipt(muxId: string) {
  const directory = path.join(process.env.PIMUX_DIR!, 'receipts');
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(directory, `${muxId}.json`), JSON.stringify({ protocol: 2, muxId, operationId: 'terminal-operation', state: 'stopped', code: 0, signal: null, stoppedAt: new Date().toISOString() }), { mode: 0o600 });
}

for (const opening of ['attach', 'resume', 'refresh', 'snapshot'] as const) {
  test(`${opening} reconciles a known runtime closed while disconnected instead of reusing or relaunching it`, async t => {
    const { mux, file, manager, session, launches } = await unavailable(t, `closed-${opening}`);
    await mux.close();
    terminalReceipt(mux.muxId);
    const open = () => opening === 'attach' ? manager.attachById(mux.muxId)
      : opening === 'snapshot' ? session.snapshot()
      : manager.resume({ sessionFile: file, cwd, refresh: opening === 'refresh' });
    await assert.rejects(open(), error => error instanceof Error && 'status' in error && error.status === 410);
    assert.equal(manager.get(session.id), undefined, 'terminal evidence removes the unavailable view');
    assert.equal(launches(), 0);
  });
}

test('a missing runtime without terminal evidence retains its unavailable view and never launches', async t => {
  const { mux, file, manager, session, launches } = await unavailable(t, 'unknown-owner');
  await mux.close();
  await assert.rejects(manager.resume({ sessionFile: file, cwd }), /unavailable.*not acknowledged/);
  await assert.rejects(session.snapshot(), /unavailable.*not acknowledged/);
  assert.equal(manager.get(session.id), session);
  assert.equal(launches(), 0);
});

test('resume retains the old unavailable view until the same surviving identity is fully ready', async t => {
  const { mux, file, manager, session, launches } = await unavailable(t, 'surviving-owner');
  const initialQueries = mux.commands.filter(command => command.type === 'get_commands').length;
  mux.withheld.add('get_commands');
  const reopened = manager.resume({ sessionFile: file, cwd });
  await until(() => mux.commands.filter(command => command.type === 'get_commands').length > initialQueries, 'replacement capability query');
  assert.equal(manager.get(session.id), session, 'unfinished attachment must not discard the old view');
  assert.equal(manager.sessions.size, 1);
  const query = mux.commands.filter(command => command.type === 'get_commands').at(-1)!;
  mux.broadcast({ type: 'response', command: 'get_commands', id: query.id, success: true, data: { commands: [] } });
  const { session: replacement } = await reopened;
  assert.notEqual(replacement, session);
  assert.equal(replacement.attachment.muxId, mux.muxId);
  assert.equal(replacement.metadata().inputReady, true);
  assert.equal(manager.get(session.id), undefined);
  assert.equal(manager.get(replacement.id), replacement);
  assert.equal(mux.commands.some(command => command.type === 'prompt'), false);
  assert.equal(launches(), 0);
});

test('a surviving identity reconnects using its captured socket namespace', async t => {
  const { mux, file, manager, session, launches } = await unavailable(t, 'foreign-survivor', path.join(runtimeEnvironment.root, 'foreign-mux'));
  const { session: replacement } = await manager.resume({ sessionFile: file, cwd });
  assert.notEqual(replacement, session);
  assert.equal(replacement.attachment.socket, mux.socketPath);
  assert.equal(replacement.metadata().inputReady, true);
  assert.equal(mux.commands.some(command => command.type === 'prompt'), false);
  assert.equal(launches(), 0);
});

for (const refresh of [false, true]) {
  test(`file-based reconnect refuses an agent that moved to another conversation (refresh: ${refresh})`, async t => {
    const { mux, file, manager, session, launches } = await unavailable(t, `moved-before-reconnect-${refresh}`);
    const moved = path.join(runtimeEnvironment.sessions, `moved-${refresh}.jsonl`);
    mux.publish({ session: { file: moved, id: 'moved', name: 'Moved conversation' } });
    await assert.rejects(manager.resume({ sessionFile: file, cwd, refresh }), /different conversation/);
    assert.equal(manager.get(session.id), session, 'failed file request retains the original unavailable view');
    assert.equal(manager.sessions.size, 1);
    assert.equal(launches(), 0);
    assert.equal(mux.commands.some(command => command.type === 'prompt'), false);
    const { session: replacement } = await manager.attachById(mux.muxId);
    assert.equal(replacement.sessionFile, moved, 'explicit identity attach may follow the same agent to its current conversation');
  });
}

test('replacement capability readiness cannot turn Resume A into a successful Resume B', async t => {
  const { mux, file, manager, session, launches } = await unavailable(t, 'moved-during-readiness');
  const broadcasts: Array<{ type?: string; sessionId?: string }> = [];
  t.mock.method(manager, 'broadcast', (record: typeof broadcasts[number]) => broadcasts.push(record));
  mux.withheld.add('get_commands');
  const reopening = manager.resume({ sessionFile: file, cwd });
  const rejected = assert.rejects(reopening, /different conversation/);
  await until(() => mux.commands.filter(command => command.type === 'get_commands').length === 2, 'replacement capability query');
  const moved = path.join(runtimeEnvironment.sessions, 'replacement-conversation-b.jsonl');
  assert.notEqual(moved, file);
  mux.publish({ session: { file: moved, id: 'moved', name: null } });
  for (const socket of mux.connections) mux.snapshot(socket, 'session_changed');
  const query = mux.commands.filter(command => command.type === 'get_commands').at(-1)!;
  mux.broadcast({ type: 'response', command: 'get_commands', id: query.id, success: true, data: { commands: [] } });
  await rejected;
  assert.equal(manager.get(session.id), session);
  await until(() => mux.connections.size === 0, 'failed replacement disconnects its owned socket');
  assert.equal(broadcasts.some(record => record.type === 'live_session_snapshot' || record.type === 'live_session_created'), false, 'rejected replacements cannot create ghost browser views');
  assert.equal(launches(), 0);
});

test('a live refresh validates the requested file after its authoritative snapshot changes', async t => {
  const { mux, file, manager, launches } = await unavailable(t, 'moved-during-refresh');
  const { session } = await manager.attachById(mux.muxId);
  const moved = path.join(runtimeEnvironment.sessions, 'moved-live-refresh.jsonl');
  mux.extraSnapshot.session = { file: moved, id: 'moved', name: null, cwd };
  await assert.rejects(manager.resume({ sessionFile: file, cwd, refresh: true }), /different conversation/);
  assert.equal(session.sessionFile, moved, 'the live view still follows its actual agent');
  assert.equal(manager.get(session.id), session);
  assert.equal(launches(), 0);
  assert.equal(mux.commands.some(command => command.type === 'prompt'), false);
});

for (const [state, retainRuntimeReceipt] of [['pending', true], ['failed', true], ['complete', true], ['failed', false]] as const) {
  test(`a fresh frontend reconciles ${state} task evidence (runtime receipt: ${retainRuntimeReceipt}) without claiming false closure`, async t => {
    const id = `fresh-${state}-${retainRuntimeReceipt}`;
    const mux = new FakePimux(process.env.PIMUX_DIR!, id, { sessionFile: path.join(runtimeEnvironment.sessions, `${id}.jsonl`), cwd, placement: 'worker' });
    await mux.listen();
    const task = workerTaskFixture(mux);
    task.receipt();
    if (state !== 'pending') task.finish(state === 'failed' ? 'parent cleanup failed' : undefined);
    if (!retainRuntimeReceipt) fs.unlinkSync(path.join(path.dirname(mux.socketPath), 'receipts', `${mux.muxId}.json`));
    await mux.close();
    const manager = new LiveSessionManager({ start: async () => assert.fail('Recovery cannot relaunch') });
    t.after(() => manager.shutdown());
    await assert.rejects(manager.attachById(mux.muxId), error => error instanceof Error && 'status' in error
      && error.status === (state === 'complete' ? 410 : 503) && (state !== 'failed' || error.message.includes('parent cleanup failed')));
    assert.equal(manager.sessions.size, 0);
  });
}

test('a failed replacement attachment retains the original unavailable view', async t => {
  const { mux, file, manager, session, launches } = await unavailable(t, 'failed-reconnect');
  mux.failSnapshots = 'cannot establish authoritative boundary';
  await assert.rejects(manager.resume({ sessionFile: file, cwd }), /authoritative boundary/);
  assert.equal(manager.get(session.id), session);
  assert.equal(manager.sessions.size, 1);
  assert.equal(launches(), 0);
});
