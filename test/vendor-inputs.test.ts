import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { findPackageJSON } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readWorkerTask } from 'pi-orchestration/worker-task';
import { lookupTerminalReceipt } from '@phimacs/pimux/runtime';
import { verifyHost } from '@phimacs/pimux/host';

type Input = { name: string; version: string; file: string; sha256: string; license: string;
  sourceRevision: string;
  sourceArchive?: string; sourceArchiveSha256?: string; sourceDirectory: string };
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor/manifest.json'), 'utf8')) as { schema: number; inputs: Input[] };
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>; engines: { node: string }; scripts: Record<string, string>; files: string[];
};
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }>;
};
function archiveFile(archive: string, file: string): string {
  return execFileSync('tar', ['-xOf', path.join(root, 'vendor', archive), file], { encoding: 'utf8' });
}
function archiveFiles(archive: string): string[] {
  return execFileSync('tar', ['-tzf', path.join(root, 'vendor', archive)], { encoding: 'utf8' }).trim().split('\n');
}

test('candidate inputs are reviewed local archives with exact integrity and honest source provenance', () => {
  assert.equal(manifest.schema, 1);
  assert.deepEqual(manifest.inputs.map(input => input.name).sort(), ['@phimacs/pimux', 'pi-orchestration', 'pi-sound']);
  for (const input of manifest.inputs) {
    assert.equal(path.basename(input.file), input.file);
    const bytes = fs.readFileSync(path.join(root, 'vendor', input.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), input.sha256, input.name);
    const expected = `file:vendor/${input.file}`;
    assert.equal(pkg.dependencies[input.name], expected);
    const installed = lock.packages[`node_modules/${input.name}`];
    assert.equal(installed.resolved, expected);
    assert.equal(installed.version, input.version);
    assert.equal(installed.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
    assert.ok(!installed.link);
    const entries = archiveFiles(input.file);
    assert.ok(entries.includes('package/LICENSE'), input.name);
    assert.ok(entries.includes('package/README.md'), input.name);
    assert.match(input.sourceRevision, /^[a-f0-9]{40}$/);
    if (input.sourceArchive) {
      assert.equal(path.basename(input.sourceArchive!), input.sourceArchive);
      const source = fs.readFileSync(path.join(root, 'vendor', input.sourceArchive!));
      assert.equal(createHash('sha256').update(source).digest('hex'), input.sourceArchiveSha256);
      assert.equal(archiveFile(input.file, 'package/LICENSE'), archiveFile(input.sourceArchive!, `./${input.sourceDirectory}/LICENSE`));
      const sources = archiveFiles(input.sourceArchive!);
      for (const required of ['./LICENSE', './package-lock.json', `./${input.sourceDirectory}/scripts/compile.mjs`]) assert.ok(sources.includes(required), required);
      assert.ok(sources.every(file => !/(^|\/)(node_modules|dist|\.git)(\/|$)/.test(file)), 'source archive excludes installed and generated trees');
    }
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    assert.ok(!entry.link, 'no workspace/sibling symlink');
    if (entry.resolved?.startsWith('file:')) assert.match(entry.resolved, /^file:vendor\/[^/]+\.tgz$/);
    assert.ok(!name.startsWith('node_modules/pi-orchestration/node_modules/'), 'orchestration shares the locked host and pimux');
  }
  assert.equal(pkg.dependencies['@earendil-works/pi-coding-agent'], '1.5.0');
  assert.ok(pkg.files.includes('vendor'));
  assert.equal(pkg.engines.node, '>=24.0.0');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.ok(!(hook in pkg.scripts), hook);
  const sound = manifest.inputs.find(input => input.name === 'pi-sound')!;
  assert.equal(sound.license, 'MIT AND Apache-2.0');
  for (const notice of ['package/sounds/NOTICE', 'package/sounds/LICENSE-APACHE-2.0']) assert.ok(archiveFiles(sound.file).includes(notice));
});

test('the orchestration archive includes public task APIs and its executable without install scripts', () => {
  const input = manifest.inputs.find(input => input.name === 'pi-orchestration')!;
  const entries = archiveFiles(input.file);
  for (const file of ['worker-task.js', 'worker-task.d.ts', 'parent-task.js', 'worker-task-cli.js', 'worker-frame.js']) assert.ok(entries.includes(`package/dist/${file}`), file);
  const packed = JSON.parse(archiveFile(input.file, 'package/package.json')) as {
    exports: Record<string, { types: string; default: string }>; bin: Record<string, string>; dependencies: Record<string, string>; scripts: Record<string, string>;
  };
  assert.deepEqual(packed.exports['./worker-task'], { types: './dist/worker-task.d.ts', default: './dist/worker-task.js' });
  assert.equal(packed.bin['phimacs-task-status'], './dist/worker-task-cli.js');
  assert.deepEqual(packed.dependencies, { '@phimacs/pimux': '0.1.0' });
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.ok(!(hook in packed.scripts), hook);
});

test('installed task APIs and npm bins use the same physical locked host after scripts-disabled hydration', () => {
  const host = fs.realpathSync(findPackageJSON('@earendil-works/pi-coding-agent', import.meta.url)!);
  assert.equal(verifyHost(path.join(path.dirname(host), 'dist/bundle/cli.js')).version, '1.5.0');
  for (const entry of ['@phimacs/pimux/runtime', 'pi-orchestration/worker-task']) {
    assert.equal(fs.realpathSync(findPackageJSON('@earendil-works/pi-coding-agent', import.meta.resolve(entry))!), host);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-package-inputs-'));
  try {
    const env = { ...process.env, PIMUX_DIR: directory };
    assert.equal(readWorkerTask('missing', env), null);
    assert.equal(lookupTerminalReceipt('missing', env), null);
    const binary = path.join(root, 'node_modules/.bin/phimacs-task-status');
    assert.equal(fs.realpathSync(binary), path.join(root, 'node_modules/pi-orchestration/dist/worker-task-cli.js'));
    assert.ok(fs.statSync(binary).mode & 0o111);
    assert.equal(JSON.parse(execFileSync(process.execPath, [binary, '--id', 'missing', '--json'], { env, encoding: 'utf8', timeout: 5000 })), null);
    assert.ok(fs.statSync(path.join(root, 'node_modules/.bin/pimux')).mode & 0o111);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Tau packs the runtime, reviewed vendor archives and matching committed source archive', () => {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], { cwd: root, encoding: 'utf8', timeout: 10000 })) as Array<{ files: Array<{ path: string }> }>;
  const entries = new Set(pack.files.map(file => file.path));
  for (const file of ['bin/tau.js', 'bin/worker-task-evidence.js', 'vendor/manifest.json']) assert.ok(entries.has(file), file);
  for (const input of manifest.inputs) {
    assert.ok(entries.has(`vendor/${input.file}`));
    if (input.sourceArchive) assert.ok(entries.has(`vendor/${input.sourceArchive}`));
  }
});
