import { runtimeEnvironment, cwd } from './runtime-environment.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FakeRuntimeLauncher } from './runtime-launcher.ts';
import { readProcessIdentity } from '@phimacs/pimux/process-identity';
import { LiveSessionManager, parseSpawnOverrides, buildEndpoint, orchestrationEndpoint, SESSIONS_DIR, PI_COMMAND, _setCredentialsForTest } from '../bin/tau.js';
import { RUNTIME_FILE, publishEndpoint, unpublishEndpoint, buildBrowserUrls } from '../bin/orchestration.js';
import { TAU_SETTINGS } from '../bin/config.js';

before(() => {
  _setCredentialsForTest('test-user', 'synthetic-password');
  TAU_SETTINGS.hostnames = ['tau-test.invalid'];
});
after(() => fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }));

function sessionFileFixture(name: string): string {
  const directory = path.join(SESSIONS_DIR, '--synthetic--orchestration');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: name, cwd }) + '\n');
  return file;
}

test('launch overrides are validated before a managed runtime is started', () => {
  assert.deepEqual(parseSpawnOverrides({}), {});
  assert.deepEqual(parseSpawnOverrides({ args: ['--model', 'fx/one'], env: { PI_NESTED: '1' } }),
    { args: ['--model', 'fx/one'], env: { PI_NESTED: '1' } });
  assert.throws(() => parseSpawnOverrides({ args: '--model' }), /args must be an array of strings/);
  assert.throws(() => parseSpawnOverrides({ args: [1] }), /args must be an array of strings/);
  assert.throws(() => parseSpawnOverrides({ env: ['PI_NESTED=1'] }), /env must be an object of string values/);
  assert.throws(() => parseSpawnOverrides({ env: { PI_NESTED: 1 } }), /env.PI_NESTED must be a string/);
  assert.throws(() => parseSpawnOverrides({ env: { 'BAD NAME': 'x' } }), /Invalid environment variable name/);
  assert.throws(() => parseSpawnOverrides({ sessionFile: '/etc/passwd' }), /Invalid session file/);
  const file = sessionFileFixture('overrides.jsonl');
  assert.deepEqual(parseSpawnOverrides({ sessionFile: file }), { sessionFile: file });
});

