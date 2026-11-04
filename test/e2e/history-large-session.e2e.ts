import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import {
  setupHistoryE2E,
  skipUnlessBrowser,
  openPage,
  openNestedPage,
  sessionItemSelector,
  assertNoPageErrors,
  liveManager,
  largeFile,
  smallFile,
  B_ROUNDS,
  LAST_MARKER,
  ROUNDS,
  TOOL_EVERY,
  TOTAL_ITEMS,
} from './history-harness.ts';

// Real-browser tests of a fully rendered large session: live tool cards,
// tool results paired across history chunks, and live updates that must
// leave the completed history and the reader's position alone.

setupHistoryE2E();

test('scroll to bottom reaches a large live tool card created off-screen', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage(t);

  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction(
    (expected: number) =>
      document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected,
    TOTAL_ITEMS,
    { timeout: 60000 }
  );

  await page.evaluate(() => {
    document.getElementById('messages')!.scrollTop = 0;
  });
  await page.waitForSelector('#scroll-bottom-btn:not(.hidden)');

  const session = liveManager.findBySessionFile(largeFile);
  assert.ok(session, 'large fixture should have a resumed live session');
  const toolCallId = 'live-large-tool';
  const marker = 'live-tool-args-final-line';
  liveManager.broadcast({
    type: 'event',
    sessionId: session.id,
    event: {
      type: 'tool_execution_start',
      toolCallId,
      toolName: 'write',
      args: { path: '/tmp/large.txt', content: `${'large argument line\n'.repeat(1000)}${marker}` },
    },
  });
  await page.waitForSelector(`.tool-card[data-tool-call-id="${toolCallId}"]`, { state: 'attached' });
  await page.waitForFunction(
    ({ id, text }: { id: string; text: string }) =>
      document.querySelector(`.tool-card[data-tool-call-id="${id}"]`)?.textContent?.includes(text),
    { id: toolCallId, text: marker }
  );
  // Give content-visibility two frames to classify the new bottom card as
  // off-screen without forcing a layout measurement of the card itself.
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  ));
  const liveCardContentVisibility = await page.evaluate((id: string) => {
    const card = document.querySelector(`.tool-card[data-tool-call-id="${id}"]`)!;
    return getComputedStyle(card).contentVisibility;
  }, toolCallId);
  assert.equal(liveCardContentVisibility, 'visible', 'live tool cards must remain fully laid out off-screen');

  await page.click('#scroll-bottom-btn');
  await page.waitForFunction(() => {
    const el = document.getElementById('messages')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 10;
  }, undefined, { timeout: 5000 });

  await assertNoPageErrors(errors);
});

test('tool results are paired onto their cards in both the newest and oldest chunks', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage(t);

  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction(
    (expected: number) =>
      document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected,
    TOTAL_ITEMS,
    { timeout: 60000 }
  );

  // Port the fork's grouped chronology assertion without replacing upstream
  // newest-first progressive loading with one blocking eager render.
  const ordered = await page.locator('#messages > .message').evaluateAll(nodes => nodes.map(element => ({
    user: element.classList.contains('user'), text: element.textContent || '',
  })));
  assert.equal(ordered.length, ROUNDS * 2);
  assert.equal(await page.locator('#messages > .assistant-block').count(), ROUNDS);
  assert.equal(await page.locator('.assistant-block .tool-card').count(), Math.ceil(ROUNDS / TOOL_EVERY));
  const pad = (i: number) => String(i).padStart(4, '0');
  for (let round = 0; round < ROUNDS; round++) {
    assert.equal(ordered[round * 2].user, true);
    assert.match(ordered[round * 2].text, new RegExp(`msg-user-${pad(round)}`));
    assert.equal(ordered[round * 2 + 1].user, false);
    assert.match(ordered[round * 2 + 1].text, new RegExp(`msg-asst-${pad(round)}`));
  }
  const lastToolRound = Math.floor((ROUNDS - 1) / TOOL_EVERY) * TOOL_EVERY;
  for (const round of [0, lastToolRound]) {
    const id = `tool-${pad(round)}`;
    const output = await page.evaluate((toolCallId: string) => {
      const card = document.querySelector(`.tool-card[data-tool-call-id="${toolCallId}"]`);
      return card?.querySelector('.tool-output')?.textContent ?? null;
    }, id);
    assert.equal(output, `tool-result-${pad(round)}`, `result missing on card ${id}`);
    const card = page.locator(`.tool-card[data-tool-call-id="${id}"]`);
    assert.equal(await card.locator('.nested-calls').count(), 1);
    assert.deepEqual(await card.locator('.nested-call-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-call-id'))), [id + '/1', id + '/1/1']);
    assert.deepEqual(await card.locator('.nested-call-duration').allTextContents(), ['12 ms', '4 ms']);
    assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await card.locator('.nested-call-details pre').count(), 0);
    assert.match(await card.locator('.nested-calls-indicator').textContent() || '', /2 succeeded/);
  }

  await assertNoPageErrors(errors);
});

