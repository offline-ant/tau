import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TauSettingsFile } from '../src/server/types.ts';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const VALIDATE = [
  "import { TAU_SETTINGS, AUTH_CONFIGURED, requireTauCredentials } from './bin/config.js';",
  'if (TAU_SETTINGS.authEnabled !== false) requireTauCredentials(TAU_SETTINGS);',
  'console.log(JSON.stringify({ configured: AUTH_CONFIGURED, disabled: TAU_SETTINGS.authEnabled === false }));',
].join('\n');

function run(settings: TauSettingsFile['tau'], credentials: { user?: string; pass?: string } = {}, entry: 'config' | 'cli' | 'listen' | 'listen-disabled' = 'config') {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-auth-config-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, 'sessions'),
    TAU_HOST: '127.0.0.1', TAU_PORT: '0', TAU_HTTP_PORT: '0',
  };
  delete env.TAU_USER;
  delete env.TAU_PASS;
  if (credentials.user !== undefined) env.TAU_USER = credentials.user;
  if (credentials.pass !== undefined) env.TAU_PASS = credentials.pass;
  if (settings !== undefined) fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ tau: settings }));
  try {
    const args = entry === 'cli' ? ['bin/tau.js'] : ['--input-type=module', '-'];
    const input = entry === 'listen-disabled'
      ? [
        "import assert from 'node:assert/strict';",
        "import { listen, server } from './bin/tau.js';",
        'await listen();',
        "const response = await fetch(`http://127.0.0.1:${server.address().port}/api/live-sessions`);",
        'assert.equal(response.status, 200);',
        // This isolated process has no Pi children; exit also closes its listeners.
        'process.exit(0);',
      ].join('\n')
      : entry === 'listen' ? "import { listen } from './bin/tau.js'; await listen();" : VALIDATE;
    const result = spawnSync(process.execPath, args, {
      cwd: PROJECT_ROOT, env, input, encoding: 'utf8', timeout: 10_000,
    });
    return {
      ...result,
      tlsCreated: fs.existsSync(path.join(agentDir, 'tau', 'tls')),
      endpointPublished: fs.existsSync(path.join(agentDir, 'tau', 'server.json')),
    };
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

for (const [name, settings, credentials] of [
  ['absent credentials', undefined, {}],
  ['missing password', { user: 'test-user' }, {}],
  ['missing username', { pass: 'test-secret' }, {}],
  ['empty credentials', { user: '', pass: '' }, {}],
  ['empty environment overrides valid settings', { user: 'test-user', pass: 'test-secret' }, { pass: '' }],
  ['explicit enabled mode without credentials', { authEnabled: true }, {}],
] satisfies Array<[string, TauSettingsFile['tau'], { user?: string; pass?: string }]>) {
  test(`${name} refuse authenticated startup without disclosing credentials`, () => {
    const result = run(settings, credentials);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /nonempty username and password/);
    assert.match(result.stderr, /TAU_USER and TAU_PASS/);
    assert.match(result.stderr, /tau\.authEnabled to false/);
    assert.equal(result.stderr.includes('test-secret'), false);
  });
}

test('explicit settings credentials configure authentication', () => {
  const result = run({ user: 'test-user', pass: 'test-secret' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { configured: true, disabled: false });
});

test('environment credentials override empty settings', () => {
  const result = run({ user: '', pass: '' }, { user: 'test-user', pass: 'test-secret' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { configured: true, disabled: false });
});

test('explicit authEnabled:false allows an unconfigured server', () => {
  const result = run({ authEnabled: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { configured: false, disabled: true });
});

test('explicit authEnabled:false starts both listeners without credentials', () => {
  const result = run({ authEnabled: false }, {}, 'listen-disabled');
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.tlsCreated, true);
  assert.equal(result.endpointPublished, true);
});

for (const entry of ['cli', 'listen'] as const) {
  test(`${entry} rejects missing credentials before TLS provisioning or listener discovery`, () => {
    const result = run(undefined, {}, entry);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /nonempty username and password/);
    assert.equal(result.tlsCreated, false);
    assert.equal(result.endpointPublished, false);
    assert.equal(result.stdout.includes('Server running'), false);
  });
}
