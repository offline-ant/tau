import { runtimeFixture, runtimeEnvironment, cwd } from './runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exportSession } from '../bin/session-export.js';
import type { JsonRecord } from '../src/server/types.ts';

function exportedData(file: string): { header: JsonRecord; entries: JsonRecord[] } {
  const html = fs.readFileSync(file, 'utf8');
  const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html)?.[1];
  assert.ok(encoded);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { header: JsonRecord; entries: JsonRecord[] };
}

test('a live export preserves the complete branch tree and actual session identity', { timeout: 30000 }, async t => {
  const { session, mux, file } = await runtimeFixture(t);
  mux.entries = [
    { type: 'message', id: 'question', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'question' } },
    { type: 'message', id: 'chosen', parentId: 'question', timestamp: new Date().toISOString(), message: { role: 'assistant', content: 'chosen answer' } },
    { type: 'message', id: 'sibling', parentId: 'question', timestamp: new Date().toISOString(), message: { role: 'assistant', content: 'sibling answer' } },
  ];
  mux.leafId = 'chosen';
  const output = file.replace(/\.jsonl$/, '.html');
  await exportSession(file, output, session);
  const exported = exportedData(output);
  assert.equal(exported.header.id, `id-${mux.muxId}`);
  assert.deepEqual(exported.entries.map(entry => entry.id), ['question', 'chosen', 'sibling']);
  assert.equal(session.entries.length, 2, 'the UI still shows only its selected path');
  assert.equal(session.attachment?.ready, true);
});

test('stopped export preserves a complete last record without a trailing LF and never repairs the source', { timeout: 30000 }, async () => {
  const file = path.join(runtimeEnvironment.sessions, 'no-final-lf.jsonl');
  const text = [JSON.stringify({ type: 'session', version: 3, id: 'no-lf', cwd, timestamp: new Date().toISOString() }),
    JSON.stringify({ type: 'message', id: 'last', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'valid final record' } })].join('\n');
  fs.writeFileSync(file, text);
  const output = file.replace(/\.jsonl$/, '.html');
  await exportSession(file, output);
  assert.equal(exportedData(output).entries.at(-1)?.id, 'last');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('an incomplete stopped tail fails visibly rather than silently dropping data', async () => {
  const file = path.join(runtimeEnvironment.sessions, 'invalid-tail.jsonl');
  const text = JSON.stringify({ type: 'session', version: 3, id: 'invalid', cwd }) + '\n{"type":';
  fs.writeFileSync(file, text);
  await assert.rejects(exportSession(file, file.replace(/\.jsonl$/, '.html')), /incomplete final record/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});
