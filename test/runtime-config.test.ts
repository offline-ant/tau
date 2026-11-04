import { runtimeEnvironment } from './runtime-environment.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PI_COMMAND, resolvePiCommand, loadTauSettings, releaseHost } from '../bin/config.js';

after(() => fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }));
test('default Pi is the installed exact host, not a PATH/global command', () => {
  assert.ok(path.isAbsolute(PI_COMMAND));
  assert.equal(fs.realpathSync(PI_COMMAND), PI_COMMAND);
  assert.equal(releaseHost().version, '1.4.0');
  assert.equal(loadTauSettings().host, '127.0.0.1');
});
test('PATH commands and wrong host integrity/version are refused before launch', () => {
  assert.throws(() => resolvePiCommand({ 'pi-command': 'pi' }, {}), /absolute release executable/);
  assert.throws(() => resolvePiCommand({ 'pi-command': PI_COMMAND }, { PHIMACS_PI_VERSION: '0.0.0' }), /Unsupported Pi host/);
  assert.throws(() => resolvePiCommand({ 'pi-command': PI_COMMAND }, { PHIMACS_PI_SHA256: '0'.repeat(64) }), /integrity/);
});
test('an explicit matching release host is verified against its actual bytes', () => {
  const sha256 = createHash('sha256').update(fs.readFileSync(PI_COMMAND)).digest('hex');
  assert.equal(resolvePiCommand({}, { TAU_PI_COMMAND: PI_COMMAND, PHIMACS_PI_VERSION: '1.4.0', PHIMACS_PI_SHA256: sha256 }), PI_COMMAND);
});
