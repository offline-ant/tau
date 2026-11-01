import { runtimeFixture, runtimeEnvironment, cwd } from './runtime-fixture.ts';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { handleRpcCommand, liveManager, server } from '../bin/server-main.js';
import type { PiRpcSession } from '../src/server/sessions.ts';
import type { JsonRecord } from '../src/server/types.ts';
import { until } from './fake-pimux.ts';

let base: string;
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});
after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

function captured(session: PiRpcSession) {
  const metadata = session.metadata();
  return { agentId: metadata.runtime?.muxId ?? null, file: metadata.sessionFile,
    leafId: metadata.leafId, runtimeContext: metadata.runtimeContext };
}
function register(session: PiRpcSession) {
  liveManager.sessions.set(session.id, session);
  return () => liveManager.sessions.delete(session.id);
}

async function browserRpc(command: JsonRecord, transport: 'http' | 'websocket') {
  if (transport === 'http') {
    const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    assert.equal(response.status, 200);
    return await response.json() as JsonRecord;
  }
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`);
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return await new Promise<JsonRecord>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket response timed out')), 5000);
      socket.on('message', data => {
        const record = JSON.parse(String(data)) as JsonRecord;
        if (record.type === 'response' && record.id === command.id) { clearTimeout(timeout); resolve(record); }
      });
      socket.send(JSON.stringify(command));
    });
  } finally { socket.terminate(); }
}

for (const transport of ['http', 'websocket'] as const) {
  test(`${transport} refuses a delayed instruction from the previous file in the same tab`, async t => {
    const { session, mux } = await runtimeFixture(t);
    t.after(register(session));
    const inputContext = captured(session);
    const nextFile = path.join(runtimeEnvironment.sessions, `${randomUUID()}.jsonl`);
    mux.extraSnapshot = { session: { file: nextFile, id: 'other', name: null, cwd } };
    mux.leafId = 'replacement-leaf';
    await session.snapshot();
    const response = await browserRpc({ type: 'prompt', id: `delayed-${transport}`, sessionId: session.id,
      message: 'instruction written for A', inputContext }, transport);
    assert.equal(response.success, false);
    assert.equal(response.delivery, 'rejected');
    assert.equal(mux.commands.some(command => command.message === 'instruction written for A'), false);
    assert.equal(session.sessionFile, nextFile);
  });
}

test('an old branch cannot steer, clear global input, rename, change models or answer its dialog', async t => {
  const { session, mux } = await runtimeFixture(t);
  t.after(register(session));
  const inputContext = captured(session);
  mux.leafId = 'other-branch';
  for (const socket of mux.connections) mux.snapshot(socket, 'tree_changed');
  await until(() => session.attachment?.inputContext?.contextId !== inputContext.runtimeContext?.contextId, 'branch adopted');
  for (const command of [
    { type: 'steer', message: 'old steer' }, { type: 'follow_up', message: 'old followup' },
    { type: 'clear_queue', confirmGlobal: true }, { type: 'set_session_name', name: 'old title' },
    { type: 'set_model', provider: 'fx', modelId: 'old' }, { type: 'new_session' },
    { type: 'extension_ui_response', id: 'old-dialog', confirmed: true },
  ]) {
    const count = mux.commands.length;
    const response = await handleRpcCommand({ ...command, sessionId: session.id, inputContext });
    assert.equal(response.success, false, command.type);
    assert.equal(mux.commands.length, count, `${command.type} stayed requester-local`);
  }
});

test('same-branch refresh and streamed leaf progress preserve the captured runtime anchor', async t => {
  const { session, mux } = await runtimeFixture(t);
  t.after(register(session));
  const inputContext = captured(session);
  mux.leafId = 'new-append-on-same-branch';
  await session.snapshot();
  assert.notEqual(session.attachment?.leafId, inputContext.leafId);
  assert.deepEqual(session.attachment?.inputContext, inputContext.runtimeContext);
  const response = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: 'valid steering', streamingBehavior: 'steer', inputContext });
  assert.equal(response.success, true, String(response.error));
  const forwarded = mux.commands.find(command => command.message === 'valid steering');
  assert.deepEqual(forwarded?.pimuxContext, inputContext.runtimeContext);
  assert.equal(Object.hasOwn(forwarded!, 'inputContext'), false);
});

test('missing or caller-forged runtime metadata cannot bypass browser context validation', async t => {
  const { session, mux } = await runtimeFixture(t);
  t.after(register(session));
  for (const inputContext of [undefined, { ...captured(session), agentId: 'different-agent' },
    { ...captured(session), runtimeContext: null }, { ...captured(session), runtimeContext: { ...session.attachment!.inputContext, contextId: 'forged' } }]) {
    const count = mux.commands.length;
    const response = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: 'unbound',
      inputContext, pimuxContext: session.attachment?.inputContext });
    assert.equal(response.success, false);
    assert.equal(response.delivery, 'rejected');
    assert.equal(mux.commands.length, count);
  }
});

test('a pending or failed boundary disables commands while safe reads remain available', async t => {
  const { session, mux } = await runtimeFixture(t);
  t.after(register(session));
  const inputContext = captured(session);
  mux.broadcast({ type: 'pimux_gap', generation: mux.generation + 1, dropped: 1 });
  await until(() => !session.attachment?.ready, 'gap gated');
  assert.equal(session.metadata().inputReady, false);
  assert.equal(session.metadata().runtimeContext, null);
  assert.equal((await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: 'during gap', inputContext })).success, false);
  assert.equal((await handleRpcCommand({ type: 'get_state', sessionId: session.id })).success, true);
  assert.equal((await handleRpcCommand({ type: 'get_available_thinking_levels', sessionId: session.id })).success, true);
  mux.extraSnapshot = { inputContext: null };
  await assert.rejects(session.snapshot(), /no authoritative input context/);
  assert.equal(session.metadata().inputReady, false);
  mux.extraSnapshot = { inputContext: { ...inputContext.runtimeContext, sessionFile: '/different-snapshot-file' } };
  await assert.rejects(session.snapshot(), /no authoritative input context/);
  assert.equal(session.metadata().inputReady, false);
  mux.extraSnapshot = {};
  await session.snapshot();
  assert.equal(session.metadata().inputReady, true);
  mux.failSnapshots = 'synthetic failure';
  await assert.rejects(session.snapshot(), /synthetic failure/);
  assert.equal(session.metadata().inputReady, false);
  assert.equal(session.metadata().runtimeContext, null);
});

test('identity-only history failure preserves its valid authoritative context', async t => {
  const { session, mux } = await runtimeFixture(t);
  const nextFile = path.join(runtimeEnvironment.sessions, `${randomUUID()}.jsonl`);
  mux.entries = undefined;
  mux.extraSnapshot = { session: { file: nextFile, id: 'history-failed', name: null, cwd }, historyError: 'synthetic history error' };
  await session.snapshot();
  assert.equal(session.sessionFile, nextFile);
  assert.deepEqual(session.entries, []);
  assert.equal(session.metadata().inputReady, true);
  assert.equal(session.metadata().runtimeContext?.sessionFile, nextFile);
});

test('an owning router uncertain-delivery response is not downgraded to a retry-safe rejection', async t => {
  const { session, mux } = await runtimeFixture(t);
  t.after(register(session));
  mux.responses.prompt = { success: false, delivery: 'uncertain', error: 'partial write may have reached Pi' };
  const response = await handleRpcCommand({ type: 'prompt', sessionId: session.id,
    message: 'do not resend automatically', inputContext: captured(session) });
  assert.equal(response.success, false);
  assert.equal(response.delivery, 'uncertain');
});

test('a cross-client replacement after server validation still rejects the original expectation at the router', async t => {
  const { session, mux } = await runtimeFixture(t);
  t.after(register(session));
  const inputContext = captured(session);
  mux.beforeCommand = command => {
    if (command.type === 'prompt') mux.inputContext = { sessionFile: path.join(runtimeEnvironment.sessions, 'racing-file.jsonl'), leafId: null, contextId: 'racing-owner-boundary' };
  };
  const response = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: 'racing old input', inputContext });
  assert.equal(response.success, false);
  assert.equal(response.delivery, 'rejected');
  const forwarded = mux.commands.find(command => command.message === 'racing old input');
  assert.deepEqual(forwarded?.pimuxContext, inputContext.runtimeContext, 'server never substitutes the newer runtime expectation');
});

for (const type of ['set_model', 'set_session_name', 'set_thinking_level', 'clear_queue']) {
  test(`a delayed ${type} outcome cannot overwrite or clear the replacement context`, async t => {
    const { session, mux, manager } = await runtimeFixture(t);
    t.after(register(session));
    const inputContext = captured(session);
    const broadcasts: JsonRecord[] = [];
    t.mock.method(manager, 'broadcast', (record: JsonRecord) => broadcasts.push(record));
    mux.withheld.add(type);
    const pending = handleRpcCommand({ type, id: `old-${type}`, sessionId: session.id,
      inputContext, confirmGlobal: true, provider: 'fx', modelId: 'old-model', name: 'old-title', level: 'minimal' });
    const command = await until(() => mux.commands.find(command => command.type === type), 'old command dispatched');
    const nextFile = path.join(runtimeEnvironment.sessions, `${randomUUID()}.jsonl`);
    mux.extraSnapshot = { session: { file: nextFile, id: 'replacement', name: 'replacement title', cwd },
      model: { provider: 'fx', id: 'replacement-model' }, thinkingLevel: 'high' };
    await session.snapshot();
    broadcasts.length = 0;
    mux.broadcast({ type: 'response', command: type, id: command.id, success: type !== 'set_thinking_level',
      data: { model: { provider: 'fx', id: 'old-model' }, name: 'old-title', thinkingLevel: 'minimal', steering: ['old recovered input'] }, error: 'old outcome' });
    await pending;
    assert.equal(session.sessionFile, nextFile);
    assert.equal(session.model?.id, 'replacement-model');
    assert.equal(session.sessionName, 'replacement title');
    assert.equal(session.thinkingLevel, 'high');
    assert.equal(broadcasts.some(record => (record.event as JsonRecord | undefined)?.type === 'shared_queue_cleared'), false);
    assert.equal(broadcasts.some(record => (record.event as JsonRecord | undefined)?.id === command.id), false);
  });
}

test('an old pending abort cannot cancel dialogs or overwrite abort state after context replacement', async t => {
  const { session, mux } = await runtimeFixture(t);
  t.after(register(session));
  mux.withheld.add('abort');
  const pending = session.abort({ id: 'old-abort' }, { timeoutMs: 100 });
  const failed = assert.rejects(pending, /timed out/);
  const nextFile = path.join(runtimeEnvironment.sessions, `${randomUUID()}.jsonl`);
  mux.extraSnapshot = { session: { file: nextFile, id: 'after-abort', name: null, cwd } };
  mux.replay = [{ type: 'extension_ui_request', id: 'new-dialog', method: 'confirm' }];
  await session.snapshot();
  assert.equal(session.abortState, 'idle');
  assert.equal(session.attachment?.dialogs.has('new-dialog'), true);
  await failed;
  assert.equal(session.abortState, 'idle', 'old timeout cannot mark the new conversation as failed');
  assert.equal(mux.commands.some(command => command.type === 'extension_ui_response' && command.id === 'new-dialog'), false);
});

test('tree-navigation preflight retains its original expected branch across awaited reads', async t => {
  const { session, mux, file } = await runtimeFixture(t);
  t.after(register(session));
  session.capabilities.navigateTree = true;
  session.navigateCommandChecked = true;
  const inputContext = captured(session);
  mux.responses.get_entries = { success: true, data: { leafId: 'current', entries: [
    { id: 'target', parentId: null, type: 'message', message: { role: 'assistant', content: [] } },
    { id: 'current', parentId: null, type: 'message', message: { role: 'assistant', content: [] } },
  ] } };
  mux.beforeCommand = command => {
    if (command.type !== 'get_entries') return;
    mux.extraSnapshot = { session: { file, id: 'same-file', name: null, cwd } };
    mux.leafId = 'replacement-branch';
    for (const socket of mux.connections) mux.snapshot(socket, 'tree_changed');
  };
  const response = await handleRpcCommand({ type: 'navigate_tree', sessionId: session.id, entryId: 'target', inputContext });
  assert.equal(response.success, false);
  assert.equal(mux.commands.some(command => String(command.message).startsWith('/tau-tree-navigate')), false);
});
