import { runtimeEnvironment, cwd } from './runtime-environment.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { listRuntimes, stopRuntime } from '@phimacs/pimux/runtime';
import { processIdentityStatus, readProcessIdentity } from '@phimacs/pimux/process-identity';
import { acquireClaim, releaseClaim } from '@phimacs/pimux/ownership';
import type { JsonRecord } from '../src/server/types.ts';
import { until } from './e2e/fixtures/detached-peer.ts';

const cli = fileURLToPath(new URL('../bin/tau.js', import.meta.url));
const faux = fileURLToPath(new URL('./e2e/fixtures/pimux-faux.ts', import.meta.url));
after(() => fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }));
async function server(): Promise<{ child: ChildProcess; endpoint: string }> {
  const child = spawn(process.execPath, [cli], { env: { ...process.env }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout!.on('data', (data: Buffer) => { text += data.toString(); });
  child.stderr!.on('data', (data: Buffer) => { text += data.toString(); });
  const endpoint = await until(() => {
    if (child.exitCode !== null) throw new Error(`Server failed: ${text}`);
    return /Local orchestration \(loopback HTTP\): (http:\/\/127\.0\.0\.1:\d+)/.exec(text)?.[1];
  }, 'isolated Tau listener', 30000);
  return { child, endpoint };
}
async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = once(child, 'close');
  child.kill('SIGTERM');
  await exited;
}
async function request(endpoint: string, route: string, body?: unknown, method = 'POST'): Promise<{ status: number; data: JsonRecord }> {
  const response = await fetch(endpoint + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as JsonRecord };
}

function browserContext(session: JsonRecord) {
  const runtime = session.runtime as JsonRecord;
  return { agentId: runtime.muxId, file: session.sessionFile, leafId: session.leafId, runtimeContext: session.runtimeContext };
}

test('real faux root survives server exit, reattaches symmetrically, exports safely and stops with a retained receipt', { timeout: 120000 }, async t => {
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) await stopServer(child);
    for (const runtime of listRuntimes()) await stopRuntime(runtime.muxId).catch(() => {});
  });
  const first = await server();
  children.push(first.child);
  const created = await request(first.endpoint, '/api/live-sessions', { cwd, model: 'tau-fx/one', args: [
    '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--extension', faux,
  ] });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const session = created.data.session as JsonRecord;
  const runtime = session.runtime as JsonRecord;
  assert.equal(runtime.protocol, 2);
  assert.equal(runtime.outcome, 'started');
  assert.equal((session.capabilities as JsonRecord).navigateTree, true);
  const pi = readProcessIdentity(Number(runtime.piPid))!;
  assert.ok(pi);
  const prompt = await request(first.endpoint, '/api/rpc', { type: 'prompt', sessionId: session.id, message: 'hello detached runtime', inputContext: browserContext(session) });
  assert.equal(prompt.data.success, true, JSON.stringify(prompt.data));
  await until(() => fs.existsSync(String(session.sessionFile)) && fs.readFileSync(String(session.sessionFile), 'utf8').includes('reply: hello detached runtime'), 'faux response persisted', 15000);
  await until(() => listRuntimes().find(entry => entry.muxId === runtime.muxId)?.status === 'idle', 'faux turn settled');
  const beforeNavigation = await request(first.endpoint, `/api/live-sessions/${session.id}/snapshot`, undefined, 'GET');
  const question = (beforeNavigation.data.entries as JsonRecord[]).find(entry => (entry.message as JsonRecord | undefined)?.role === 'user');
  assert.ok(question);
  const navigation = await request(first.endpoint, '/api/rpc', { type: 'navigate_tree', sessionId: session.id, entryId: question.id, inputContext: browserContext(beforeNavigation.data.session as JsonRecord) });
  assert.equal(navigation.data.success, true, JSON.stringify(navigation.data));
  assert.equal((navigation.data.data as JsonRecord).editorText, 'hello detached runtime');
  await stopServer(first.child);
  assert.equal(processIdentityStatus(pi), 'alive', 'frontend shutdown must not stop the committed Pi');
  const second = await server();
  children.push(second.child);
  const attached = await request(second.endpoint, '/api/live-sessions/attach', { muxId: runtime.muxId });
  assert.equal(attached.status, 200, JSON.stringify(attached.data));
  const tab = attached.data.session as JsonRecord;
  assert.equal((tab.runtime as JsonRecord).piPid, runtime.piPid);
  assert.equal((tab.runtime as JsonRecord).outcome, 'attached');
  assert.equal(listRuntimes().filter(entry => entry.muxId === runtime.muxId).length, 1);
  const exported = await request(second.endpoint, '/api/rpc', { type: 'export_html', sessionId: tab.id, inputContext: browserContext(tab) });
  assert.equal(exported.data.success, true, JSON.stringify(exported.data));
  const html = fs.readFileSync(String((exported.data.data as JsonRecord).path), 'utf8');
  const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html)?.[1];
  assert.ok(encoded);
  assert.ok(Buffer.from(encoded, 'base64').toString('utf8').includes('hello detached runtime'));
  const detached = await request(second.endpoint, `/api/live-sessions/${tab.id}`, undefined, 'DELETE');
  assert.equal(detached.status, 200);
  assert.equal(processIdentityStatus(pi), 'alive');
  const resumed = await request(second.endpoint, '/api/live-sessions/resume', { filePath: session.sessionFile, refresh: true });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  assert.equal(resumed.data.started, false);
  const resumedTab = resumed.data.session as JsonRecord;
  const stopped = await request(second.endpoint, `/api/live-sessions/${resumedTab.id}/stop`, { operationId: 'owned-close' });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  assert.equal((stopped.data.receipt as JsonRecord).state, 'stopped');
  assert.equal(processIdentityStatus(pi), 'dead');
  await until(async () => ((await request(second.endpoint, '/api/live-sessions', undefined, 'GET')).data.sessions as JsonRecord[]).length === 0, 'acknowledged Close removes its Tau view');
  const repeated = await request(second.endpoint, `/api/agents/${runtime.muxId}/stop`, { operationId: 'reconcile-lost-ack' });
  assert.equal(repeated.status, 200, JSON.stringify(repeated.data));
  assert.deepEqual(repeated.data.receipt, stopped.data.receipt);
});

