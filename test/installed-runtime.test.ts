import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createClaimTestEnvironment } from '@phimacs/pimux/ownership';

const exec = promisify(execFile);
const installed = process.env.TAU_INSTALLED_PACKAGE;

test('a hydrated installed package uses compiled peers and survives frontend disconnect', {
  skip: installed ? false : 'Set TAU_INSTALLED_PACKAGE to an extracted, offline-hydrated input pack below node_modules',
  timeout: 60000,
}, async t => {
  assert.ok(installed);
  const prefix = fs.realpathSync(installed);
  assert.ok(prefix.includes(`${path.sep}node_modules${path.sep}`));
  const isolated = createClaimTestEnvironment();
  t.after(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
  const home = path.join(isolated.root, 'home');
  const agent = path.join(isolated.root, 'agent');
  const cwd = path.join(isolated.root, 'project');
  for (const dir of [home, agent, cwd]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: [], defaultProvider: 'tau-fx', defaultModel: 'one', retry: { enabled: false }, compaction: { enabled: false } }), { mode: 0o600 });
  const target = path.join(prefix, 'test/fixtures/installed-runtime-probe.mjs');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/installed-runtime-probe.mjs', import.meta.url)), target);
  t.after(() => fs.rmSync(target, { force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(PI_|TAU_|PIMUX_|PHIMACS_|HERDR_|ANTHROPIC_|CLAUDE_|OPENAI_)/.test(key) || ['TMUX', 'TMUX_PANE', 'NODE_OPTIONS'].includes(key)) delete env[key];
  Object.assign(env, isolated.env, { HOME: home, TMPDIR: isolated.root, PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: isolated.sessions, PIMUX_DIR: path.join(isolated.root, 'mux'),
    INSTALL_PROBE_CWD: cwd, INSTALL_PROBE_FAUX: fileURLToPath(new URL('./e2e/fixtures/pimux-faux.ts', import.meta.url)) });
  const result = await exec(process.execPath, [target], { cwd, env, timeout: 55000 });
  assert.match(result.stdout, /detached lifecycle passed/);
});
