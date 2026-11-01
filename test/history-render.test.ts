import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildHistoryItems, messageImages, type SessionHistoryEntry } from '../src/public/history-render.ts';
import type { AppMessage } from '../src/public/app-types.ts';

function msg(message: AppMessage): SessionHistoryEntry {
  return { type: 'message', message };
}

test('user text and images preserve their order and supported image shapes', () => {
  const { items } = buildHistoryItems([msg({ role: 'user', content: [
    { type: 'text', text: 'line one' }, { type: 'text', text: 'line two' },
    { type: 'image', source: { data: 'abc123', media_type: 'image/jpeg' } },
  ] })]);
  assert.deepEqual(items, [{ kind: 'user', content: 'line one\nline two', images: [{ data: 'abc123', mimeType: 'image/jpeg' }] }]);
});

test('shared live images and saved images use the same MIME-aware extraction', () => {
  for (const image of [
    { type: 'image', data: 'jpeg-data', mimeType: 'image/jpeg' },
    { type: 'image', data: 'jpeg-data', media_type: 'image/jpeg' },
    { type: 'image', source: { data: 'jpeg-data', media_type: 'image/jpeg' } },
  ]) {
    const message = { role: 'user', content: [image] };
    const images = [{ data: 'jpeg-data', mimeType: 'image/jpeg' }];
    assert.deepEqual(messageImages(message), images);
    assert.deepEqual(buildHistoryItems([msg(message)]).items, [{ kind: 'user', content: '', images }]);
  }
  assert.deepEqual(messageImages({ role: 'user', content: 'plain text' }), []);
});

test('empty user messages are omitted but image-only messages remain', () => {
  const { items } = buildHistoryItems([
    msg({ role: 'user', content: '' }), msg({ role: 'user', content: [] }),
    msg({ role: 'user', content: [{ type: 'image', data: 'xyz', media_type: 'image/png' }] }),
  ]);
  assert.deepEqual(items, [{ kind: 'user', content: '', images: [{ data: 'xyz', mimeType: 'image/png' }] }]);
});

test('text and thinking are distinct typed activity steps in original order', () => {
  const { items } = buildHistoryItems([msg({ role: 'assistant', content: [
    { type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' },
    { type: 'thinking', thinking: 'another thought' },
  ] })]);
  assert.deepEqual(items, [
    { kind: 'assistant', step: { type: 'thinking', text: 'hmm' } },
    { kind: 'assistant', step: { type: 'text', text: 'answer' } },
    { kind: 'assistant', step: { type: 'thinking', text: 'another thought' } },
  ]);
});

test('string assistant content is a text step and never a thinking fallback', () => {
  assert.deepEqual(buildHistoryItems([msg({ role: 'assistant', content: 'answer' })]).items,
    [{ kind: 'assistant', step: { type: 'text', text: 'answer' } }]);
});

test('a final empty assistant error remains a visible error step', () => {
  assert.deepEqual(buildHistoryItems([msg({ role: 'assistant', content: [], stopReason: 'error', errorMessage: '401: API key expired' })]).items,
    [{ kind: 'assistantError', error: '401: API key expired' }]);
});

test('partial content stays before its final error, including thinking-only replies', () => {
  for (const content of [
    [{ type: 'text', text: 'partial answer' }],
    [{ type: 'thinking', thinking: 'private reasoning' }],
  ]) {
    const { items } = buildHistoryItems([msg({ role: 'assistant', content, stopReason: 'error', errorMessage: '500: upstream failed' })]);
    assert.equal(items.length, 2);
    assert.deepEqual(items[1], { kind: 'assistantError', error: '500: upstream failed' });
    assert.ok(!JSON.stringify(items[1]).includes('private reasoning'));
  }
});

test('a provider error without detail uses the final failure fallback', () => {
  assert.deepEqual(buildHistoryItems([msg({ role: 'assistant', stopReason: 'error' })]).items,
    [{ kind: 'assistantError', error: 'Request failed' }]);
});

test('a later assistant reply suppresses the recovered error, not partial content', () => {
  const { items } = buildHistoryItems([
    msg({ role: 'user', content: 'question' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'error', errorMessage: '503: try again' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'recovered answer' }], stopReason: 'stop' }),
  ]);
  assert.deepEqual(items.map(item => item.kind), ['user', 'assistant', 'assistant']);
  assert.ok(!JSON.stringify(items).includes('503: try again'));
});

