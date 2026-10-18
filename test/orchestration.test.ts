import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FakePi } from './fake-pi.ts';

// Load the server after the env is in place: config is read at load time, and
// ESM hoists static imports ahead of this body.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-orch-'));
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');
process.env.TAU_HOST = '0.0.0.0';
process.env.TAU_USER = 'rs';
process.env.TAU_PASS = 'l';

const { LiveSessionManager, parseSpawnOverrides, buildEndpoint, orchestrationEndpoint, SESSIONS_DIR, _setSpawnPiForTest } = (await import('../bin/tau.js')) as any;
const { RUNTIME_FILE, publishEndpoint, unpublishEndpoint, buildBrowserUrls } = (await import('../bin/orchestration.js')) as any;
import type { TestContext } from 'node:test';

type SpawnCall = { cmd: string; args: string[]; opts: { cwd?: string; env?: Record<string, string> } };

/** Records the spawn a manager would perform instead of launching a real pi. */
function recordingSpawn(calls: SpawnCall[]) {
  return (cmd: string, args: string[], opts: SpawnCall['opts']) => {
    calls.push({ cmd, args, opts });
    return new FakePi({ sessionFile: args[args.indexOf('--session') + 1] }).asChild();
  };
}

function sessionFileFixture(name: string): string {
  const dir = path.join(SESSIONS_DIR, '--tmp--orch');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '{"type":"session_header"}\n');
  return file;
}

test('spawn overrides are validated before a child is started', () => {
  assert.deepEqual(parseSpawnOverrides({}), {});
  assert.deepEqual(parseSpawnOverrides({ args: ['--model', 'gpt-6'], env: { PI_NESTED: '1' } }),
    { args: ['--model', 'gpt-6'], env: { PI_NESTED: '1' } });
  assert.throws(() => parseSpawnOverrides({ args: '--model' }), /args must be an array of strings/);
  assert.throws(() => parseSpawnOverrides({ args: [1] }), /args must be an array of strings/);
  assert.throws(() => parseSpawnOverrides({ env: ['PI_NESTED=1'] }), /env must be an object of string values/);
  assert.throws(() => parseSpawnOverrides({ env: { PI_NESTED: 1 } }), /env.PI_NESTED must be a string/);
  assert.throws(() => parseSpawnOverrides({ env: { 'BAD NAME': 'x' } }), /Invalid environment variable name/);
  assert.throws(() => parseSpawnOverrides({ sessionFile: '/etc/passwd' }), /Invalid session file/);
  const file = sessionFileFixture('overrides.jsonl');
  assert.deepEqual(parseSpawnOverrides({ sessionFile: file }), { sessionFile: file });
});