test('new roots keep different projects in separate lazy history directories', { timeout: 60000 }, async t => {
  const tau = await server();
  t.after(async () => {
    await stopServer(tau.child);
    for (const runtime of listRuntimes()) await stopRuntime(runtime.muxId).catch(() => {});
  });
  const projects = [path.join(runtimeEnvironment.root, 'project-second'), path.join(runtimeEnvironment.root, 'project-third')];
  const files: string[] = [];
  for (const directory of projects) {
    fs.mkdirSync(directory, { mode: 0o700 });
    const response = await request(tau.endpoint, '/api/live-sessions', { cwd: directory, model: 'tau-fx/one', args: [
      '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--extension', faux,
    ] });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const session = response.data.session as JsonRecord;
    files.push(String(session.sessionFile));
    const prompted = await request(tau.endpoint, '/api/rpc', { type: 'prompt', sessionId: session.id, message: 'persist this project', inputContext: browserContext(session) });
    assert.equal(prompted.data.success, true);
    await until(() => fs.existsSync(String(session.sessionFile)), 'project transcript created');
  }
  assert.notEqual(path.dirname(files[0]), path.dirname(files[1]));
  const listing = await request(tau.endpoint, '/api/sessions', undefined, 'GET');
  assert.equal(listing.status, 200);
  const known = listing.data.projects as JsonRecord[];
  for (const directory of projects) assert.ok(known.some(project => project.path === directory && project.count === 1));
});

