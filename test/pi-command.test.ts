import { runtimeEnvironment, cwd } from './runtime-environment.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FakeRuntimeLauncher } from './runtime-launcher.ts';
import { PI_COMMAND, LiveSessionManager, handleRpcCommand, SESSIONS_DIR, resolvePiCommand,
  _setExecFileForTest, _clearModelListCacheForTest } from '../bin/tau.js';
import { releaseHost } from '../bin/config.js';

const installedPi = fs.realpathSync(fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent'))));
const sha256 = createHash('sha256').update(fs.readFileSync(installedPi)).digest('hex');
const SESSION_FILE = path.join(SESSIONS_DIR, 'command-test', 'session.jsonl');

before(() => {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, [
    { type: 'session', version: 3, id: 'command-test', cwd, timestamp: new Date().toISOString() },
    { type: 'message', id: 'question', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'static export fixture', timestamp: Date.now() } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
});
after(() => { _setExecFileForTest(null); fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }); });

test('the default Pi command is this installation’s absolute physical release executable, not PATH', () => {
  assert.equal(PI_COMMAND, installedPi);
  assert.equal(resolvePiCommand({}, {}), installedPi);
  assert.equal(path.isAbsolute(PI_COMMAND), true);
  assert.deepEqual(releaseHost(), { executable: installedPi, version: '1.4.0', sha256 });
});

test('explicit flags and environment select a validated installed host, resolving symlink aliases', () => {
  const alias = path.join(runtimeEnvironment.root, 'selected-release-pi');
  fs.symlinkSync(installedPi, alias);
  assert.equal(resolvePiCommand({}, { TAU_PI_COMMAND: alias }), installedPi);
  assert.equal(resolvePiCommand({ 'pi-command': alias }, { TAU_PI_COMMAND: 'untrusted-path-wrapper' }), installedPi);
});

test('arbitrary PATH wrappers are refused instead of being invoked', () => {
  assert.throws(() => resolvePiCommand({ 'pi-command': 'pi' }, {}), /absolute release executable/);
  assert.throws(() => resolvePiCommand({}, { TAU_PI_COMMAND: 'wrapper --unsafe' }), /absolute release executable/);
});

test('a missing absolute host fails before launch with its exact selected path', () => {
  const missing = path.join(runtimeEnvironment.root, 'missing-pi');
  assert.throws(() => resolvePiCommand({}, { TAU_PI_COMMAND: missing }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ENOENT/);
    assert.ok(error.message.includes(missing));
    return true;
  });
});

test('release version and integrity mismatches are refused before opening a session', () => {
  assert.throws(() => resolvePiCommand({}, { TAU_PI_COMMAND: installedPi, PHIMACS_PI_VERSION: '0.0.0' }), /Unsupported Pi host/);
  assert.throws(() => resolvePiCommand({}, { TAU_PI_COMMAND: installedPi, PHIMACS_PI_SHA256: '0'.repeat(64) }), /integrity manifest/);
  assert.equal(resolvePiCommand({}, { TAU_PI_COMMAND: installedPi, PHIMACS_PI_VERSION: '1.4.0', PHIMACS_PI_SHA256: sha256 }), installedPi);
});

test('managed session startup passes the same validated absolute host and hash to the common launcher', async t => {
  const launcher = new FakeRuntimeLauncher();
  const manager = new LiveSessionManager({ start: launcher.start });
  t.after(async () => { await manager.shutdown(); await launcher.close(); });
  const session = await manager.create({ cwd, model: undefined, sessionFile: undefined, args: undefined, env: undefined });
  assert.equal(launcher.calls.length, 1);
  assert.equal(launcher.calls[0].command, installedPi);
  assert.deepEqual(launcher.calls[0].expectedHost, releaseHost());
  assert.equal(session.transport?.kind, 'pimux');
});

test('the model list uses the exact release host and preserves slashful provider model IDs', async t => {
  _clearModelListCacheForTest();
  _setExecFileForTest((file: string, args: string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    assert.equal(file, installedPi);
    assert.deepEqual(args, ['--list-models']);
    callback(null, 'provider      model               context  max-out  thinking  images\nfx            nested/model        128K     16K      yes       no\n', '');
  });
  t.after(() => _setExecFileForTest(null));
  const response = await handleRpcCommand({ type: 'get_available_models' });
  assert.equal(response.success, true);
  assert.deepEqual(response.data.models, [{ provider: 'fx', id: 'nested/model', context: '128K', maxOutput: '16K', thinking: true, images: false }]);
});

test('HTML export uses the managed exact host on a synthetic captured session without inference', async () => {
  const before = fs.readFileSync(SESSION_FILE, 'utf8');
  const response = await handleRpcCommand({ type: 'export_html', filePath: SESSION_FILE });
  assert.equal(response.success, true, String(response.error));
  assert.equal(response.data.path, SESSION_FILE.replace(/\.jsonl$/, '.html'));
  const html = fs.readFileSync(response.data.path, 'utf8');
  const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html)?.[1];
  assert.ok(encoded);
  assert.ok(Buffer.from(encoded, 'base64').toString('utf8').includes('static export fixture'));
  assert.equal(fs.readFileSync(SESSION_FILE, 'utf8'), before, 'export never rewrites the original conversation');
});
