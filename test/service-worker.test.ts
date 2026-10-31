import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PUBLIC_SOURCE = fileURLToPath(new URL('../src/public/', import.meta.url));

/** Every module the app loads, following value imports from its entry point. */
function appModules() {
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const source = fs.readFileSync(path.join(PUBLIC_SOURCE, `${name}.ts`), 'utf8');
    for (const [, target] of source.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s+)?'\.\/([^']+)\.js'/gm)) visit(target);
  };
  visit('app');
  return seen;
}

test('the shell retains offline rich-rendering assets and invalidates the older candidate cache', () => {
  const source = fs.readFileSync(path.join(PUBLIC_SOURCE, 'sw.ts'), 'utf8');
  const assets = [...source.matchAll(/^\s*'([^']+)',$/gm)].map(([, name]) => name);
  assert.equal(assets.length, new Set(assets).size, 'the shell inventory must not contain duplicates');
  for (const asset of [
    '/vendor/katex/katex.min.js', '/vendor/katex/katex.min.css',
    '/vendor/highlight/core.min.js', '/vendor/highlight/javascript.min.js', '/vendor/highlight/bash.min.js',
    '/icons/tau-192.png', '/icons/tau-512.png', '/icons/tau-maskable-512.png',
  ]) assert.ok(assets.includes(asset), `missing offline shell asset: ${asset}`);
  const cache = source.match(/const CACHE_NAME = '([^']+)'/)?.[1];
  assert.ok(cache);
  assert.notEqual(cache, 'tau-v7-private1');
  assert.notEqual(cache, 'tau-fork-v7');
});

test('the service worker precaches exactly the modules the app loads', () => {
  const source = fs.readFileSync(path.join(PUBLIC_SOURCE, 'sw.ts'), 'utf8');
  const cached = new Set([...source.matchAll(/^\s*'\/([\w-]+)\.js',$/gm)].map(([, name]) => name));
  assert.deepEqual([...appModules()].sort(), [...cached].sort());
});