test('grouped history expands, collapses and reopens without stale DOM or card references', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage(t);
  const openLarge = async () => {
    await page.click(sessionItemSelector(largeFile));
    await page.waitForFunction((expected: number) => document.querySelectorAll('#messages > .message').length === expected,
      TOTAL_ITEMS, { timeout: 60000 });
    assert.ok((await page.locator('#messages').textContent())?.includes(LAST_MARKER));
  };
  const command = async (label: string) => {
    await page.click('#command-btn');
    await page.getByText(label, { exact: true }).click();
  };
  await openLarge();
  await command('Expand All Steps');
  assert.equal(await page.locator('.assistant-block.expanded').count(), ROUNDS);
  assert.equal(await page.locator('.assistant-block-item[data-label="text"]').first().isVisible(), true);
  assert.equal(await page.locator('.tool-card-body').first().isVisible(), true);
  await command('Collapse All Steps');
  assert.equal(await page.locator('.assistant-block.expanded').count(), 0);
  assert.equal(await page.locator('.assistant-block-item[data-label="text"]').first().isVisible(), false);
  assert.equal(await page.locator('.tool-card-body').first().isVisible(), true, 'the final tool result remains readable');
  await page.click(sessionItemSelector(smallFile));
  await page.waitForFunction((expected: number) => document.getElementById('messages')?.textContent?.includes(`other-asst-${expected - 1}`), B_ROUNDS);
  assert.equal(await page.locator('#messages > .message').count(), B_ROUNDS * 2);
  assert.equal(await page.locator('.tool-card').count(), 0);
  assert.ok(!/msg-user-|msg-asst-|tool-result-/.test(await page.locator('#messages').textContent() || ''));
  await openLarge();
  assert.equal(await page.locator('.tool-card[data-tool-call-id="tool-0000"] .tool-output').textContent(), 'tool-result-0000');
  await command('Expand All Steps');
  assert.equal(await page.locator('.assistant-block-item[data-label="text"]').first().isVisible(), true);
  await command('Collapse All Steps');
  assert.equal(await page.locator('.assistant-block-item[data-label="text"]').first().isVisible(), false);
  await assertNoPageErrors(errors);
});

test('a completed grouped tool result remains reachable after reading older history', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage(t);
  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction((expected: number) => document.querySelectorAll('#messages > .message').length === expected,
    TOTAL_ITEMS, { timeout: 60000 });
  await page.evaluate(() => document.getElementById('messages')!.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForSelector('#scroll-bottom-btn:not(.hidden)');
  const session = liveManager.findBySessionFile(largeFile);
  assert.ok(session);
  const toolCallId = 'completed-large-tool';
  const marker = 'completed-tool-final-line';
  for (const event of [
    { type: 'message_start', message: { role: 'user', content: 'Create the large file.' } },
    { type: 'agent_start' },
    { type: 'tool_execution_start', toolCallId, toolName: 'write', args: { path: '/tmp/large.txt', content: `${'argument line\n'.repeat(1000)}${marker}` } },
    { type: 'tool_execution_end', toolCallId, result: { content: [{ type: 'text', text: 'File written.' }] }, isError: false },
    { type: 'agent_end' },
    { type: 'agent_settled' },
  ]) liveManager.broadcast({ type: 'event', sessionId: session.id, event });
  const card = page.locator(`.assistant-block .tool-card[data-tool-call-id="${toolCallId}"]`);
  await card.waitFor();
  assert.ok((await card.textContent())?.includes(marker));
  assert.equal(await card.locator('.tool-card-body').isVisible(), true);
  await page.click('#scroll-bottom-btn');
  await page.waitForFunction(() => {
    const messages = document.getElementById('messages')!;
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 10;
  });
  const position = await card.evaluate(element => {
    const viewport = document.getElementById('messages')!.getBoundingClientRect();
    const output = element.querySelector('.tool-output')!.getBoundingClientRect();
    return { top: output.top, bottom: output.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom };
  });
  assert.ok(position.bottom > position.viewportTop && position.bottom <= position.viewportBottom + 1);
  await assertNoPageErrors(errors);
});

