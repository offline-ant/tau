import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildHistoryItems, type SessionHistoryEntry } from '../src/public/history-render.ts';
import type { AppMessage } from '../src/public/app-types.ts';

function msg(message: AppMessage): SessionHistoryEntry {
  return { type: 'message', message };
}

test('interleaved steps keep their chronology and out-of-order tool results across compaction', () => {
  const { items } = buildHistoryItems([
    msg({ role: 'user', content: [
      { type: 'text', text: 'Check' }, { type: 'text', text: 'these files' },
      { type: 'image', data: 'abc', media_type: 'image/png' },
    ] }),
    msg({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'Plan' },
      { type: 'toolCall', id: 'a', name: 'read', arguments: { path: '/a' } },
      { type: 'text', text: 'Also check b' },
      { type: 'toolCall', id: 'b', name: 'read', arguments: { path: '/b' } },
    ] }),
    msg({ role: 'toolResult', toolCallId: 'b', content: [{ type: 'text', text: 'result-b' }] }),
    msg({ role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: 'failed-a' }], isError: true }),
    msg({ role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'self_compact', arguments: {} }] }),
    msg({ role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: 'Handoff' }] }),
    { type: 'compaction', summary: 'Summary' },
    msg({ role: 'assistant', content: [{ type: 'text', text: 'Continued' }] }),
    msg({ role: 'user', content: [{ type: 'image', data: 'next', media_type: 'image/jpeg' }] }),
    msg({ role: 'assistant', content: [{ type: 'toolCall', id: 'd', name: 'read', arguments: { path: '/d' } }] }),
    msg({ role: 'toolResult', toolCallId: 'unknown', content: [{ type: 'text', text: 'orphan' }] }),
  ]);
  assert.deepEqual(items, [
    { kind: 'user', content: 'Check\nthese files', images: [{ data: 'abc', mimeType: 'image/png' }] },
    { kind: 'assistant', step: { type: 'thinking', text: 'Plan' } },
    { kind: 'toolCall', toolCallId: 'a', toolName: 'read', args: { path: '/a' }, result: { content: [{ type: 'text', text: 'failed-a' }] }, isError: true },
    { kind: 'assistant', step: { type: 'text', text: 'Also check b' } },
    { kind: 'toolCall', toolCallId: 'b', toolName: 'read', args: { path: '/b' }, result: { content: [{ type: 'text', text: 'result-b' }] }, isError: false },
    { kind: 'toolCall', toolCallId: 'c', toolName: 'self_compact', args: {}, result: { content: [{ type: 'text', text: 'Handoff' }] }, isError: false },
    { kind: 'compaction', summary: 'Summary' },
    { kind: 'assistant', step: { type: 'text', text: 'Continued' } },
    { kind: 'user', content: '', images: [{ data: 'next', mimeType: 'image/jpeg' }] },
    { kind: 'toolCall', toolCallId: 'd', toolName: 'read', args: { path: '/d' } },
  ]);
});

test('splitting assistant steps counts usage once and cache warming cannot replace the last context measurement', () => {
  const last = { input: 200, cacheRead: 50, cost: { total: 0.2 } };
  const { items, totalCost, lastInputTokens, lastUsage } = buildHistoryItems([
    msg({ role: 'assistant', usage: { input: 100, cost: { total: 0.5 } }, content: [
      { type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Checking' },
      { type: 'toolCall', id: 'a', name: 'read', arguments: {} },
    ] }),
    msg({ role: 'assistant', usage: last, content: [{ type: 'toolCall', id: 'b', name: 'read', arguments: {} }] }),
    { type: 'usage', usage: { input: 0, cacheRead: 50000, cost: { total: 0.015 } } },
    msg({ role: 'assistant', content: [{ type: 'text', text: 'Done' }] }),
  ]);
  assert.equal(items.length, 5, 'cache warming is not displayed');
  assert.equal(totalCost, 0.715);
  assert.equal(lastInputTokens, 250);
  assert.deepEqual(lastUsage, last);
});

test('context_edit entries change model context only: the target stays displayed', () => {
  const entries = [
    { type: 'message', id: 'u1', message: { role: 'user', content: 'kept in UI' } },
    { type: 'context_edit', targetId: 'u1', replacement: null },
    { type: 'context_edit', targetId: 'u1', replacement: 'replaced for the model' },
  ];
  const { items } = buildHistoryItems(entries);
  assert.deepEqual(items, [{ kind: 'user', content: 'kept in UI', images: undefined }]);
});