test('a created session runs with the caller arguments, environment, and session file', async (t: TestContext) => {
  const calls: SpawnCall[] = [];
  _setSpawnPiForTest(recordingSpawn(calls));
  t.after(() => _setSpawnPiForTest(null));
  publishEndpoint(3001);
  t.after(() => unpublishEndpoint());

  const manager = new LiveSessionManager();
  const file = sessionFileFixture('created.jsonl');
  await manager.create({ cwd: TMP, sessionFile: file, args: ['--provider', 'openai', '--model', 'gpt-6'], env: { PI_NESTED: '1' } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'pi');
  assert.deepEqual(calls[0].args.slice(0, 2), ['--mode', 'rpc']);
  // Caller arguments come after tau's own, so --session and the bundled
  // extension stay in place.
  assert.deepEqual(calls[0].args.slice(-6), ['--session', file, '--provider', 'openai', '--model', 'gpt-6']);
  assert.equal(calls[0].opts.env?.PI_NESTED, '1');
  assert.equal(calls[0].opts.env?.TAU_DISABLED, '1');
  // Children can orchestrate through this server without extra configuration.
  assert.equal(calls[0].opts.env?.PI_ORCHESTRATION_HOST, 'web');
  assert.equal(calls[0].opts.env?.PI_ORCHESTRATION_ENDPOINT, orchestrationEndpoint());
});

test('browser URLs reflect the bound address and family without credentials or scoped IPv6', () => {
  const entry = (address: string, internal = false): os.NetworkInterfaceInfo => ({
    address, internal, family: address.includes(':') ? 'IPv6' : 'IPv4',
    netmask: '', mac: '', cidr: null, ...(address.includes(':') ? { scopeid: 0 } : {}),
  } as os.NetworkInterfaceInfo);
  const interfaces = {
    lo: [entry('127.0.0.1', true), entry('::1', true)],
    eth0: [entry('10.99.0.1'), entry('2001:db8::1'), entry('fe80::1'), entry('fe80::2%eth0')],
    wg0: [entry('10.10.0.2')],
    duplicate: [entry('10.10.0.2')],
  };
  assert.deepEqual(buildBrowserUrls(3001, '0.0.0.0', interfaces), [
    'http://10.99.0.1:3001', 'http://10.10.0.2:3001', 'http://127.0.0.1:3001',
  ]);
  assert.deepEqual(buildBrowserUrls(3001, '::', interfaces), ['http://[2001:db8::1]:3001', 'http://[::1]:3001']);
  assert.deepEqual(buildBrowserUrls(3001, '127.0.0.1', interfaces), ['http://127.0.0.1:3001']);
  assert.deepEqual(buildBrowserUrls(3001, '10.10.0.2', interfaces), ['http://10.10.0.2:3001']);
  assert.deepEqual(buildBrowserUrls(3001, '::1', interfaces), ['http://[::1]:3001']);
  assert.deepEqual(buildBrowserUrls(3001, '2001:db8::1', interfaces), ['http://[2001:db8::1]:3001']);
  assert.deepEqual(buildBrowserUrls(3001, 'fe80::1%eth0', interfaces), []);
  // Hostnames need the actual numeric listener address, not an invented LAN URL.
  assert.deepEqual(buildBrowserUrls(3001, 'localhost', interfaces), []);
  assert.equal(buildEndpoint(3001, '::'), 'http://rs:l@[::1]:3001');
  assert.equal(buildEndpoint(3001, '::1'), 'http://rs:l@[::1]:3001');
});

test('publication can use the actual resolved listener address and port', (t: TestContext) => {
  publishEndpoint(4321, '::1');
  t.after(() => unpublishEndpoint());
  const published = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  assert.equal(published.endpoint, 'http://rs:l@[::1]:4321');
  assert.deepEqual(published.browserUrls, ['http://[::1]:4321']);
});

test('the published endpoint carries credentials and belongs to one running server', (t: TestContext) => {
  assert.equal(buildEndpoint(3001), 'http://rs:l@127.0.0.1:3001');

  publishEndpoint(3001);
  t.after(() => unpublishEndpoint());
  assert.equal(orchestrationEndpoint(), 'http://rs:l@127.0.0.1:3001');
  const published = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  assert.equal(published.endpoint, 'http://rs:l@127.0.0.1:3001');
  assert.equal(published.pid, process.pid);
  assert.deepEqual(published.browserUrls, buildBrowserUrls(3001));
  assert.ok(published.browserUrls.includes('http://127.0.0.1:3001'));
  for (const value of published.browserUrls) {
    const url = new URL(value);
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.protocol, 'http:');
    assert.equal(url.port, '3001');
  }
  assert.equal(fs.statSync(RUNTIME_FILE).mode & 0o777, 0o600);

  // A second live server does not steal the published name.
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ endpoint: 'http://127.0.0.1:9999', pid: process.ppid, startedAt: new Date().toISOString() }));
  publishEndpoint(3002);
  assert.equal(JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')).endpoint, 'http://127.0.0.1:9999');
  // ...and removing it is equally owner-scoped.
  unpublishEndpoint();
  assert.equal(fs.existsSync(RUNTIME_FILE), true);

  // A dead owner is replaced.
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ endpoint: 'http://127.0.0.1:9999', pid: 0x7fffffff, startedAt: new Date().toISOString() }));
  publishEndpoint(3003);
  assert.equal(JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')).pid, process.pid);
  unpublishEndpoint();
  assert.equal(fs.existsSync(RUNTIME_FILE), false);
});
