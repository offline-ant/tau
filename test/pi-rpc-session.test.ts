// Direct-child lifecycle tests are replaced by the real detached/socket contract.
import { runtimeFixture } from './runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModel, parseModelSpecToModel } from '../bin/model-utils.js';
import { NAVIGATE_COMMAND } from '../bin/tree.js';
import { until } from './fake-pimux.ts';

test('turn rounds and agent_end do not report idle before agent_settled', async t => {
  const { session, emit } = await runtimeFixture(t);
  await emit({ type: 'agent_start' }, { type: 'turn_start' }, { type: 'turn_end' }, { type: 'agent_end' });
  assert.equal(session.isStreaming, true);
  await emit({ type: 'agent_settled' });
  assert.equal(session.isStreaming, false);
});

test('assistant usage never downgrades the canonical provider/model selection', async t => {
  const { session, emit } = await runtimeFixture(t);
  await emit({ type: 'message_end', message: { role: 'assistant', model: 'bare-id', content: 'done', usage: { input: 3 } } });
  assert.deepEqual(session.model, { provider: 'fx', id: 'one' });
  assert.deepEqual(session.contextUsage?.usage, { input: 3 });
});

test('all dialog methods validate replies, retain failed writes, and wait for mux closure', async t => {
  const { session, mux, emit } = await runtimeFixture(t);
  for (const method of ['confirm', 'select', 'input', 'editor']) {
    const id = `dialog-${method}`;
    await emit({ type: 'extension_ui_request', id, method, options: ['safe'] });
    await assert.rejects(session.respondToDialog({ id, sessionId: 'another', confirmed: true }), /another session/);
    await assert.rejects(session.respondToDialog({ id, ...(method === 'confirm' ? { value: 'bad' } : { confirmed: true }) }), /Invalid/);
    if (method === 'select') await assert.rejects(session.respondToDialog({ id, value: 'unsafe' }), /Invalid/);
    if (method === 'confirm') await session.respondToDialog({ id, confirmed: false });
    else await session.respondToDialog({ id, value: 'safe' });
    assert.equal(session.attachment?.dialogs.has(id), true, 'a write is not authoritative closure');
    await until(() => mux.commands.find(command => command.type === 'extension_ui_response' && command.id === id), 'dialog reply');
    await emit({ type: 'pimux_dialog_closed', id, reason: 'answered' });
    assert.equal(session.attachment?.dialogs.has(id), false);
    await assert.rejects(session.respondToDialog({ id, cancelled: true }), /pending/);
  }
});

test('Abort is native, coalesced, and late acknowledgements do not idle a newer operation', async t => {
  const { session, mux, emit } = await runtimeFixture(t);
  mux.withheld.add('abort');
  await emit({ type: 'agent_start' });
  const first = session.abort({ id: 'stop-first' }, { timeoutMs: 40 });
  const second = session.abort({ id: 'stop-second' }, { timeoutMs: 40 });
  const checks = [assert.rejects(first, /timed out/), assert.rejects(second, /timed out/)];
  await Promise.all(checks);
  assert.equal(mux.commands.filter(command => command.type === 'abort').length, 1);
  await emit({ type: 'agent_settled' }, { type: 'agent_start' }, { type: 'response', command: 'abort', id: 'stop-first', success: true });
  assert.equal(session.abortState, 'idle');
  assert.equal(session.isStreaming, true);
});

test('only navigation command failures are retained for tree diagnostics', async t => {
  const { session, emit } = await runtimeFixture(t);
  await emit({ type: 'extension_error', extensionPath: 'command:unrelated', error: 'not this command' });
  assert.equal(session.lastExtensionError, null);
  await emit({ type: 'extension_error', extensionPath: `command:${NAVIGATE_COMMAND}`, error: 'missing target' });
  assert.equal(session.lastExtensionError, 'missing target');
});

test('a new client does not rename the shared agent from its own user message', async t => {
  const { session, emit } = await runtimeFixture(t);
  await emit({ type: 'message_start', message: { role: 'user', content: 'do not rename the shared conversation' } });
  assert.equal(session.sessionName, null);
  await emit({ type: 'session_info_changed', name: 'Authoritative name' });
  assert.equal(session.sessionName, 'Authoritative name');
});

test('responses retain correlation, late state cannot replace the current file, and pending requests are bounded', async t => {
  const { session, mux, file, emit } = await runtimeFixture(t);
  mux.withheld.add('get_state');
  const command = session.send({ type: 'get_state', id: 'state-request' });
  await until(() => mux.commands.find(record => record.id === 'state-request'), 'state request');
  await emit({ type: 'response', command: 'get_state', id: 'state-request', success: true, data: { sessionFile: '/foreign', model: { provider: 'fx', id: 'deep' } } });
  assert.equal((await command).id, 'state-request');
  assert.equal(session.sessionFile, file);
  assert.deepEqual(session.model, { provider: 'fx', id: 'deep' });
  const outstanding = Array.from({ length: 256 }, (_, index) => session.send({ type: 'get_state', id: `pending-${index}` }).catch(() => {}));
  await assert.rejects(session.send({ type: 'get_state' }), /Too many pending/);
  await session.terminate();
  await Promise.all(outstanding);
});

test('a timed-out ID cannot alias another request before the actual acknowledgement', async t => {
  const { session, mux, emit } = await runtimeFixture(t);
  mux.withheld.add('get_state');
  await assert.rejects(session.send({ type: 'get_state', id: 'uncertain-id' }, { timeoutMs: 20 }), /timed out/);
  await assert.rejects(session.send({ type: 'get_state', id: 'uncertain-id' }), /still in flight/);
  assert.equal(mux.commands.filter(command => command.id === 'uncertain-id').length, 1);
  await emit({ type: 'response', command: 'get_state', id: 'uncertain-id', success: true, data: {} });
  mux.withheld.delete('get_state');
  assert.equal((await session.send({ type: 'get_state', id: 'uncertain-id' })).success, true);
});

test('disconnect rejects pending commands without a Pi signal or a replacement launch', async t => {
  const { session, mux, manager } = await runtimeFixture(t);
  mux.withheld.add('get_state');
  const pending = assert.rejects(session.send({ type: 'get_state' }), /terminated|connection/);
  await manager.delete(session.id);
  await pending;
  assert.equal(mux.commands.some(command => command.type === 'pimux_stop'), false);
  await assert.rejects(session.send({ type: 'prompt', message: 'must not replay' }), /not running/);
});

test('framing retains U+2028/U+2029 and stream-ending errors reach pending callers', async t => {
  const { session, mux, emit } = await runtimeFixture(t);
  await emit({ type: 'session_info_changed', name: 'line\u2028paragraph\u2029end' });
  assert.equal(session.sessionName, 'line\u2028paragraph\u2029end');
  mux.withheld.add('get_state');
  const pending = assert.rejects(session.send({ type: 'get_state' }), /owned failure/);
  await emit({ type: 'pimux_exit', code: 1, signal: null, stderrTail: 'owned failure' });
  mux.drop();
  await pending;
});

test('model specifications preserve slashes in IDs and supported thinking levels', () => {
  assert.deepEqual(normalizeModel({ provider: 'openrouter', id: 'z-ai/model' }), { provider: 'openrouter', id: 'z-ai/model' });
  assert.deepEqual(parseModelSpecToModel('openrouter/z-ai/model:high'), { model: { provider: 'openrouter', id: 'z-ai/model' }, level: 'high' });
  assert.equal(normalizeModel(null), null);
  assert.deepEqual(parseModelSpecToModel(''), { model: null, level: null });
});