test('a created shared runtime receives the caller arguments, environment, exact file and release host', async t => {
  const launcher = new FakeRuntimeLauncher();
  const manager = new LiveSessionManager({ start: launcher.start });
  t.after(async () => { await manager.shutdown(); await launcher.close(); unpublishEndpoint(); });
  publishEndpoint(3001, 3443, '0.0.0.0');
  const file = sessionFileFixture('created.jsonl');
  const session = await manager.create({ cwd, sessionFile: file, model: undefined,
    args: ['--provider', 'fx', '--model', 'one'], env: { PI_NESTED: '1' } });
  assert.equal(launcher.calls.length, 1);
  const call = launcher.calls[0];
  assert.equal(call.command, PI_COMMAND);
  assert.equal(path.isAbsolute(call.command), true);
  assert.equal(call.expectedHost?.version, '1.4.0');
  assert.match(call.expectedHost?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(call.args.slice(0, 2), ['--mode', 'rpc']);
  assert.deepEqual(call.args.slice(-6), ['--session', file, '--provider', 'fx', '--model', 'one']);
  assert.equal(call.env?.PI_NESTED, '1');
  assert.equal(call.env?.TAU_DISABLED, '1');
  assert.equal(call.env?.PI_ORCHESTRATION_HOST, 'web');
  assert.equal(call.env?.PI_ORCHESTRATION_ENDPOINT, orchestrationEndpoint());
  assert.equal(session.transport?.kind, 'pimux');
  assert.equal(session.attachment?.ready, true);
});

test('workers pass an exact parent task identity to the owning launcher', async t => {
  const launcher = new FakeRuntimeLauncher();
  const manager = new LiveSessionManager({ start: launcher.start });
  t.after(async () => { await manager.shutdown(); await launcher.close(); });
  const parent = { process: readProcessIdentity(process.pid)!, taskId: 'synthetic-task' };
  await manager.create({ cwd, sessionFile: undefined, model: undefined, args: undefined,
    env: { PI_ORCHESTRATION_PLACEMENT: 'worker', PHIMACS_PARENT_TASK: JSON.stringify(parent) } });
  assert.deepEqual(launcher.calls[0].parent, parent);
  assert.equal(launcher.calls[0].env?.PI_ORCHESTRATION_PLACEMENT, 'worker');
});

test('malformed parent identities are rejected before any runtime launch', async () => {
  const launcher = new FakeRuntimeLauncher();
  const manager = new LiveSessionManager({ start: launcher.start });
  await assert.rejects(manager.create({ cwd, sessionFile: undefined, model: undefined, args: undefined,
    env: { PHIMACS_PARENT_TASK: JSON.stringify({ process: {}, taskId: 'invalid' }) } }), /Invalid parent task identity/);
  assert.equal(launcher.calls.length, 0);
});

test('browser URLs are HTTPS origins for the bound address/family without credentials or scoped IPv6', () => {
  const entry = (address: string, internal = false): os.NetworkInterfaceInfo => ({
    address, internal, family: address.includes(':') ? 'IPv6' : 'IPv4',
    netmask: '', mac: '', cidr: null, ...(address.includes(':') ? { scopeid: 0 } : {}),
  } as os.NetworkInterfaceInfo);
  const interfaces = {
    lo: [entry('127.0.0.1', true), entry('::1', true)],
    eth0: [entry('10.99.0.1'), entry('2001:db8::1'), entry('fe80::1'), entry('fe80::2%eth0')],
    wg0: [entry('10.10.0.2')], duplicate: [entry('10.10.0.2')],
  };
  assert.deepEqual(buildBrowserUrls(3443, '0.0.0.0', ['tau-test.invalid'], interfaces), [
    'https://tau-test.invalid:3443', 'https://10.99.0.1:3443', 'https://10.10.0.2:3443', 'https://127.0.0.1:3443',
  ]);
  assert.deepEqual(buildBrowserUrls(3443, '::', [], interfaces), ['https://[2001:db8::1]:3443', 'https://[::1]:3443']);
  assert.deepEqual(buildBrowserUrls(3443, '127.0.0.1', ['tau-test.invalid'], interfaces), ['https://127.0.0.1:3443']);
  assert.deepEqual(buildBrowserUrls(3443, '10.10.0.2', [], interfaces), ['https://10.10.0.2:3443']);
  assert.deepEqual(buildBrowserUrls(3443, '::1', [], interfaces), ['https://[::1]:3443']);
  assert.deepEqual(buildBrowserUrls(3443, '2001:db8::1', [], interfaces), ['https://[2001:db8::1]:3443']);
  assert.deepEqual(buildBrowserUrls(3443, 'fe80::1%eth0', [], interfaces), []);
  assert.deepEqual(buildBrowserUrls(3443, 'localhost', [], interfaces), []);
});

test('publication pairs the credentialed loopback HTTP endpoint with the actual HTTPS listener', t => {
  publishEndpoint(4321, 4443, '::1');
  t.after(unpublishEndpoint);
  const published = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  assert.equal(published.endpoint, 'http://test-user:synthetic-password@127.0.0.1:4321');
  assert.deepEqual(published.browserUrls, ['https://[::1]:4443']);
});

test('the published endpoint carries credentials privately and belongs to one running server', t => {
  assert.equal(buildEndpoint(3001), 'http://test-user:synthetic-password@127.0.0.1:3001');
  publishEndpoint(3001, 3443, '0.0.0.0');
  t.after(unpublishEndpoint);
  assert.equal(orchestrationEndpoint(), buildEndpoint(3001));
  const published = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  assert.equal(published.endpoint, buildEndpoint(3001));
  assert.equal(published.pid, process.pid);
  assert.deepEqual(published.browserUrls, buildBrowserUrls(3443, '0.0.0.0'));
  assert.equal(published.browserUrls[0], 'https://tau-test.invalid:3443');
  assert.ok(published.browserUrls.includes('https://127.0.0.1:3443'));
  for (const value of published.browserUrls) {
    const url = new URL(value);
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.protocol, 'https:');
    assert.equal(url.port, '3443');
  }
  assert.equal(fs.statSync(RUNTIME_FILE).mode & 0o777, 0o600);
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ endpoint: 'http://127.0.0.1:9999', pid: process.ppid, startedAt: new Date().toISOString() }));
  publishEndpoint(3002, 3444);
  assert.equal(JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')).endpoint, 'http://127.0.0.1:9999');
  unpublishEndpoint();
  assert.equal(fs.existsSync(RUNTIME_FILE), true);
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ endpoint: 'http://127.0.0.1:9999', pid: 0x7fffffff, startedAt: new Date().toISOString() }));
  publishEndpoint(3003, 3445);
  assert.equal(JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')).pid, process.pid);
  unpublishEndpoint();
  assert.equal(fs.existsSync(RUNTIME_FILE), false);
});
