import { runtimeEnvironment, cwd } from './runtime-environment.ts';
import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveryRecord } from '@phimacs/pimux/discovery';
import { LiveSessionManager } from '../bin/sessions.js';
import { closeWorker } from '../bin/close-worker.js';
import { FakePimux, until } from './fake-pimux.ts';
import { workerTaskFixture } from './worker-task-fixture.ts';

after(() => fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }));
async function worker(t: TestContext, id: string, directory = process.env.PIMUX_DIR!) {
  const mux = new FakePimux(directory, id, { sessionFile: path.join(runtimeEnvironment.sessions, `${id}.jsonl`), cwd, placement: 'worker' });
  mux.responses.get_commands = { success: true, data: { commands: [{ name: 'worker-cancel', source: 'extension' }] } };
  await mux.listen();
  const task = workerTaskFixture(mux);
  const manager = new LiveSessionManager({ stop: async () => { assert.fail('Worker Close must never signal its runtime'); } });
  const { session } = await manager.attach(mux.entry as unknown as DiscoveryRecord);
  const broadcasts: Array<{ type?: string; sessionId?: string; message?: string; notice?: boolean; event?: { message?: string } }> = [];
  t.mock.method(manager, 'broadcast', (record: typeof broadcasts[number]) => broadcasts.push(record));
  t.after(async () => { await manager.shutdown(); await mux.close(); });
  return { mux, task, manager, session, broadcasts };
}

test('worker Close waits for matching parent cleanup after runtime exit and coalesces cancellation', async t => {
  const { mux, task, manager, session, broadcasts } = await worker(t, 'cancel-worker');
  const first = session.stop('first-close'), second = session.stop('simultaneous-close');
  let acknowledged = false;
  void first.then(() => { acknowledged = true; });
  await until(() => mux.commands.some(command => command.message === '/worker-cancel'), 'task cancellation dispatched');
  assert.equal(mux.commands.filter(command => command.message === '/worker-cancel').length, 1);
  task.exit();
  await until(() => session.exited, 'worker runtime exited');
  assert.equal(acknowledged, false, 'pimux_exit and a stop receipt do not acknowledge task cleanup');
  assert.equal(manager.get(session.id), session);
  assert.equal(broadcasts.some(record => record.type === 'live_session_closed'), false);
  task.finish();
  const [receipt, repeated] = await Promise.all([first, second]);
  assert.equal(receipt.state, 'stopped');
  assert.equal(receipt.muxId, mux.muxId);
  assert.deepEqual(repeated, receipt);
});

for (const commands of [[], [{ name: 'worker-cancel', source: 'prompt' }], [{ name: 'another-command', source: 'extension' }]]) {
  test(`unadvertised worker-cancel never submits a slash prompt (${JSON.stringify(commands)})`, async t => {
    const { mux, manager, session } = await worker(t, `missing-command-${commands.length}-${String(commands[0]?.source ?? 'empty')}`);
    mux.responses.get_commands = { success: true, data: { commands } };
    await assert.rejects(session.stop(), /does not advertise worker-cancel/);
    assert.equal(mux.commands.some(command => command.type === 'prompt'), false);
    assert.equal(manager.get(session.id), session);
  });
}

test('socket loss makes Close fail immediately with reconnect guidance, not wait for an undispatched cancellation', async t => {
  const { mux, manager, session } = await worker(t, 'disconnected-close');
  mux.drop();
  await until(() => session.exited, 'socket disconnected');
  await assert.rejects(closeWorker(session, 100), /Reconnect this agent before closing/);
  assert.equal(mux.commands.some(command => command.type === 'prompt'), false);
  assert.equal(manager.get(session.id), session);
});

