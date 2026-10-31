import assert from 'node:assert/strict';
import test from 'node:test';
import { UnsentInputStore } from '../src/public/unsent-input.ts';

const image = { data: 'abc', mimeType: 'image/png' };

test('an acknowledged prompt is forgotten', () => {
  const store = new UnsentInputStore();
  store.track('p1', 'mux', { text: 'hello', images: [] });
  assert.equal(store.settle('p1', true), false);
  store.keepInFlight();
  assert.equal(store.take('mux'), null);
});

test('a refused prompt is kept under its agent, once', () => {
  const store = new UnsentInputStore();
  store.track('p1', 'mux', { text: 'hello', images: [image] });
  assert.equal(store.settle('p1', false), true, 'the caller reports it');
  assert.equal(store.settle('p1', false), false, 'a second answer changes nothing');
  assert.deepEqual(store.take('mux'), { text: 'hello', images: [image] });
  assert.equal(store.take('mux'), null);
});

test('a lost connection keeps every prompt in flight, per agent and in order', () => {
  const store = new UnsentInputStore();
  store.keep('a', { text: 'draft', images: [] });
  store.track('p1', 'a', { text: 'one', images: [image] });
  store.track('p2', 'b', { text: 'other', images: [] });
  store.track('p3', 'a', { text: 'two', images: [] });
  store.keepInFlight('a');
  assert.deepEqual(store.take('a'), { text: 'draft\n\none\n\ntwo', images: [image] });
  assert.equal(store.take('b'), null, 'another agent keeps waiting for its answer');
  store.keepInFlight();
  assert.equal(store.take('b')?.text, 'other');
});

test('detaching on purpose drops what an agent had waiting', () => {
  const store = new UnsentInputStore();
  store.keep('a', { text: 'draft', images: [] });
  store.track('p1', 'a', { text: 'one', images: [] });
  store.forget('a');
  store.keepInFlight();
  assert.equal(store.take('a'), null);
});
