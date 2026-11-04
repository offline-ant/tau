import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Explicitly disable authentication with no credentials. Enabling it through
// set_auth must fail until credentials are configured and Tau is restarted.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-auth-uncfg-'));
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');
process.env.TAU_USER = '';
process.env.TAU_PASS = '';
fs.writeFileSync(path.join(TMP, 'settings.json'), JSON.stringify({ tau: { authEnabled: false } }));

// Load the module after clearing env: AUTH_CONFIGURED is computed at load
// time, and ESM hoists static imports ahead of this body.
const { handleRpcCommand, checkAuth, _setAuthForTest } = (await import('../bin/tau.js')) as any;

test('get_auth reports configured: false when no credentials are set', async () => {
  const resp = await handleRpcCommand({ type: 'get_auth' });
  assert.equal(resp.success, true);
  assert.equal(resp.data.configured, false);
});

test('missing credentials cannot authenticate an empty Basic header', () => {
  _setAuthForTest(true);
  try {
    assert.deepEqual(checkAuth({ headers: { authorization: `Basic ${Buffer.from(':').toString('base64')}` } }), { ok: false, via: 'none' });
  } finally {
    _setAuthForTest(false);
  }
});

test('set_auth rejects with "No credentials configured" when AUTH_CONFIGURED is false', async () => {
  const resp = await handleRpcCommand({ type: 'set_auth', enabled: true });
  assert.equal(resp.success, false);
  assert.match(resp.error, /No credentials configured/);
});
