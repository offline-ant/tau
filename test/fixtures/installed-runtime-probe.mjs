import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageJSON } from 'node:module';
import { LiveSessionManager } from '../../bin/sessions.js';
import { releaseHost } from '../../bin/config.js';
import { listRuntimes, stopRuntime } from '@phimacs/pimux/runtime';
import { processIdentityStatus, readProcessIdentity } from '@phimacs/pimux/process-identity';
import { configuredTranscriber } from 'pi-sound';

const root = fileURLToPath(new URL('../../', import.meta.url));
assert.ok(root.includes(`${path.sep}node_modules${path.sep}`));
const host = releaseHost();
assert.ok(host.executable.startsWith(root));
const ownHost = import.meta.resolve('@earendil-works/pi-coding-agent');
const hostPackage = fileURLToPath(new URL('../package.json', ownHost));
assert.equal(findPackageJSON('@earendil-works/pi-coding-agent', import.meta.resolve('@phimacs/pimux/runtime')), hostPackage);
assert.equal(findPackageJSON('@earendil-works/pi-coding-agent', import.meta.resolve('pi-sound')), hostPackage);
assert.equal(fs.existsSync(new URL('../../public/vendor/katex/LICENSE', import.meta.url)), true);
assert.equal(fs.existsSync(new URL('../../public/vendor/highlight/LICENSE', import.meta.url)), true);
await assert.rejects(configuredTranscriber(process.env.PI_CODING_AGENT_DIR)({ partial() {}, error() {} }, new AbortController().signal), /disabled|not configured/i);
const manager = new LiveSessionManager();
let second;
try {
  const session = await manager.create({ cwd: process.env.INSTALL_PROBE_CWD, model: 'tau-fx/one', args: [
    '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--extension', process.env.INSTALL_PROBE_FAUX,
  ] });
  const runtime = session.metadata().runtime;
  assert.equal(runtime.protocol, 2);
  const identity = readProcessIdentity(runtime.piPid);
  assert.ok(identity);
  assert.equal((await session.send({ type: 'get_state' })).success, true);
  await manager.shutdown();
  assert.equal(processIdentityStatus(identity), 'alive');
  second = new LiveSessionManager();
  const attached = await second.attachById(runtime.muxId);
  assert.equal(attached.session.metadata().runtime.piPid, runtime.piPid);
  assert.equal((await attached.session.send({ type: 'get_state' })).success, true);
  const receipt = await stopRuntime(runtime.muxId);
  assert.equal(receipt.state, 'stopped');
  assert.equal(processIdentityStatus(identity), 'dead');
  console.log('Installed JavaScript, host identity, disabled voice and detached lifecycle passed.');
} finally {
  await manager.shutdown();
  await second?.shutdown();
  for (const runtime of listRuntimes()) await stopRuntime(runtime.muxId);
}
