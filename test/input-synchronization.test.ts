import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveSessionManager, _setSpawnPiForTest } from '../bin/sessions.js';
import { FakePi, flushIo } from './fake-pi.ts';
import type { RpcCommand, RpcResponse, JsonRecord } from '../src/server/types.ts';
import type { PiRpcSession } from '../src/server/sessions.ts';
type SessionSnapshot = Awaited<ReturnType<PiRpcSession['snapshot']>>;
import type { TestContext } from 'node:test';

async function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-input-sync-'));
  const original = path.join(directory, 'original.jsonl');
  const destination = path.join(directory, 'destination.jsonl');
  const cwd = path.join(directory, 'destination');
  fs.mkdirSync(cwd);
  const header = { type: 'session', id: 'destination', cwd };
  fs.writeFileSync(destination, JSON.stringify(header) + '\n');
  const child = new FakePi({ sessionFile: original, state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } });
  _setSpawnPiForTest(() => child.asChild());
  t.after(() => _setSpawnPiForTest(null));
  const manager = new LiveSessionManager();
  const session = await manager.create({ cwd: directory, model: undefined, sessionFile: undefined, args: undefined, env: undefined });
  t.after(async () => { await manager.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
  session.entries = [{ type: 'session', id: 'original', cwd: directory }, { type: 'message', id: 'old', message: { role: 'user', content: 'Old conversation' } }];
  const broadcasts: JsonRecord[] = [];
  const observerBroadcasts: JsonRecord[] = [];
  manager.addClient({ readyState: 1, send: (payload: string) => broadcasts.push(JSON.parse(payload) as JsonRecord) });
  manager.addClient({ readyState: 1, send: (payload: string) => observerBroadcasts.push(JSON.parse(payload) as JsonRecord) });
  child.autoRespond = false;
  child.commands.length = 0;
  return { child, manager, session, original, destination, cwd, header, broadcasts, observerBroadcasts };
}

function entry(id: string, parentId: string | null, text: string) {
  return { type: 'message', id, parentId, message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

test('handled cross-file and same-file replacements publish completion only after current workspace and selected history are reconstructed', async (t) => {
  const f = await fixture(t);
  const { child, session, manager, original, destination, cwd, header, broadcasts, observerBroadcasts } = f;
  const root = entry('root', null, 'Question');
  const selected = entry('selected', 'root', 'Selected answer');
  const abandoned = entry('abandoned', 'root', 'Abandoned answer');
  child.tree = [{ entry: root, children: [{ entry: selected }, { entry: abandoned }] }];
  child.leafId = selected.id;
  child.state = { ...child.state, sessionFile: destination, model: { provider: 'example', id: 'new/model' }, thinkingLevel: 'high', sessionName: null };
  let completed = false;
  const command = session.send({ type: 'prompt', message: '/replace-session' }).then((response: RpcResponse) => { completed = true; return response; });
  child.respond(child.commands[0], { data: { disposition: 'handled' } });
  let snapshotted = false;
  const snapshot = session.snapshot().then((value: SessionSnapshot) => { snapshotted = true; return value; });
  await flushIo();
  assert.equal(completed, false);
  assert.equal(snapshotted, false);
  assert.deepEqual(child.commands.map((value) => value.type), ['prompt', 'get_state']);
  assert.equal(manager.findBySessionFile(original), session);
  child.respond(child.commands[1]);
  await flushIo();
  assert.equal(completed, false);
  assert.equal(snapshotted, false);
  assert.equal(manager.findBySessionFile(original), session, 'the original remains associated until the selected tree is confirmed');
  assert.equal(manager.findBySessionFile(destination), session);
  await assert.rejects(manager.resume({ sessionFile: destination, cwd, refresh: true }), /busy/);
  assert.equal(broadcasts.some((value) => (value.event as JsonRecord | undefined)?.command === 'prompt'), false);
  assert.equal(observerBroadcasts.some(value => value.type === 'live_session_snapshot'), false, 'other browsers must not see an unconfirmed replacement');
  child.respond(child.commands[2]);
  const [response, current] = await Promise.all([command, snapshot]);
  assert.equal(response.success, true);
  assert.equal(current.session.cwd, cwd);
  assert.equal(current.sessionFile, destination);
  assert.deepEqual(current.model, { provider: 'example', id: 'new/model' });
  assert.equal(current.thinkingLevel, 'high');
  assert.equal(current.sessionName, null);
  assert.deepEqual(current.entries, [header, root, selected]);
  assert.equal(manager.findBySessionFile(original), undefined);
  assert.equal(session.pending.size, 0);
  assert.equal(broadcasts.filter((value) => (value.event as JsonRecord | undefined)?.command === 'prompt').length, 1);
  for (const client of [broadcasts, observerBroadcasts]) {
    const published = client.filter(value => value.type === 'live_session_snapshot');
    assert.equal(published.length, 1);
    assert.equal(published[0].sessionId, session.id);
    assert.equal((published[0].session as JsonRecord).cwd, cwd);
    assert.equal(published[0].sessionFile, destination);
    assert.deepEqual(published[0].entries, current.entries);
    assert.deepEqual(published[0].model, current.model);
    assert.equal(published[0].thinkingLevel, current.thinkingLevel);
    const metadata = client.filter(value => value.type === 'live_session_updated').at(-1)?.session as JsonRecord;
    assert.equal(metadata.cwd, cwd);
    assert.equal(metadata.sessionFile, destination);
    assert.ok(client.findIndex(value => value.type === 'live_session_snapshot') < client.findIndex(value => (value.event as JsonRecord | undefined)?.command === 'prompt'), 'all browsers receive replacement history before the real prompt completion');
  }

  // Native same-file reloads do not change the path: their selected branch must
  // still replace the old cache rather than concatenate or retain abandoned text.
  child.commands.length = 0;
  child.leafId = abandoned.id;
  const reload = session.send({ type: 'prompt', message: '/reload-conversation' });
  child.respond(child.commands[0], { data: { disposition: 'handled' } });
  await flushIo();
  child.respond(child.commands[1]);
  await flushIo();
  child.respond(child.commands[2]);
  assert.equal((await reload).success, true);
  assert.deepEqual((await session.snapshot()).entries, [header, root, abandoned]);
  const observerSnapshots = observerBroadcasts.filter(value => value.type === 'live_session_snapshot');
  assert.equal(observerSnapshots.length, 2, 'the passive browser sees same-file branch replacement too, without fetching a snapshot');
  assert.deepEqual(observerSnapshots[1].entries, [header, root, abandoned]);
});

test('inference and queued input acknowledgements synchronize state without waiting for the running agent or replacing its streamed cache', async (t) => {
  const { child, session, observerBroadcasts } = await fixture(t);
  const question = { role: 'user', content: 'Work normally' };
  const answer = { role: 'assistant', content: [{ type: 'text', text: 'Streaming result' }] };
  for (const disposition of ['started', 'queued']) {
    child.commands.length = 0;
    const sent = session.send({ type: 'prompt', message: disposition });
    child.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'message_start', message: question }) + '\n');
    child.respond(child.commands[0], { data: { disposition } });
    await flushIo();
    child.state.isStreaming = true;
    child.state.pendingMessageCount = disposition === 'queued' ? 1 : 0;
    child.respond(child.commands[1]);
    child.stdout.write(JSON.stringify({ type: 'message_end', message: answer }) + '\n');
    assert.equal((await sent).success, true);
    const snapshot = await session.snapshot();
    assert.equal(snapshot.isStreaming, true);
    assert.deepEqual(child.commands.map((value: RpcCommand) => value.type), ['prompt', 'get_state']);
    assert.deepEqual(snapshot.entries.slice(-2), [{ type: 'message', message: question }, { type: 'message', message: answer }]);
  }
  assert.equal(observerBroadcasts.some(value => value.type === 'live_session_snapshot'), false, 'normal inference uses its streamed events, not replacement fanout');
});

