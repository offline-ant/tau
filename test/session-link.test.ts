import assert from 'node:assert/strict';
import test from 'node:test';
import { clearSessionLinkHash, SessionLink } from '../src/public/session-link.ts';

for (const hash of ['#session=one', '#session=missing', '#session=%FF', '#session=']) {
  test(`consumed session hash ${hash} is removed without changing path, query or history state`, () => {
    const state = { saved: true };
    const replacements: unknown[][] = [];
    clearSessionLinkHash({ hash, pathname: '/tau/', search: '?view=chat&x=%2F' }, {
      state,
      replaceState: (...args) => { replacements.push(args); },
    });
    assert.deepEqual(replacements, [[state, '', '/tau/?view=chat&x=%2F']]);
  });
}

test('consumption does not erase unrelated URL fragments', () => {
  for (const hash of ['', '#', '#settings', '#sessions=one']) {
    clearSessionLinkHash({ hash, pathname: '/', search: '' }, {
      state: null,
      replaceState: () => { assert.fail(`Must preserve ${hash}`); },
    });
  }
});

test('a link selects only its exact decoded live id, once', () => {
  const id = 'tau/a+b & #';
  const link = new SessionLink(`#session=${encodeURIComponent(id)}`);
  assert.deepEqual(link.take(['other', id]), { kind: 'select', id });
  assert.equal(link.take([id]), null, 'reconnect must not apply the old link');
});

test('no link leaves normal saved-tab restoration alone', () => {
  for (const hash of ['', '#', '#settings', '#sessions=one']) {
    assert.equal(new SessionLink(hash).take(['one']), null);
  }
});

test('missing targets are consumed rather than selecting a future tab', () => {
  const link = new SessionLink('#session=later');
  assert.deepEqual(link.take(['other']), { kind: 'missing' });
  assert.equal(link.take(['later']), null);
});

test('malformed links are explicit, bounded, and consumed', () => {
  for (const hash of ['#session=', '#session=%', '#session=%FF', '#session=%00', `#session=${'a'.repeat(257)}`]) {
    const link = new SessionLink(hash);
    assert.deepEqual(link.take([]), { kind: 'invalid' });
    assert.equal(link.take([]), null);
  }
});

test('new hash replaces pending navigation; user selection cancels it', () => {
  const link = new SessionLink('#session=first');
  link.set('#session=second');
  assert.deepEqual(link.take(['first', 'second']), { kind: 'select', id: 'second' });
  link.set('#session=first');
  link.cancel();
  assert.equal(link.take(['first']), null);
  link.set('#session=first');
  link.set('');
  assert.equal(link.take(['first']), null);
});
