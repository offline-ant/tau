import { runtimeEnvironment, cwd } from './runtime-environment.ts';
import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireClaim, lookupClaim, releaseClaim } from '@phimacs/pimux/ownership';
import { readProcessIdentity } from '@phimacs/pimux/process-identity';
import type { StartRuntimeOptions, TerminalReceipt, stopRuntime } from '@phimacs/pimux/runtime';
import type { DiscoveryRecord } from '@phimacs/pimux/discovery';
import { LiveSessionManager } from '../bin/sessions.js';
import { receiptFor, pimuxEntryForFile } from '../bin/pimux.js';
import { withStoppedSessionLease } from '../bin/session-files.js';
import { handleRpcCommand, liveManager } from '../bin/server-main.js';
import { FakePimux, until } from './fake-pimux.ts';

after(() => fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }));
async function fake(t: TestContext, id: string) {
  const file = path.join(runtimeEnvironment.sessions, `${id}.jsonl`);
  const mux = new FakePimux(process.env.PIMUX_DIR!, id, { sessionFile: file, cwd });
  await mux.listen();
  t.after(() => mux.close());
  return { mux, file, entry: mux.entry as unknown as DiscoveryRecord };
}

test('creator uses the same socket, disconnect does not stop, and a later manager reconnects without launch', async t => {
  const { mux, file, entry } = await fake(t, 'equal-peers');
  const launches: StartRuntimeOptions[] = [];
  const manager = new LiveSessionManager({ start: async (options: StartRuntimeOptions) => { launches.push(options); return { ...receiptFor(entry), outcome: 'started' }; } });
  const session = await manager.create({ cwd, model: 'fx/one', sessionFile: undefined, args: undefined, env: { PI_ORCHESTRATION_TARGET: 'explicit-new-target' } });
  assert.equal(session.transport?.kind, 'pimux');
  assert.equal(session.attachment?.ready, true);
  assert.equal(session.runtimeReceipt?.state, 'committed');
  assert.equal(launches.length, 1);
  assert.ok(path.isAbsolute(launches[0].command));
  assert.ok(launches[0].command.includes('/node_modules/@earendil-works/pi-coding-agent/'));
  assert.equal(launches[0].env?.PI_ORCHESTRATION_TARGET, 'explicit-new-target');
  await manager.delete(session.id);
  await until(() => mux.connections.size === 0, 'view disconnected');
  assert.equal(mux.commands.some(command => command.type === 'pimux_stop'), false);
  const successor = new LiveSessionManager({ start: async () => { throw new Error('Reconnect must not launch'); } });
  const resumed = await successor.resume({ sessionFile: file, cwd, refresh: true });
  assert.equal(resumed.started, false);
  assert.equal(resumed.refreshed, true);
  assert.equal(resumed.session.attachment?.muxId, mux.muxId);
  await successor.shutdown();
});

test('idle stop is an explicit identity-bound control operation, not disconnect', async t => {
  const { entry } = await fake(t, 'idle-stop');
  let stopped: { muxId: string; operationId?: string } | undefined;
  const manager = new LiveSessionManager({ stop: async (muxId: string, options: Parameters<typeof stopRuntime>[1]) => {
    stopped = { muxId, operationId: options?.operationId };
    return { protocol: 2, muxId, operationId: options?.operationId ?? randomUUID(), state: 'stopped', code: 0, signal: null, stoppedAt: new Date().toISOString() } satisfies TerminalReceipt;
  } });
  const { session } = await manager.attach(entry);
  assert.equal(session.isStreaming, false);
  const receipt = await session.stop('explicit-operation');
  assert.deepEqual(stopped, { muxId: entry.muxId, operationId: 'explicit-operation' });
  assert.equal(receipt.state, 'stopped');
  await manager.shutdown();
});

