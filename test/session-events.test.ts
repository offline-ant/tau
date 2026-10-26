import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { LiveSessionManager, _setSpawnPiForTest } from '../bin/sessions.js';
import type { JsonRecord } from '../src/server/types.ts';
import { FakePi, flushIo } from './fake-pi.ts';

test('child events preserve working snapshots and compaction boundaries for reconnecting clients', async (t) => {
  const child = new FakePi();
  _setSpawnPiForTest(() => child.asChild());
  t.after(() => _setSpawnPiForTest(null));
  const manager = new LiveSessionManager();
  t.after(() => manager.shutdown());
  const session = await manager.create({ cwd: os.tmpdir(), model: undefined, sessionFile: undefined, args: undefined, env: undefined });
  const broadcasts: string[] = [];
  manager.addClient({ readyState: 1, send: (payload: string) => broadcasts.push(payload) });
  const emit = async (...events: JsonRecord[]) => {
    for (const event of events) child.stdout.write(JSON.stringify(event) + '\n');
    await flushIo();
  };
  const question = { role: 'user', content: 'Save a handoff and continue' };
  const before = { role: 'assistant', content: [{ type: 'text', text: 'Before compaction' }] };
  await emit(
    { type: 'agent_start' },
    { type: 'message_start', message: question },
    { type: 'message_end', message: question },
    { type: 'turn_start' },
    { type: 'message_end', message: before },
    { type: 'turn_end' },
  );
  assert.equal((await session.snapshot()).isStreaming, true);
  assert.equal((await session.snapshot()).session.isStreaming, true);
  assert.equal(manager.list()[0].isStreaming, true);
  const updates = broadcasts.map(payload => JSON.parse(payload)).filter(event => event.type === 'live_session_updated');
  assert.ok(updates.length > 0);
  assert.ok(updates.every(update => update.session.isStreaming), 'tool-round broadcasts must not advertise idle');

  const first = { type: 'compaction', id: 'compact-1', parentId: null, summary: 'First handoff', firstKeptEntryId: 'kept-1', tokensBefore: 100 };
  const after = { role: 'assistant', content: [{ type: 'text', text: 'After compaction' }] };
  await emit(
    { type: 'agent_end' },
    { type: 'compaction_start', reason: 'manual' },
    { type: 'entry_appended', entry: first },
    { type: 'compaction_end', reason: 'manual', result: { summary: first.summary }, aborted: false },
    { type: 'agent_start' },
    { type: 'message_end', message: after },
    // Message events already own the message cache; entry_appended must not duplicate them.
    { type: 'entry_appended', entry: { type: 'message', message: after } },
  );
  assert.deepEqual((await session.snapshot()).entries, [
    { type: 'message', message: question }, { type: 'message', message: before },
    first, { type: 'message', message: after },
  ]);
  assert.equal((await session.snapshot()).isStreaming, true);

  const second = { ...first, id: 'compact-2', summary: 'Second handoff' };
  await emit(
    { type: 'entry_appended', entry: second },
    { type: 'agent_end' },
  );
  assert.deepEqual((await session.snapshot()).entries.filter((entry: JsonRecord) => entry.type === 'compaction'), [first, second]);
  assert.equal((await session.snapshot()).isStreaming, false);
  assert.equal(manager.list()[0].isStreaming, false);
  const lastUpdate = broadcasts.map(payload => JSON.parse(payload)).filter(event => event.type === 'live_session_updated').at(-1);
  assert.equal(lastUpdate.session.isStreaming, false);
});
