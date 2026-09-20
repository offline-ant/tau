import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Load the module with NO credentials configured. This fork falls back to
// DEFAULT_USER/DEFAULT_PASS when nothing is set, so "unconfigured" is the
// explicit empty-value opt-out rather than an absent variable. AUTH_CONFIGURED
// is a load-time const computed from those, so it must be false here —
// exercising the `set_auth` "No credentials configured" rejection branch
// (bin/tau.js:541) that every other test file leaves unhit (they all configure
// credentials).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-auth-uncfg-'));
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');
process.env.TAU_USER = '';
process.env.TAU_PASS = '';

// Load the module after clearing env: AUTH_CONFIGURED is computed at load
// time, and ESM hoists static imports ahead of this body.
const { handleRpcCommand } = (await import('../bin/tau.js')) as any;

test('get_auth reports configured: false when no credentials are set', async () => {
  const resp = await handleRpcCommand({ type: 'get_auth' });
  assert.equal(resp.success, true);
  assert.equal(resp.data.configured, false);
});

test('set_auth rejects with "No credentials configured" when AUTH_CONFIGURED is false', async () => {
  const resp = await handleRpcCommand({ type: 'set_auth', enabled: true });
  assert.equal(resp.success, false);
  assert.match(resp.error, /No credentials configured/);
});
