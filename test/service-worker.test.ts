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

test('the service worker precaches exactly the modules the app loads', () => {
  const source = fs.readFileSync(path.join(PUBLIC_SOURCE, 'sw.ts'), 'utf8');
  const cached = new Set([...source.matchAll(/^\s*'\/([\w-]+)\.js',$/gm)].map(([, name]) => name));
  assert.deepEqual([...appModules()].sort(), [...cached].sort());
});