test('protocol mismatch and a retained old file refuse without another launch', async t => {
  const { mux, file, entry } = await fake(t, 'unsupported');
  mux.publish({ protocol: 1 });
  let launches = 0;
  const manager = new LiveSessionManager({ start: async () => { launches++; throw new Error('must not launch'); } });
  await assert.rejects(manager.resume({ sessionFile: file, cwd }), /shared|owned|unsupported|connections/i);
  assert.equal(launches, 0);
  mux.publish({ protocol: 2 });
  mux.extraSnapshot = { session: { file: path.join(runtimeEnvironment.sessions, 'other.jsonl'), id: 'other', name: null, cwd } };
  await assert.rejects(manager.attach(entry), /different conversation|attach/i);
  assert.equal(launches, 0);
  await until(() => mux.connections.size === 0, 'failed views disconnected');
});

test('shared dialogs survive run settlement and late dialogs are cancelled during an unresolved Abort', async t => {
  const { mux, entry } = await fake(t, 'late-dialog');
  const manager = new LiveSessionManager();
  const { session } = await manager.attach(entry);
  mux.broadcast({ type: 'extension_ui_request', id: 'first', method: 'confirm', title: 'Keep?' });
  await until(() => session.attachment?.dialogs.has('first'), 'dialog received');
  mux.broadcast({ type: 'agent_settled' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(session.attachment?.dialogs.has('first'), true, 'only mux closure removes a shared dialog');
  mux.withheld.add('abort');
  await assert.rejects(session.abort({ id: 'stop-turn' }, { timeoutMs: 30 }), /timed out/);
  assert.equal(session.abortState, 'timed_out');
  mux.broadcast({ type: 'extension_ui_request', id: 'late', method: 'select', options: ['yes'] });
  await until(() => mux.commands.find(command => command.type === 'extension_ui_response' && command.id === 'late' && command.cancelled === true), 'late cancellation delivered');
  mux.broadcast({ type: 'pimux_dialog_closed', id: 'late', reason: 'answered' });
  await until(() => !session.attachment?.dialogs.has('late'), 'authoritative closure');
  await manager.shutdown();
});

test('only authoritative snapshots replace file, branch and model identity', async t => {
  const { mux, file, entry } = await fake(t, 'identity');
  const manager = new LiveSessionManager();
  const { session } = await manager.attach(entry);
  mux.responses.get_state = { success: true, data: { sessionFile: '/not-the-current-file', isStreaming: false } };
  await session.send({ type: 'get_state' });
  assert.equal(session.sessionFile, file);
  const destination = path.join(runtimeEnvironment.sessions, 'adopted.jsonl');
  mux.entries = [{ id: 'a', parentId: null, type: 'message', message: { role: 'user', content: 'active' } },
    { id: 'abandoned', parentId: null, type: 'message', message: { role: 'user', content: 'not active' } }];
  mux.leafId = 'a';
  mux.extraSnapshot = { session: { file: destination, id: 'new-session', name: 'new', cwd }, model: { provider: 'fx', id: 'deep' }, thinkingLevel: 'high' };
  const snapshot = await session.snapshot();
  assert.equal(snapshot.sessionFile, destination);
  assert.equal(snapshot.session.leafId, 'a');
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.model?.id, 'deep');
  await manager.shutdown();
});

test('a native claim blocks every opener and stopped-file mutation through aliases', async t => {
  const file = path.join(runtimeEnvironment.sessions, 'native.jsonl');
  fs.writeFileSync(file, '{}\n');
  const alias = path.join(runtimeEnvironment.sessions, 'native-alias.jsonl');
  fs.symlinkSync(file, alias);
  const processIdentity = readProcessIdentity(process.pid)!;
  const held = acquireClaim(file, { id: 'native', kind: 'tui', wrapper: processIdentity, pi: processIdentity });
  t.after(() => releaseClaim(held));
  const manager = new LiveSessionManager({ start: async () => { throw new Error('must not reach launch'); } });
  await assert.rejects(manager.resume({ sessionFile: alias, cwd }), /owner|owned|claim/i);
  await assert.rejects(withStoppedSessionLease(alias, () => fs.appendFileSync(file, 'bad')), /owned/i);
  assert.equal(pimuxEntryForFile(alias), undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
});

test('a retained old claim never redirects resume or rename to the runtime’s new conversation', async t => {
  const { mux, file, entry } = await fake(t, 'retained-file');
  fs.writeFileSync(file, '{}\n');
  const identity = readProcessIdentity(process.pid)!;
  const claim = acquireClaim(file, { id: mux.muxId, kind: 'rpc', wrapper: identity, pi: identity,
    protocol: 2, socket: mux.socketPath, operationId: String(entry.operationId) });
  t.after(() => releaseClaim(claim));
  const destination = path.join(runtimeEnvironment.sessions, 'serving-new-file.jsonl');
  mux.publish({ session: { file: destination, id: 'new', name: null } });
  mux.extraSnapshot = { session: { file: destination, id: 'new', name: null, cwd } };
  const manager = new LiveSessionManager({ start: async () => { throw new Error('must not launch'); } });
  await assert.rejects(manager.resume({ sessionFile: file, cwd }), /retained.*another conversation/);
  const renamed = await handleRpcCommand({ type: 'set_session_name', filePath: file, name: 'not the new file' });
  assert.equal(renamed.success, false);
  assert.equal(mux.commands.some(command => command.type === 'set_session_name'), false);
});

test('concurrent attach and creating-client publication converge on one Tau view', async t => {
  const { mux, entry } = await fake(t, 'duplicate-publication');
  mux.withheld.add('get_commands');
  const manager = new LiveSessionManager({ start: async () => ({ ...receiptFor(entry), outcome: 'started' }) });
  const creating = manager.create({ cwd, model: undefined, sessionFile: undefined, args: undefined, env: undefined });
  const attaching = manager.attach(entry);
  await until(() => mux.commands.filter(command => command.type === 'get_commands').length === 2, 'both view startups reach capabilities');
  for (const command of mux.commands.filter(command => command.type === 'get_commands')) mux.broadcast({ type: 'response', command: 'get_commands', id: command.id, success: true, data: { commands: [] } });
  const [created, attached] = await Promise.all([creating, attaching]);
  assert.equal(manager.sessions.size, 1);
  assert.equal(created, attached.session);
  await manager.shutdown();
});

test('stopped mutation leases cover the transaction and release on failure', async () => {
  const file = path.join(runtimeEnvironment.sessions, 'lease.jsonl');
  fs.writeFileSync(file, '{}\n');
  await withStoppedSessionLease(file, () => {
    assert.equal(lookupClaim(file)?.owner.kind, 'lease');
    fs.appendFileSync(file, '{}\n');
  });
  assert.equal(lookupClaim(file), undefined);
  await assert.rejects(withStoppedSessionLease(file, () => { throw new Error('validation failed'); }), /validation failed/);
  assert.equal(lookupClaim(file), undefined);
});

test('shared clear_queue requires global confirmation and recovery is sent only to its requester', async t => {
  const { mux, entry } = await fake(t, 'global-queue');
  const { session } = await liveManager.attach(entry);
  t.after(() => liveManager.shutdown());
  const broadcasts: unknown[] = [];
  t.mock.method(liveManager, 'broadcast', (record: unknown) => broadcasts.push(record));
  const rejected = await handleRpcCommand({ type: 'clear_queue', sessionId: session.id });
  assert.equal(rejected.success, false);
  assert.equal(mux.commands.some(command => command.type === 'clear_queue'), false);
  mux.responses.clear_queue = { success: true, data: { steering: ['shared input'], followUp: [] } };
  const response = await handleRpcCommand({ type: 'clear_queue', sessionId: session.id, confirmGlobal: true });
  assert.equal(response.success, true);
  assert.ok(response.recoveryContext);
  assert.deepEqual(response.data, { steering: ['shared input'], followUp: [] });
  assert.equal(JSON.stringify(broadcasts).includes('shared input'), false, 'recovery is private to the requester, not a false per-client restoration');
  assert.ok(JSON.stringify(broadcasts).includes('shared_queue_cleared'));
});