test('failed history rebuilds retain ownership and retry on later snapshots instead of poisoning the tab', async (t) => {
  const { child, session, manager, original, destination, observerBroadcasts } = await fixture(t);
  const sent = session.send({ type: 'prompt', message: '/replace-session' });
  child.state.sessionFile = destination;
  child.respond(child.commands[0], { data: { disposition: 'handled' } });
  await flushIo();
  child.respond(child.commands[1]);
  await flushIo();
  child.leafId = 'missing';
  child.autoRespond = true;
  child.respond(child.commands[2]);
  const response = await sent;
  await assert.rejects(session.snapshot(), /omitted the active leaf/);
  assert.equal(response.success, false);
  assert.match(String(response.error), /Could not synchronize.*omitted the active leaf/);
  assert.equal(manager.findBySessionFile(original), session);
  await assert.rejects(manager.resume({ sessionFile: original, cwd: session.cwd, refresh: true }), /busy/);
  assert.deepEqual(child.signals, []);
  assert.equal(observerBroadcasts.some(value => value.type === 'live_session_snapshot'), false, 'failed synchronization never publishes replacement history');

  const recovered = entry('recovered', null, 'Recovered current conversation');
  child.tree = [{ entry: recovered }];
  child.leafId = recovered.id;
  const current = await session.snapshot();
  assert.equal(current.sessionFile, destination);
  assert.deepEqual(current.entries.slice(1), [recovered]);
  assert.equal(manager.findBySessionFile(original), undefined, 'a successful retry releases the obsolete file association');
  assert.equal(observerBroadcasts.filter(value => value.type === 'live_session_snapshot').length, 1);
});

