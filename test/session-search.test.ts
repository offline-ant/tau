import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { searchSessions } from '../src/server/session-search.ts';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function save(root: string, dir: string, file: string, entries: unknown[]) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  const target = path.join(root, dir, file);
  fs.writeFileSync(target, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return target;
}
const header = { type: 'session', id: 'synthetic-id', cwd: '/synthetic/project', timestamp: '2026-01-01T00:00:00Z' };
const message = (content: unknown, role = 'user') => ({ type: 'message', message: { role, content } });

test('empty and one-character searches do not inspect storage', async t => {
  t.mock.method(fs, 'existsSync', () => { throw new Error('Storage must stay untouched'); });
  for (const query of ['', 'a', '  a  ']) assert.deepEqual(await searchSessions('/not-used', query), []);
});

test('missing storage returns no matches', async t => {
  const root = fixture(t);
  assert.deepEqual(await searchSessions(path.join(root, 'missing'), 'query'), []);
});

test('literal case-insensitive message search retains metadata and ignores non-text content', async t => {
  const root = fixture(t);
  const content = [null, { type: 'text', text: 'First [X].* & <b>' }, { type: 'image', data: 'hidden needle' }, { type: 'thinking', thinking: 'hidden needle' }];
  const file = save(root, 'project', 'one.jsonl', [header, message(content), message('Second [x].* & <B>', 'assistant')]);
  const before = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(file, 'not valid JSON\nnull\n');
  const [result] = await searchSessions(root, '[x].* & <b>');
  assert.equal(result.filePath, file);
  assert.equal(result.dir, 'project');
  assert.equal(result.file, 'one.jsonl');
  assert.equal(result.project, header.cwd);
  assert.equal(result.sessionId, header.id);
  assert.equal(result.sessionTimestamp, header.timestamp);
  assert.equal(result.firstMessage, 'First [X].* & <b>');
  assert.deepEqual(result.matches, [
    { role: 'user', snippet: 'First [X].* & <b>' },
    { role: 'assistant', snippet: 'Second [x].* & <B>' },
  ]);
  assert.deepEqual(await searchSessions(root, 'hidden needle'), []);
  assert.equal(fs.readFileSync(file, 'utf8'), before + 'not valid JSON\nnull\n', 'search must never rewrite a transcript');
});

test('three snippets do not prevent finding a later appended name', async t => {
  const root = fixture(t);
  save(root, 'project', 'one.jsonl', [header,
    { type: 'session_info', name: 'Old name' },
    ...Array.from({ length: 5 }, (_, i) => message('prefix\nneedle ' + i)),
    { type: 'session_info', name: 'Latest name' },
  ]);
  const [result] = await searchSessions(root, 'needle');
  assert.equal(result.sessionName, 'Latest name');
  assert.equal(result.matches.length, 3);
  assert.equal(result.matches[0].snippet, 'prefix needle 0');
});

test('snippets keep only nearby context and searches return at most thirty sessions', async t => {
  const root = fixture(t);
  for (let i = 0; i < 32; i++) save(root, 'project', `${String(i).padStart(2, '0')}.jsonl`, [header, message('a'.repeat(90) + 'needle' + 'b'.repeat(90))]);
  const results = await searchSessions(root, 'needle');
  assert.equal(results.length, 30);
  assert.equal(results[0].file, '00.jsonl');
  assert.equal(results.at(-1)?.file, '29.jsonl');
  assert.equal(results[0].matches[0].snippet, '…' + 'a'.repeat(60) + 'needle' + 'b'.repeat(60) + '…');
});

test('search stays in real immediate project files and treats escaped-looking names literally', async t => {
  const root = fixture(t), outside = fixture(t);
  const external = save(outside, 'external', 'private.jsonl', [header, message('needle')]);
  const legitimate = save(root, 'space %2F #', 'file %2e%2e.jsonl', [header, message('needle')]);
  fs.symlinkSync(path.dirname(external), path.join(root, 'linked-project'));
  fs.symlinkSync(external, path.join(root, 'space %2F #', 'linked-file.jsonl'));
  save(root, 'space %2F #/nested', 'nested.jsonl', [header, message('needle')]);
  save(root, 'space %2F #', 'ignored.txt', [header, message('needle')]);
  const results = await searchSessions(root, 'needle');
  assert.deepEqual(results.map(result => result.filePath), [legitimate]);
  assert.equal(results[0].dir, 'space %2F #');
  assert.equal(results[0].file, 'file %2e%2e.jsonl');
  assert.deepEqual(await searchSessions(root, '../../private.jsonl'), []);
});

test('a transcript removed during search does not fail the other matches', async t => {
  const root = fixture(t);
  const removed = save(root, 'project', 'a.jsonl', [header, message('needle')]);
  const remaining = save(root, 'project', 'b.jsonl', [header, message('needle')]);
  const open = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (file, options) => {
    if (file === removed) fs.unlinkSync(removed);
    return open(file, options);
  });
  assert.deepEqual((await searchSessions(root, 'needle')).map(result => result.filePath), [remaining]);
});
