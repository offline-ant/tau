import { runtimeFixture, runtimeEnvironment, cwd } from './runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopRuntime } from '@phimacs/pimux/runtime';
import { LiveSessionManager } from '../bin/sessions.js';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { exportSession } from '../bin/session-export.js';
import type { JsonRecord } from '../src/server/types.ts';

function exportedData(file: string): { header: JsonRecord; entries: JsonRecord[]; leafId: string | null } {
  const html = fs.readFileSync(file, 'utf8');
  const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html)?.[1];
  assert.ok(encoded);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { header: JsonRecord; entries: JsonRecord[]; leafId: string | null };
}

test('live export uses only the owning runtime and never retries its refusal against a copy', async t => {
  const { session, mux, file } = await runtimeFixture(t);
  const output = file.replace(/\.jsonl$/, '.html');
  fs.writeFileSync(output, 'from the owning exporter');
  mux.responses.export_html = { success: true, data: { path: output } };
  assert.equal(await exportSession(file, output, session), output);
  assert.equal(mux.commands.filter(command => command.type === 'export_html').length, 1);
  assert.equal(fs.readFileSync(output, 'utf8'), 'from the owning exporter');
  assert.equal(fs.existsSync(path.join(path.dirname(file), '.tau-export')), false);
  mux.responses.export_html = { success: false, error: 'owner refused export' };
  await assert.rejects(exportSession(file, output, session), /owner refused export/);
  assert.equal(mux.commands.filter(command => command.type === 'export_html').length, 2);
});

test('owning Pi exports its exact in-memory leaf after a move without append, retaining every original branch', { timeout: 45000 }, async t => {
  const file = path.join(runtimeEnvironment.sessions, 'selected-leaf.jsonl');
  const id = 'selected-leaf-identity';
  const entries = [
    { type: 'message', id: 'question', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'question', timestamp: Date.now() } },
    { type: 'message', id: 'chosen', parentId: 'question', timestamp: new Date().toISOString(), message: fauxAssistantMessage('chosen answer') },
    { type: 'message', id: 'sibling', parentId: 'question', timestamp: new Date().toISOString(), message: fauxAssistantMessage('sibling answer') },
  ];
  fs.writeFileSync(file, [JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() }), ...entries.map(entry => JSON.stringify(entry))].join('\n') + '\n');
  const manager = new LiveSessionManager();
  const session = await manager.create({ cwd, model: 'tau-fx/one', sessionFile: file, env: undefined, args: [
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
    '--extension', fileURLToPath(new URL('./e2e/fixtures/pimux-faux.ts', import.meta.url)),
  ] });
  t.after(async () => { await manager.shutdown(); await stopRuntime(session.attachment!.muxId); });
  const before = fs.readFileSync(file, 'utf8');
  const originalTree = (await session.send({ type: 'get_entries' })).data as { entries: JsonRecord[] };
  for (const [target, leaf] of [['chosen', 'chosen'], ['question', null]] as const) {
    const moved = await session.send({ type: 'prompt', message: `/fx-tree ${target}` });
    assert.equal(moved.success, true, moved.error);
    await session.snapshot();
    assert.equal(session.attachment!.snapshot!.leafId, leaf);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'navigation must append no marker or other entry');
    const output = path.join(runtimeEnvironment.sessions, `selected-${target}.html`);
    await exportSession(file, output, session);
    const exported = exportedData(output);
    assert.equal(exported.header.id, id);
    assert.equal(exported.leafId, leaf);
    assert.deepEqual(exported.entries, originalTree.entries, 'all branches and append order survive unchanged');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'export must not rewrite the conversation');
  }
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