for (const phase of ['get_commands', 'prompt'] as const) {
  test(`socket loss during ${phase} retains the worker and reports uncertain cancellation without replay`, async t => {
    const { mux, manager, session } = await worker(t, `lost-during-${phase.replaceAll('_', '-')}`);
    mux.withheld.add(phase);
    const closing = session.stop();
    const rejected = assert.rejects(closing, /Reconnect this agent before closing/);
    await until(() => mux.commands.filter(command => command.type === phase).length === (phase === 'get_commands' ? 2 : 1), 'close command reached peer');
    mux.drop();
    await rejected;
    assert.equal(mux.commands.filter(command => command.type === 'prompt').length, phase === 'prompt' ? 1 : 0);
    assert.equal(manager.get(session.id), session);
  });
}

test('an explicit same-identity reconnect can cancel the surviving worker exactly once', async t => {
  const { mux, task, manager, session } = await worker(t, 'reattach-before-cancel');
  mux.drop();
  await until(() => session.exited, 'connection lost');
  await assert.rejects(session.stop(), /Reconnect this agent/);
  const { session: replacement } = await manager.attachById(mux.muxId);
  assert.notEqual(replacement, session);
  assert.equal(replacement.attachment.muxId, mux.muxId);
  const closing = replacement.stop();
  await until(() => mux.commands.some(command => command.message === '/worker-cancel'), 'reconnected cancellation');
  task.exit(); task.finish();
  assert.equal((await closing).state, 'stopped');
  assert.equal(mux.commands.filter(command => command.type === 'prompt').length, 1);
});

test('missing task evidence refuses cancellation before any slash prompt', async t => {
  const { mux, task, manager, session } = await worker(t, 'missing-task');
  fs.unlinkSync(task.file);
  await assert.rejects(session.stop(), /task evidence is missing/);
  assert.equal(mux.commands.some(command => command.type === 'prompt'), false);
  assert.equal(manager.get(session.id), session);
});

test('a worker process identity mismatch refuses cancellation', async t => {
  const { mux, task, session } = await worker(t, 'wrong-worker');
  task.publish({ worker: { ...task.record().worker, startTime: '0' } });
  await assert.rejects(session.stop(), /process identity changed/);
  assert.equal(mux.commands.some(command => command.type === 'prompt'), false);
});

test('the exact pending task is revalidated after the asynchronous capability query', async t => {
  const { mux, task, session } = await worker(t, 'rebound-task');
  mux.withheld.add('get_commands');
  const closing = session.stop();
  const rejected = assert.rejects(closing, /parent task binding changed/);
  await until(() => mux.commands.filter(command => command.type === 'get_commands').length === 2, 'fresh capability query');
  task.publish({ parent: { ...task.record().parent, taskId: 'another-task' } });
  const command = mux.commands.filter(command => command.type === 'get_commands').at(-1)!;
  mux.broadcast({ type: 'response', command: 'get_commands', id: command.id, success: true, data: { commands: [{ name: 'worker-cancel', source: 'extension' }] } });
  await rejected;
  assert.equal(mux.commands.some(command => command.type === 'prompt'), false);
});

test('a complete record for a different parent task cannot acknowledge Close', async t => {
  const { mux, task, manager, session, broadcasts } = await worker(t, 'wrong-final-task');
  const closing = session.stop();
  const rejected = assert.rejects(closing, /parent task binding changed/);
  await until(() => mux.commands.some(command => command.message === '/worker-cancel'), 'cancellation requested');
  task.exit();
  task.publish({ state: 'complete', parent: { ...task.record().parent, taskId: 'another-task' } });
  await rejected;
  assert.equal(manager.get(session.id), session);
  assert.equal(broadcasts.some(record => record.type === 'live_session_closed'), false);
});

test('worker cancellation refusal retains its view without runtime stop', async t => {
  const { mux, manager, session } = await worker(t, 'refused-worker');
  mux.responses.prompt = { success: false, error: 'The exact parent task is unavailable' };
  await assert.rejects(session.stop(), /parent task is unavailable/);
  assert.equal(manager.get(session.id), session);
});

test('pending parent cleanup times out without optimistic closure even after runtime exit', async t => {
  const { mux, task, manager, session, broadcasts } = await worker(t, 'pending-worker');
  const closing = closeWorker(session, 100);
  const rejected = assert.rejects(closing, /task cleanup timed out/);
  await until(() => mux.commands.some(command => command.message === '/worker-cancel'), 'cancellation requested');
  task.exit();
  await rejected;
  assert.equal(manager.get(session.id), session);
  assert.equal(broadcasts.some(record => record.type === 'live_session_closed'), false);
});