test('two real Tau clients reject delayed input after a shared file replacement', { timeout: 120000 }, async t => {
  const first = await server();
  const second = await server();
  t.after(async () => {
    await stopServer(first.child);
    await stopServer(second.child);
    for (const runtime of listRuntimes()) await stopRuntime(runtime.muxId).catch(() => {});
  });
  const created = await request(first.endpoint, '/api/live-sessions', { cwd, model: 'tau-fx/one', args: [
    '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--extension', faux,
  ] });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const origin = created.data.session as JsonRecord;
  const runtime = origin.runtime as JsonRecord;
  const attached = await request(second.endpoint, '/api/live-sessions/attach', { muxId: runtime.muxId });
  assert.equal(attached.status, 200, JSON.stringify(attached.data));
  const peer = attached.data.session as JsonRecord;
  const oldContext = browserContext(peer);
  const replaced = await request(first.endpoint, '/api/rpc', { type: 'new_session', sessionId: origin.id, inputContext: browserContext(origin) });
  assert.equal(replaced.data.success, true, JSON.stringify(replaced.data));
  const boundary = await request(second.endpoint, `/api/live-sessions/${peer.id}/snapshot`, undefined, 'GET');
  assert.equal(boundary.status, 200, JSON.stringify(boundary.data));
  const next = boundary.data.session as JsonRecord;
  assert.notEqual((next.runtimeContext as JsonRecord).contextId, (oldContext.runtimeContext as JsonRecord).contextId);
  assert.notEqual(next.sessionFile, oldContext.file);
  const delayed = await request(second.endpoint, '/api/rpc', { type: 'prompt', sessionId: peer.id,
    message: 'never forward this old instruction', inputContext: oldContext });
  assert.equal(delayed.data.success, false);
  assert.equal(delayed.data.delivery, 'rejected');
  const accepted = await request(second.endpoint, '/api/rpc', { type: 'prompt', sessionId: peer.id,
    message: 'the new context is explicit', inputContext: browserContext(next) });
  assert.equal(accepted.data.success, true, JSON.stringify(accepted.data));
  await until(() => fs.existsSync(String(next.sessionFile)) && fs.readFileSync(String(next.sessionFile), 'utf8').includes('reply: the new context is explicit'), 'new contextual reply persisted', 15000);
  assert.equal(fs.readFileSync(String(next.sessionFile), 'utf8').includes('never forward this old instruction'), false);
  assert.equal(listRuntimes().filter(entry => entry.muxId === runtime.muxId).length, 1);
  const identity = readProcessIdentity(Number(runtime.piPid))!;
  const closed = await request(second.endpoint, `/api/live-sessions/${peer.id}/stop`, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal((closed.data.receipt as JsonRecord).muxId, runtime.muxId);
  assert.equal(processIdentityStatus(identity), 'dead');
  for (const tau of [first, second]) {
    await until(async () => {
      const live = await request(tau.endpoint, '/api/live-sessions', undefined, 'GET');
      return !(live.data.sessions as JsonRecord[]).some(session => (session.runtime as JsonRecord).muxId === runtime.muxId);
    }, 'Close removes the agent from every Tau frontend');
  }
});

test('HTTP force never overrides a native owner or a stopped-file mutation lease', { timeout: 30000 }, async t => {
  // This test runs before file-level cleanup in its own fresh process when selected.
  fs.mkdirSync(runtimeEnvironment.sessions, { recursive: true });
  const file = path.join(runtimeEnvironment.sessions, 'native-owner.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'native', cwd, timestamp: new Date().toISOString() }) + '\n');
  const identity = readProcessIdentity(process.pid)!;
  const claim = acquireClaim(file, { kind: 'tui', id: 'native-owner', wrapper: identity, pi: identity });
  t.after(() => releaseClaim(claim));
  const tau = await server();
  t.after(() => stopServer(tau.child));
  const response = await request(tau.endpoint, '/api/live-sessions/resume', { filePath: file, force: true });
  assert.equal(response.status, 409, JSON.stringify(response.data));
  const renamed = await request(tau.endpoint, '/api/rpc', { type: 'set_session_name', filePath: file, name: 'must not append' });
  assert.equal(renamed.data.success, false);
  const removed = await request(tau.endpoint, '/api/sessions/delete', { filePath: file });
  assert.equal(removed.status, 409);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('must not append'));
});
