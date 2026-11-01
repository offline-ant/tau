import { runtimeFixture } from './runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { until } from './fake-pimux.ts';

test('socket events retain working/compaction boundaries and snapshots reconstruct them exactly once', async t => {
  const { session, manager, mux, emit } = await runtimeFixture(t);
  const question = { role: 'user', content: 'handoff and continue' };
  const before = { role: 'assistant', content: 'before compaction' };
  await emit({ type: 'agent_start' }, { type: 'message_start', message: question },
    { type: 'message_end', message: question }, { type: 'message_end', message: before }, { type: 'turn_end' });
  assert.equal(session.isStreaming, true);
  assert.equal(manager.list()[0].isStreaming, true);
  const compaction = { id: 'compact', parentId: 'before', type: 'compaction', summary: 'handoff' };
  await emit({ type: 'agent_end' }, { type: 'compaction_start', reason: 'manual' },
    { type: 'entry_appended', entry: compaction }, { type: 'compaction_end', result: { summary: 'handoff' } });
  assert.equal(session.entries.filter(entry => entry.type === 'compaction').length, 1);
  assert.equal(session.isStreaming, true, 'compaction and agent_end are not settled');
  mux.entries = [{ id: 'question', parentId: null, type: 'message', message: question },
    { id: 'before', parentId: 'question', type: 'message', message: before }, compaction];
  mux.leafId = 'compact';
  mux.idle = false;
  const snapshot = await session.snapshot();
  assert.equal(snapshot.entries.filter(entry => entry.type === 'compaction').length, 1);
  assert.equal(snapshot.entries.length, 3);
  await emit({ type: 'agent_settled' });
  await until(() => !session.isStreaming, 'settled event received');
  assert.equal(session.isStreaming, false);
});