test('failed final cleanup retains the view and remains an error on reconnect', async t => {
  const { mux, task, manager, session, broadcasts } = await worker(t, 'failed-worker');
  const closing = session.stop();
  const rejected = assert.rejects(closing, /native cleanup failed/);
  await until(() => mux.commands.some(command => command.message === '/worker-cancel'), 'cancellation requested');
  task.exit();
  await until(() => session.exited, 'runtime exited');
  task.finish('native cleanup failed');
  await rejected;
  await assert.rejects(manager.attachById(mux.muxId), /native cleanup failed/);
  assert.equal(manager.get(session.id), session);
  assert.equal(broadcasts.some(record => record.type === 'live_session_closed'), false);
});

test('task reads and terminal receipt reconciliation use the captured socket namespace', async t => {
  const directory = path.join(runtimeEnvironment.root, 'foreign-mux');
  const { mux, task, session } = await worker(t, 'foreign-worker', directory);
  const closing = session.stop();
  await until(() => mux.commands.some(command => command.message === '/worker-cancel'), 'cancellation requested');
  task.exit(); task.finish();
  assert.equal((await closing).muxId, mux.muxId);
});

for (const status of [{ code: 1, signal: null, stderrTail: 'worker provider exploded' }, { code: null, signal: 'SIGKILL', stderrTail: 'worker was killed' }, { code: 1, signal: 'SIGABRT', stderrTail: 'worker aborted' }]) {
  test(`complete parent cleanup preserves worker failure diagnostics (${status.signal ?? status.code})`, async t => {
    const { task, manager, session, broadcasts } = await worker(t, `abnormal-${status.signal ?? status.code}`);
    task.exit(status);
    await until(() => session.exited, 'abnormal worker exit');
    assert.equal(manager.get(session.id), session, 'cleanup is still pending');
    task.finish();
    await until(() => !manager.get(session.id), 'completed cleanup retires worker');
    const closed = broadcasts.find(record => record.type === 'live_session_closed');
    assert.equal(closed?.notice, false);
    assert.ok(closed?.message?.includes(status.stderrTail));
    if (status.code !== null) assert.ok(closed?.message?.includes(String(status.code)));
    if (status.signal !== null) assert.ok(closed?.message?.includes(status.signal));
  });
}

test('reconnect reconciliation keeps abnormal worker diagnostics when task cleanup is complete', async t => {
  const { task, manager, session, broadcasts, mux } = await worker(t, 'failed-exit-reconcile');
  task.exit({ code: 2, stderrTail: 'worker startup failed' });
  await until(() => session.exited, 'worker exited');
  task.finish();
  await assert.rejects(manager.attachById(mux.muxId), /This agent was closed/);
  const closed = broadcasts.find(record => record.type === 'live_session_closed');
  assert.equal(closed?.notice, false);
  assert.match(closed?.message ?? '', /exited \(2\):\nworker startup failed/);
});

for (const outcome of ['complete', 'failed'] as const) {
  test(`remote worker exit waits for ${outcome} task evidence before changing the view`, async t => {
    const { task, manager, session, broadcasts } = await worker(t, `remote-${outcome}`);
    task.exit();
    await until(() => session.exited, 'remote runtime exited');
    assert.equal(manager.get(session.id), session);
    assert.equal(broadcasts.some(record => record.type === 'live_session_closed'), false);
    task.finish(outcome === 'failed' ? 'parent cleanup failed' : undefined);
    if (outcome === 'complete') await until(() => !manager.get(session.id), 'final task publication retires the view');
    else {
      await until(() => broadcasts.some(record => record.event?.message?.includes('parent cleanup failed')), 'cleanup failure is visible');
      assert.equal(manager.get(session.id), session);
      assert.equal(broadcasts.some(record => record.type === 'live_session_closed'), false);
    }
  });
}