test('an empty failed attempt leaves no empty bubble after successful retry', () => {
  const { items } = buildHistoryItems([
    msg({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'retry me' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'recovered' }] }),
  ]);
  assert.deepEqual(items, [{ kind: 'assistant', step: { type: 'text', text: 'recovered' } }]);
});

test('only the last failed retry is final within a user turn', () => {
  const { items } = buildHistoryItems([
    msg({ role: 'user', content: 'question' }),
    msg({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'first failure' }),
    msg({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'final failure' }),
  ]);
  assert.deepEqual(items.map(item => item.kind), ['user', 'assistantError']);
  assert.deepEqual(items[1], { kind: 'assistantError', error: 'final failure' });
});

test('a new user turn cannot recover the previous turn\'s final error', () => {
  const { items } = buildHistoryItems([
    msg({ role: 'user', content: 'first question' }),
    msg({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'expired' }),
    msg({ role: 'user', content: 'second question' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'second answer' }] }),
  ]);
  assert.deepEqual(items.map(item => item.kind), ['user', 'assistantError', 'user', 'assistant']);
  assert.deepEqual(items[1], { kind: 'assistantError', error: 'expired' });
});

test('tool-only assistant messages emit calls without empty text steps', () => {
  const { items } = buildHistoryItems([msg({ role: 'assistant', content: [
    { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'ls' } },
    { type: 'toolCall', id: 'tc-2', name: 'read', arguments: { path: '/x' } },
  ] })]);
  assert.deepEqual(items, [
    { kind: 'toolCall', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls' } },
    { kind: 'toolCall', toolCallId: 'tc-2', toolName: 'read', args: { path: '/x' } },
  ]);
});

test('interleaved steps keep chronology and out-of-order tool results across compaction', () => {
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

test('nested records stay with their own parent without adding history items', () => {
  const first: NonNullable<AppMessage['nestedCalls']> = { complete: true, calls: [{ id: 'a/1', name: 'read', arguments: { path: '/a' }, status: 'ok', durationMs: 12 }] };
  const second = { complete: false, calls: [] };
  const { items } = buildHistoryItems([
    msg({ role: 'assistant', content: [
      { type: 'toolCall', id: 'a', name: 'codemode', arguments: { code: 'a()' } },
      { type: 'toolCall', id: 'b', name: 'codemode', arguments: { code: 'b()' } },
    ] }),
    msg({ role: 'toolResult', toolCallId: 'b', content: [], nestedCalls: second }),
    msg({ role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: 'parent output' }], nestedCalls: first }),
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { kind: 'toolCall', toolCallId: 'a', toolName: 'codemode', args: { code: 'a()' }, result: { content: [{ type: 'text', text: 'parent output' }], nestedCalls: first }, isError: false });
  assert.deepEqual(items[1], { kind: 'toolCall', toolCallId: 'b', toolName: 'codemode', args: { code: 'b()' }, result: { content: [], nestedCalls: second }, isError: false });
});

test('unmatched tool results are ignored', () => {
  assert.deepEqual(buildHistoryItems([msg({ role: 'toolResult', toolCallId: 'ghost', content: [] })]).items, []);
});

test('tool-result usage is separate from assistant usage', () => {
  const { totalCost, lastInputTokens, lastUsage } = buildHistoryItems([
    msg({ role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'codemode', arguments: {} }] }),
    msg({ role: 'toolResult', toolCallId: 'a', content: [], usage: { input: 999, cost: { total: 12 } } }),
  ]);
  assert.equal(totalCost, 0);
  assert.equal(lastInputTokens, 0);
  assert.equal(lastUsage, null);
});

test('assistant costs sum across messages', () => {
  assert.equal(buildHistoryItems([
    msg({ role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { cost: { total: 0.5 } } }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'b' }], usage: { cost: { total: 0.25 } } }),
  ]).totalCost, 0.75);
});

test('splitting steps counts usage once, including tool-only messages, not cache warming as context', () => {
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

test('context edits change model context only: the target stays displayed', () => {
  const entries = [
    { type: 'message', id: 'u1', message: { role: 'user', content: 'kept in UI' } },
    { type: 'context_edit', targetId: 'u1', replacement: null },
    { type: 'context_edit', targetId: 'u1', replacement: 'replaced for the model' },
  ];
  assert.deepEqual(buildHistoryItems(entries).items, [{ kind: 'user', content: 'kept in UI', images: undefined }]);
});
