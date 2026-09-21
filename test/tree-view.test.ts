import { test } from 'node:test';
import assert from 'node:assert/strict';

// Compiled frontend module without declarations (see history-render.test.ts).
const { describeEntry } = (await import('../public/tree-view.js')) as any;

test('context_edit entries are housekeeping rows naming the edit and its target', () => {
  assert.deepEqual(describeEntry({ type: 'context_edit', id: 'e1', parentId: 'a1', targetId: 'u1', replacement: null }), {
    kind: 'meta',
    text: 'context omit → u1',
  });
  assert.deepEqual(
    describeEntry({ type: 'context_edit', id: 'e2', parentId: 'e1', targetId: 'u1', replacement: [{ type: 'text', text: 'x' }] }),
    { kind: 'meta', text: 'context replace → u1' }
  );
});