test('thinking-only activity never leaks into text and final provider errors survive hidden thinking', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, broadcast } = await openNestedPage(t);
  await page.click('#settings-btn');
  await page.click('#toggle-show-thinking');
  await page.click('#settings-close');
  const emit = (event: unknown) => broadcast(event as JsonAgentSessionEvent);
  const thinking = 'private thinking must not become final text';
  emit({ type: 'message_start', message: { role: 'user', content: 'A thinking-only reply' } });
  emit({ type: 'agent_start' });
  emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: thinking } });
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking }] } });
  emit({ type: 'agent_end' });
  emit({ type: 'agent_settled' });
  await page.locator('.thinking-content').last().waitFor({ state: 'attached' });
  assert.equal(await page.locator('.thinking-content').last().isVisible(), false);
  assert.ok(!(await page.locator('.assistant-step-content:not(.thinking-block)').allTextContents()).some(text => text.includes(thinking)));

  emit({ type: 'message_start', message: { role: 'user', content: 'Try again' } });
  emit({ type: 'agent_start' });
  emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'retryable failure' } });
  emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: 'retryable failure' });
  await page.locator('.retry-message').waitFor();
  assert.equal(await page.locator('.message-error').count(), 0);
  emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking }], stopReason: 'error', errorMessage: 'final provider failure' } });
  emit({ type: 'auto_retry_end', success: false, finalError: 'final provider failure' });
  emit({ type: 'agent_end' });
  assert.equal(await page.locator('.message-error').count(), 0, 'agent_end does not finalize failures before end hooks');
  emit({ type: 'agent_settled' });
  await page.locator('.message-error').waitFor();
  assert.equal(await page.locator('.message-error').count(), 1);
  assert.equal(await page.locator('.message-error-detail').textContent(), 'final provider failure');
  assert.equal(await page.locator('.message-error').isVisible(), true, 'hidden thinking cannot hide the final error');
  assert.equal(await page.locator('.retry-message').count(), 0);
  assert.ok(!(await page.locator('.assistant-step-content:not(.thinking-block)').allTextContents()).some(text => text.includes(thinking)));
  await assertNoPageErrors(errors);
});

test('an unrelated live root leaves completed history DOM untouched', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage(t);
  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction((expected: number) =>
    document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected, TOTAL_ITEMS, { timeout: 60000 });
  await page.evaluate(() => {
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    document.querySelectorAll('.tool-card.history').forEach(card => observer.observe(card, {
      attributes: true, childList: true, characterData: true, subtree: true,
    }));
    Object.assign(window, { historyMutationCount: () => { observer.disconnect(); return mutations; } });
  });
  const session = liveManager.findBySessionFile(largeFile);
  const id = 'unrelated-history-root';
  liveManager.broadcast({ type: 'event', sessionId: session.id, event: {
    type: 'tool_execution_start', toolCallId: id, toolName: 'codemode', args: {},
  } satisfies JsonAgentSessionEvent });
  await page.locator(`.tool-card[data-tool-call-id="${id}"]`).waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => (window as unknown as { historyMutationCount: () => number }).historyMutationCount()), 0);
  assert.equal(await page.locator('.tool-card.history').count(), Math.ceil(ROUNDS / TOOL_EVERY));
  await assertNoPageErrors(errors);
});

test('nested updates do not move a reader scrolled above a live parent', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage(t);
  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction((expected: number) =>
    document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected, TOTAL_ITEMS, { timeout: 60000 });
  const session = liveManager.findBySessionFile(largeFile);
  assert.ok(session);
  await page.waitForFunction(() => {
    const el = document.getElementById('messages')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 10;
  });
  const anchor = page.locator('#messages > .message').first();
  await anchor.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'start' }));
  await page.waitForSelector('#scroll-bottom-btn:not(.hidden)');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const before = await anchor.evaluate(el => el.getBoundingClientRect().top);
  const id = 'offscreen-nested-parent';
  const broadcast = (event: JsonAgentSessionEvent) => liveManager.broadcast({ type: 'event', sessionId: session.id, event });
  broadcast({ type: 'tool_execution_start', toolCallId: id, toolName: 'codemode', args: {} });
  broadcast({ type: 'tool_execution_start', toolCallId: id + '/1', parentToolCallId: id, toolName: 'read', args: { path: '/tmp/offscreen.txt' } });
  broadcast({ type: 'tool_execution_update', toolCallId: id + '/1', parentToolCallId: id, toolName: 'read', args: {}, partialResult: { content: [{ type: 'text', text: 'offscreen child secret' }], details: {} } });
  broadcast({ type: 'tool_execution_end', toolCallId: id + '/1', parentToolCallId: id, toolName: 'read', result: { content: [{ type: 'text', text: 'offscreen child secret' }], details: {} }, isError: false });
  await page.waitForFunction((root: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${root}"] .nested-call-status`)?.textContent === 'succeeded', id);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const after = await anchor.evaluate(el => el.getBoundingClientRect().top);
  assert.ok(Math.abs(after - before) <= 3, `nested events moved the reading anchor from ${before} to ${after}`);
  assert.ok(!(await page.locator('#messages').textContent())?.includes('offscreen child secret'));
  await assertNoPageErrors(errors);
});
