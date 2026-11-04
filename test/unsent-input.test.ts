import assert from 'node:assert/strict';
import test from 'node:test';
import { UnsentInputStore, sameContext, type InputContext } from '../src/public/unsent-input.ts';

const image = { data: 'abc', mimeType: 'image/png' };
const a: InputContext = { agentId: 'mux', file: '/synthetic/a.jsonl', leafId: 'one' };
const b: InputContext = { ...a, file: '/synthetic/b.jsonl' };
const branch: InputContext = { ...a, leafId: 'two' };

test('an acknowledged prompt is forgotten', () => {
  const store = new UnsentInputStore();
  store.track('p1', a, { text: 'hello', images: [] });
  assert.equal(store.settle('p1', true), false);
  store.keepInFlight();
  assert.deepEqual(store.entries(), []);
});

test('a refused prompt is kept under its exact context, once', () => {
  const store = new UnsentInputStore();
  store.track('p1', a, { text: 'hello', images: [image] });
  assert.equal(store.settle('p1', false), true);
  assert.equal(store.settle('p1', false), false);
  assert.equal(store.take(b), null);
  assert.equal(store.take(branch), null);
  assert.deepEqual(store.take(a), { text: 'hello', images: [image] });
  assert.equal(store.take(a), null);
});

test('a lost connection preserves original file and leaf identities and prompt order', () => {
  const store = new UnsentInputStore();
  store.keep(a, { text: 'draft', images: [] });
  store.track('p1', a, { text: 'one', images: [image] });
  store.track('p2', b, { text: 'other file', images: [] });
  store.track('p3', branch, { text: 'other branch', images: [] });
  store.track('p4', a, { text: 'two', images: [] });
  store.keepInFlight(a);
  assert.deepEqual(store.take(a), { text: 'draft\n\none\n\ntwo', images: [image] });
  assert.deepEqual(store.entries(), []);
  store.keepInFlight();
  assert.deepEqual(store.entries().map(record => record.context), [b, branch]);
  assert.equal(store.take(b)?.text, 'other file');
  assert.equal(store.take(branch)?.text, 'other branch');
});

test('context identity includes agent, file and leaf without separator collisions', () => {
  assert.ok(sameContext(a, { ...a }));
  for (const different of [b, branch, { ...a, agentId: 'other' }, { ...a, leafId: null }, { ...a, leafId: undefined }]) {
    assert.equal(sameContext(a, different), false);
  }
  assert.equal(sameContext(null, a), false);
  assert.equal(sameContext(null, null), true);
});

test('kept images and file chips survive explicit reuse and explicit discard', () => {
  const store = new UnsentInputStore();
  const files = [{ path: '/synthetic/image.png', name: 'image.png', ext: 'png', sessionId: 'old-tab' }];
  store.keep(a, { text: 'draft', images: [image], files });
  store.keep(a, { text: 'queue', images: [], files: [] });
  assert.deepEqual(store.take(a), { text: 'draft\n\nqueue', images: [image], files });
  assert.deepEqual(store.entries(), []);
  store.keep(a, { text: 'discard', images: [] });
  store.take(a);
  assert.deepEqual(store.entries(), []);
});

test('callers cannot retarget a tracked input by mutating the supplied context', () => {
  const store = new UnsentInputStore(), context = { ...a };
  store.track('p', context, { text: 'original', images: [] });
  context.file = b.file;
  store.keepInFlight();
  assert.equal(store.take(b), null);
  const listed = store.entries()[0];
  listed.context.file = b.file;
  assert.equal(store.take(a)?.text, 'original');
});

test('unknown origin stays distinct from every known agent, file and root leaf', () => {
  const store = new UnsentInputStore();
  const unknown: InputContext = { agentId: null, file: null, leafId: undefined };
  store.keep(unknown, { text: 'browser-restored draft', images: [] });
  assert.equal(store.take({ agentId: 'mux', file: null, leafId: null }), null);
  assert.equal(store.take(unknown)?.text, 'browser-restored draft');
});
