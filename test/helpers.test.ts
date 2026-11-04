import { runtimeEnvironment } from './runtime-environment.ts';
import { test, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as tau from '../bin/tau.js';
after(() => fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }));
import assert from 'node:assert/strict';

// The built server module is a plain JS artifact without declarations; the
// old require() call typed these as any, so keep that contract here.
const {
  parseArgs,
  expandHome,
  resolvePiCommand,
  PI_COMMAND,
  modelLabel,
  makeId,
  isWithinPath,
  isAllowedApiOrigin,
} = tau as any;

test('parseArgs parses --key value pairs and boolean --open', () => {
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(parseArgs(['--open']), { open: true });
  assert.deepEqual(parseArgs(['--port', '3001', '--host', '127.0.0.1']), {
    port: '3001',
    host: '127.0.0.1',
  });
  // a following flag is not consumed as a value
  assert.deepEqual(parseArgs(['--port', '--host', 'x']), { host: 'x' });
});

test('parseArgs ignores non-flag tokens', () => {
  assert.deepEqual(parseArgs(['positional', '--port', '9']), { port: '9' });
});

test('resolvePiCommand prefers an explicit absolute release, then the installed exact host', () => {
  assert.equal(resolvePiCommand({}, {}), PI_COMMAND);
  assert.equal(resolvePiCommand({}, { TAU_PI_COMMAND: PI_COMMAND }), PI_COMMAND);
  assert.equal(resolvePiCommand({ 'pi-command': PI_COMMAND }, { TAU_PI_COMMAND: 'not-a-release' }), PI_COMMAND);
  assert.equal(resolvePiCommand({ 'pi-command': '  ' }, { TAU_PI_COMMAND: '' }), PI_COMMAND);
  assert.throws(() => resolvePiCommand({ 'pi-command': 'pi-bolt' }, {}), /absolute/);
  assert.equal(parseArgs(['--pi-command', PI_COMMAND])['pi-command'], PI_COMMAND);
});

test('resolvePiCommand expands a leading tilde', () => {
  const home = process.env.HOME || process.env.USERPROFILE;
  fs.mkdirSync(path.join(home!, 'bin'));
  fs.symlinkSync(PI_COMMAND, path.join(home!, 'bin', 'pi-release'));
  assert.equal(resolvePiCommand({ 'pi-command': '~/bin/pi-release' }, {}), PI_COMMAND);
});

test('expandHome expands a leading tilde and passes through others', () => {
  const home = process.env.HOME || process.env.USERPROFILE;
  assert.equal(expandHome('~/foo').startsWith(home), true);
  assert.equal(expandHome('/abs/path'), '/abs/path');
  assert.equal(expandHome('relative'), 'relative');
  assert.equal(expandHome(null), null);
  assert.equal(expandHome(undefined), undefined);
});

test('modelLabel handles strings, provider/id objects, and fallbacks', () => {
  assert.equal(modelLabel('openai/gpt-5.5:high'), 'openai/gpt-5.5:high');
  assert.equal(modelLabel({ provider: 'openai', id: 'gpt-5.5' }), 'openai/gpt-5.5');
  assert.equal(modelLabel({ id: 'gpt-5.5' }), 'gpt-5.5');
  assert.equal(modelLabel({ name: 'claude' }), 'claude');
  assert.equal(modelLabel(null, 'fallback'), 'fallback');
  assert.equal(modelLabel(null), '');
  assert.equal(modelLabel(undefined, ''), '');
});

test('makeId produces tau_-prefixed unique ids', () => {
  const a = makeId();
  const b = makeId();
  assert.match(a, /^tau_[a-z0-9]+_[a-z0-9]+$/);
  assert.notEqual(a, b);
});

test('isWithinPath contains children and root, rejects siblings and absolutes', () => {
  const root = '/srv/proj';
  assert.equal(isWithinPath(root, root), true);
  assert.equal(isWithinPath(root, '/srv/proj/sub'), true);
  assert.equal(isWithinPath(root, '/srv/proj/sub/deep'), true);
  // sibling outside root
  assert.equal(isWithinPath(root, '/srv/other'), false);
  // traversal escape
  assert.equal(isWithinPath(root, '/srv/proj/../other'), false);
  // absolute unrelated path
  assert.equal(isWithinPath(root, '/etc'), false);
});

test('isAllowedApiOrigin treats missing origin and same-origin as allowed', () => {
  assert.equal(isAllowedApiOrigin({ headers: {} }), true);
  assert.equal(
    isAllowedApiOrigin({ headers: { origin: 'http://localhost:3001', host: 'localhost:3001' } }),
    true,
  );
  assert.equal(
    isAllowedApiOrigin({ headers: { origin: 'http://evil.example', host: 'localhost:3001' } }),
    false,
  );
  // malformed origin is rejected, not thrown
  assert.equal(isAllowedApiOrigin({ headers: { origin: 'not-a-url', host: 'localhost:3001' } }), false);
});
