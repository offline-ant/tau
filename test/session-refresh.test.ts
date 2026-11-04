import { runtimeFixture } from './runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

test('refresh rebuilds the selected branch from one mux boundary without reopening its file', async t => {
  const { session, manager, mux, file } = await runtimeFixture(t);
  mux.entries = [{ id: 'root', parentId: null, type: 'message' }, { id: 'selected', parentId: 'root', type: 'message' }, { id: 'abandoned', parentId: 'root', type: 'message' }];
  mux.leafId = 'selected';
  mux.extraSnapshot = { model: { provider: 'fx', id: 'deep' }, thinkingLevel: 'high' };
  const before = mux.commands.length;
  const result = await manager.resume({ sessionFile: file, cwd: session.cwd, refresh: true });
  assert.equal(result.session, session);
  assert.equal(result.started, false);
  assert.equal(result.refreshed, true);
  assert.deepEqual(session.entries.map(entry => entry.id), ['root', 'selected']);
  assert.deepEqual(mux.commands.slice(before).map(command => command.type), ['pimux_bootstrap']);
  assert.equal(session.model?.id, 'deep');
});

test('refresh during inference preserves the live tail instead of cancelling or replacing the agent', async t => {
  const { session, manager, mux, file } = await runtimeFixture(t);
  mux.idle = false;
  mux.replay = [{ type: 'agent_start' }, { type: 'message_start', message: { role: 'assistant', content: [] } }];
  const result = await manager.resume({ sessionFile: file, cwd: session.cwd, refresh: true });
  assert.equal(result.refreshed, true);
  assert.equal(session.isStreaming, true);
  assert.equal(mux.commands.some(command => ['switch_session', 'abort', 'pimux_stop'].includes(String(command.type))), false);
});

test('concurrent refreshes coalesce into one authoritative bootstrap', async t => {
  const { manager, session, mux, file } = await runtimeFixture(t);
  const start = mux.commands.filter(command => command.type === 'pimux_bootstrap').length;
  const results = await Promise.all([manager.resume({ sessionFile: file, cwd: session.cwd, refresh: true }), manager.resume({ sessionFile: file, cwd: session.cwd, refresh: true })]);
  assert.ok(results.every(result => result.refreshed && !result.started));
  assert.equal(mux.commands.filter(command => command.type === 'pimux_bootstrap').length - start, 1);
});

test('a failed refresh retains the view and retries snapshots, never opens another writer', async t => {
  const { manager, session, mux, file } = await runtimeFixture(t);
  mux.failSnapshots = 'history unavailable';
  await assert.rejects(manager.resume({ sessionFile: file, cwd: session.cwd, refresh: true }), /snapshot/);
  assert.equal(manager.get(session.id), session);
  assert.equal(session.sessionFile, file);
  assert.equal(session.attachment?.ready, false);
  await assert.rejects(session.send({ type: 'prompt', message: 'must not reach an unready view' }), /not running/);
  mux.failSnapshots = null;
  await session.snapshot();
  assert.equal(session.attachment?.ready, true);
});
