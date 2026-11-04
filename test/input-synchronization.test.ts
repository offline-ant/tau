import { runtimeFixture, runtimeEnvironment, cwd } from './runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { JsonRecord } from '../src/server/types.ts';

test('cross-file and same-file changes publish authoritative history without post-input tree reads', async t => {
  const { manager, session, mux, file } = await runtimeFixture(t);
  const events: JsonRecord[] = [];
  manager.addClient({ readyState: 1, bufferedAmount: 0, send: payload => events.push(JSON.parse(payload) as JsonRecord), close() {}, terminate() {}, ping() {} });
  const destination = path.join(runtimeEnvironment.sessions, 'new-file.jsonl');
  mux.entries = [{ id: 'root', parentId: null, type: 'message' }, { id: 'chosen', parentId: 'root', type: 'message' }, { id: 'other', parentId: 'root', type: 'message' }];
  mux.leafId = 'chosen';
  mux.extraSnapshot = { session: { file: destination, id: 'new', name: null, cwd }, model: { provider: 'fx', id: 'deep' }, thinkingLevel: 'high' };
  mux.broadcast({ type: 'pimux_session_changed', sessionFile: destination, previousSessionFile: file });
  for (const socket of mux.connections) mux.snapshot(socket, 'session_changed');
  const snapshot = await session.snapshot();
  assert.equal(snapshot.sessionFile, destination);
  assert.equal(manager.findBySessionFile(file), undefined);
  assert.equal(manager.findBySessionFile(destination), session);
  assert.deepEqual(snapshot.entries.map(entry => entry.id), ['root', 'chosen']);
  mux.leafId = 'other';
  const changed = await session.snapshot();
  assert.deepEqual(changed.entries.map(entry => entry.id), ['root', 'other']);
  await session.send({ type: 'prompt', message: '/handled-command' });
  assert.equal(mux.commands.some(command => ['get_state', 'get_entries', 'get_messages'].includes(String(command.type))), false);
  assert.ok(events.some(event => event.type === 'live_session_snapshot'));
});

test('a snapshot history failure adopts identity but never keeps old history under the new file', async t => {
  const { session, mux } = await runtimeFixture(t);
  session.entries = [{ id: 'old', type: 'message' }];
  mux.entries = undefined;
  mux.extraSnapshot = { session: { file: path.join(runtimeEnvironment.sessions, 'unreadable.jsonl'), id: 'unreadable', name: null, cwd }, historyError: 'serialization failed' };
  const snapshot = await session.snapshot();
  assert.deepEqual(snapshot.entries, []);
  assert.equal(snapshot.sessionFile, mux.extraSnapshot.session && (mux.extraSnapshot.session as JsonRecord).file);
  mux.entries = [{ id: 'recovered', parentId: null, type: 'message' }];
  mux.leafId = 'recovered';
  delete mux.extraSnapshot.historyError;
  assert.equal((await session.snapshot()).entries[0].id, 'recovered');
});

test('inference acknowledgement does not replace in-flight streamed state or issue independent state reads', async t => {
  const { session, mux, emit } = await runtimeFixture(t);
  await emit({ type: 'agent_start' }, { type: 'message_start', message: { role: 'user', content: 'work' } });
  const before = mux.commands.length;
  await session.send({ type: 'prompt', message: 'steering', streamingBehavior: 'steer' });
  assert.equal(session.isStreaming, true);
  assert.deepEqual(mux.commands.slice(before).map(command => command.type), ['prompt']);
  assert.equal(session.entries.length, 1);
});

test('fresh unwritten sessions accept extension commands without loading a disk header', async t => {
  const { session, mux } = await runtimeFixture(t);
  for (const message of ['/tools', '/browser status', '/take herdr']) assert.equal((await session.send({ type: 'prompt', message })).success, true);
  assert.equal(session.entries.length, 0);
  assert.equal(mux.commands.some(command => command.type === 'get_entries'), false);
});