test('fresh unwritten tabs accept handled commands without a file header and a later unreadable replacement can recover on input', async (t) => {
  const { child, session, manager, original, destination, cwd, header, observerBroadcasts } = await fixture(t);
  session.entries = [];
  assert.equal(fs.existsSync(original), false, 'Pi does not persist a new session until its first message');
  for (const message of ['/tools', '/browser status', '/take herdr']) {
    child.commands.length = 0;
    const sent = session.send({ type: 'prompt', message });
    child.respond(child.commands[0], { data: { disposition: 'handled' } });
    await flushIo();
    child.respond(child.commands[1]);
    await flushIo();
    child.respond(child.commands[2]);
    assert.equal((await sent).success, true);
    const snapshot = await session.snapshot();
    assert.equal(snapshot.session.cwd, path.dirname(original));
    assert.deepEqual(snapshot.entries, []);
  }
  assert.equal(fs.existsSync(original), false, 'handled commands must not require or invent a transcript');
  observerBroadcasts.length = 0;

  fs.unlinkSync(destination);
  child.commands.length = 0;
  const replacement = session.send({ type: 'prompt', message: '/replace-session' });
  child.state.sessionFile = destination;
  child.respond(child.commands[0], { data: { disposition: 'handled' } });
  await flushIo();
  child.respond(child.commands[1]);
  const failure = await replacement;
  assert.equal(failure.success, false);
  assert.match(String(failure.error), /Could not synchronize.*ENOENT/);
  assert.equal(manager.findBySessionFile(original), session);
  assert.equal(observerBroadcasts.some(value => value.type === 'live_session_snapshot'), false);

  fs.writeFileSync(destination, JSON.stringify(header) + '\n');
  const answer = entry('answer', null, 'Replacement recovered');
  child.tree = [{ entry: answer }];
  child.leafId = answer.id;
  child.autoRespond = true;
  assert.equal((await session.send({ type: 'prompt', message: '/browser status' })).success, true);
  const current = await session.snapshot();
  assert.equal(current.session.cwd, cwd);
  assert.deepEqual(current.entries, [header, answer]);
  assert.equal(manager.findBySessionFile(original), undefined);
  assert.equal(observerBroadcasts.filter(value => value.type === 'live_session_snapshot').length, 1);
});

test('Tau children discard inherited pane and managed identities but retain explicit worker overrides', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-child-env-'));
  const identities = {
    HERDR_ENV: '1', HERDR_SOCKET_PATH: '/herdr/server.sock', HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1', HERDR_PANE_ID: 'w1:p1',
    TMUX: '/tmux/socket,1,0', TMUX_PANE: '%1', PI_NESTED: '2', PI_ORCHESTRATION_HOST: 'herdr',
    PI_ORCHESTRATION_ENDPOINT: '/herdr/server.sock', PI_ORCHESTRATION_TARGET: '/old/target', PI_ORCHESTRATION_CONTROL: '/old/control.sock',
  };
  const previous = Object.fromEntries(Object.keys(identities).map(key => [key, process.env[key]]));
  Object.assign(process.env, identities);
  const environments: Record<string, string>[] = [];
  _setSpawnPiForTest((_command: string, _args: string[], options: JsonRecord) => {
    environments.push(options.env as Record<string, string>);
    return new FakePi({ sessionFile: path.join(directory, `${environments.length}.jsonl`) }).asChild();
  });
  const manager = new LiveSessionManager();
  t.after(async () => {
    await manager.shutdown();
    _setSpawnPiForTest(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await manager.create({ cwd: directory, model: undefined, sessionFile: undefined, args: undefined, env: undefined });
  for (const key of Object.keys(identities)) {
    if (key === 'PI_ORCHESTRATION_HOST') assert.equal(environments[0][key], 'web');
    else if (key === 'HERDR_SOCKET_PATH') assert.equal(environments[0][key], identities.HERDR_SOCKET_PATH, 'retain server discovery, not pane identity');
    else assert.equal(environments[0][key], undefined, `${key} must not identify the server launcher as the Tau child`);
  }
  const worker = { PI_NESTED: '1', PI_ORCHESTRATION_TARGET: '/new/target', PI_ORCHESTRATION_CONTROL: '/new/control.sock', PI_ORCHESTRATION_ENDPOINT: 'http://127.0.0.1:1234' };
  await manager.create({ cwd: directory, model: undefined, sessionFile: undefined, args: undefined, env: worker });
  for (const [key, value] of Object.entries(worker)) assert.equal(environments[1][key], value);
  assert.equal(environments[1].PI_ORCHESTRATION_HOST, 'web');
  assert.equal(environments[1].HERDR_PANE_ID, undefined);
});
