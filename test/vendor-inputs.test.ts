import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor/manifest.json'), 'utf8')) as {
  schema: number;
  inputs: Array<{ name: string; version: string; file: string; sha256: string; sourceRevision: string }>;
};
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>; engines: { node: string }; scripts: Record<string, string>; files: string[];
};
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }>;
};

test('candidate inputs are immutable audited local archives with no registry or sibling fallback', () => {
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.inputs.length, 2);
  for (const input of manifest.inputs) {
    assert.equal(path.basename(input.file), input.file);
    assert.match(input.sourceRevision, /^[a-f0-9]{40}$/);
    const bytes = fs.readFileSync(path.join(root, 'vendor', input.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), input.sha256, input.name);
    const expected = `file:vendor/${input.file}`;
    assert.equal(pkg.dependencies[input.name], expected);
    const installed = lock.packages[`node_modules/${input.name}`];
    assert.equal(installed.resolved, expected);
    assert.equal(installed.version, input.version);
    assert.match(installed.integrity ?? '', /^sha512-/);
    assert.ok(!installed.link);
  }
  for (const entry of Object.values(lock.packages)) assert.ok(!entry.link, 'no workspace/sibling symlink');
  assert.equal(pkg.dependencies['@earendil-works/pi-coding-agent'], '1.4.0');
  assert.ok(pkg.files.includes('vendor'));
  assert.equal(pkg.engines.node, '>=24.0.0');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.ok(!(hook in pkg.scripts), hook);
});
