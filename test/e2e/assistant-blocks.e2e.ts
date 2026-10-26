import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebSocketServer, type WebSocket } from 'ws';

// The compiled UI, real WebSocket delivery and a disposable read-only backend.
// No Pi process, inference, provider credentials or live Tau server is used.
const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const session = { id: 'blocks', cwd: '/test', sessionName: 'Blocks', sessionFile: '/test/blocks.jsonl', isStreaming: false };
type Block = { type: string; [key: string]: unknown };
type Entry = { type: string; message?: Record<string, unknown>; summary?: string };
type Event = { type: string; [key: string]: unknown };
const text = (value: string): Block => ({ type: 'text', text: value });
const thinking = (value: string): Block => ({ type: 'thinking', thinking: value });
const tool = (id: string, name = 'bash'): Block => ({ type: 'toolCall', id, name, arguments: { command: `echo ${id}` } });
const message = (role: string, content: string | Block[], extra: Record<string, unknown> = {}): Entry => ({ type: 'message', message: { role, content, ...extra } });
const user = message('user', 'task');
const result = (id: string, value: string, isError = false) => message('toolResult', [text(value)], { toolCallId: id, isError });

let browser: Browser;
let base = '';
const contexts = new Set<BrowserContext>();
const sockets = new Set<WebSocket>();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://fixture');
  const json = (data: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  if (url.pathname === '/api/live-sessions') return json({ sessions: [session] });
  if (url.pathname === '/api/rpc') {
    for await (const _chunk of req) { /* drain */ }
    return json({ success: true, data: {} });
  }
  if (url.pathname === '/api/health') return json({ platform: 'linux' });
  if (url.pathname === '/api/projects' || url.pathname === '/api/sessions') return json({ projects: [] });
  if (url.pathname === '/api/files') return json({ items: [], path: '/test' });
  const file = path.resolve(publicDir, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.send(JSON.stringify({ type: 'state', liveSessions: [session] }));
});
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY');
  browser = await chromium.launch({ executablePath });
});
after(async () => {
  for (const context of contexts) await context.close();
  await browser?.close();
  for (const socket of sockets) socket.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function open(entries: Entry[] = [user], isStreaming = false) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: 'block' });
  contexts.add(context);
  await context.addInitScript(() => localStorage.setItem('tau-active-live-session-id', 'blocks'));
  await context.route('**/api/live-sessions/blocks/snapshot', route => route.fulfill({ json: { session, entries, isStreaming } }));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const connection = new Promise<WebSocket>(resolve => wss.once('connection', resolve));
  await page.goto(base);
  const socket = await connection;
  await page.waitForSelector('.message.user');
  let receipt = 0;
  return {
    page,
    async emit(...events: Event[]) {
      for (const event of events) socket.send(JSON.stringify({ type: 'event', sessionId: session.id, event }));
      // A final ordered event provides a delivery receipt, without sleeps or
      // relying on the timing of unrelated rendering/animation frames.
      const name = `receipt-${++receipt}`;
      socket.send(JSON.stringify({ type: 'event', sessionId: session.id, event: { type: 'session_name', name } }));
      await page.waitForFunction(name => document.querySelector('.live-tab-title')?.textContent === name, name);
    },
    async close() {
      await context.close();
      contexts.delete(context);
      assert.deepEqual(errors, [], 'no browser errors');
    },
  };
}

// Complete assistant messages still use the actual incremental event shapes.
function assistantEvents(content: Block[]): Event[] {
  const events: Event[] = [{ type: 'message_start', message: { role: 'assistant', content: [] } }];
  content.forEach((block, contentIndex) => {
    if (block.type === 'text' || block.type === 'thinking') {
      const prefix = block.type;
      events.push({ type: 'message_update', assistantMessageEvent: { type: `${prefix}_start`, contentIndex } });
      events.push({ type: 'message_update', assistantMessageEvent: { type: `${prefix}_delta`, contentIndex, delta: block[prefix] } });
      events.push({ type: 'message_update', assistantMessageEvent: { type: `${prefix}_end`, contentIndex, content: block[prefix] } });
    }
  });
  events.push({ type: 'message_end', message: { role: 'assistant', content } });
  return events;
}
function toolEvents(id: string, name = 'bash', isError = false): Event[] {
  return [
    { type: 'tool_execution_start', toolCallId: id, toolName: name, args: { command: `echo ${id}` } },
    { type: 'tool_execution_update', toolCallId: id, partialResult: { content: [text(`partial-${id}`)] } },
    { type: 'tool_execution_end', toolCallId: id, result: { content: [text(`output-${id}`)] }, isError },
  ];
}
const group = '.message.assistant.assistant-block';
const item = '.assistant-block-items > .assistant-block-item';
async function labels(page: Page) { return page.locator(`${group} ${item}`).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.label)); }
async function visibleItems(page: Page) { return page.locator(`${group} ${item}:visible`).count(); }

const conversation = [
  user,
  message('assistant', [thinking('First thought'), text('Checking now'), tool('a'), tool('b')]),
  result('b', 'output-b'), result('a', 'output-a'),
  message('assistant', [thinking('Second thought'), text('Final answer')]),
];
const orderedLabels = ['thinking', 'text', 'bash', 'bash', 'thinking', 'text'];

test('a full live run matches reopened history, stays working through tool rounds and ends with only its result visible', async () => {
  const view = await open();
  const history = await open(conversation);
  try {
    await view.emit({ type: 'agent_start' }, ...assistantEvents([thinking('First thought'), text('Checking now'), tool('a'), tool('b')]), ...toolEvents('b'), ...toolEvents('a'));
    assert.deepEqual(await labels(view.page), orderedLabels.slice(0, 4));
    assert.equal(await visibleItems(view.page), 0);
    await view.emit({ type: 'turn_end' });
    assert.equal(await visibleItems(view.page), 0, 'tool rounds do not finish a block');
    assert.equal(await view.page.locator(`${group}.working`).count(), 1);
    await view.emit({ type: 'turn_start' }, ...assistantEvents([thinking('Second thought'), text('Final answer')]));
    assert.equal(await visibleItems(view.page), 0, 'final-looking text is still hidden while working');
    await view.emit({ type: 'agent_end' });

    for (const page of [view.page, history.page]) {
      assert.equal(await page.locator(`#messages > ${group}`).count(), 1);
      assert.equal(await page.locator(`${group} > .message-content`).count(), 1, 'one shared bubble');
      assert.deepEqual(await labels(page), orderedLabels);
      assert.equal(await visibleItems(page), 1);
      assert.equal(await page.locator(`${group} ${item}`).last().innerText(), 'Final answer');
      assert.deepEqual(await page.locator('.tool-output').allTextContents(), ['output-a', 'output-b']);
      const toggle = page.locator('.assistant-block-toggle');
      assert.match(await toggle.innerText(), /bash\s*·\s*bash/);
      await toggle.click();
      assert.equal(await visibleItems(page), orderedLabels.length);
      assert.equal(await page.locator('.tool-args').first().isVisible(), true);
      assert.equal(await page.locator('.tool-output').first().isVisible(), true);
      await toggle.focus();
      await page.keyboard.press('Enter');
      assert.equal(await visibleItems(page), 1);
      await page.keyboard.press('Space');
      assert.equal(await visibleItems(page), orderedLabels.length);
    }

    // A tool failure is still the last-item result, not an automatic expansion.
    await view.emit(
      { type: 'message_start', message: { role: 'user', content: 'Try another command' } },
      { type: 'agent_start' }, ...assistantEvents([text('Trying'), tool('bad')]),
      ...toolEvents('bad', 'bash', true), { type: 'agent_end' },
    );
    assert.equal(await view.page.locator(group).count(), 2, 'a new user message starts a separate block');
    const failed = view.page.locator(group).last();
    assert.equal(await failed.locator('.assistant-block-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await failed.locator(`${item}:visible`).count(), 1);
    assert.equal(await failed.locator('.tool-output').innerText(), 'output-bad');
    assert.equal(await failed.locator('.tool-status.error').count(), 1);
  } finally {
    await view.close();
    await history.close();
  }
});

test('repeated self_compact handoffs remain separate and keep the same boundaries after reopening', async () => {
  const view = await open();
  const entries: Entry[] = [user];
  try {
    for (const [id, summary] of [['first', 'First handoff'], ['second', 'Second handoff']]) {
      const content = [text('Saving ' + summary), tool(id, 'self_compact')];
      await view.emit(
        { type: 'agent_start' }, ...assistantEvents(content), ...toolEvents(id, 'self_compact'),
        { type: 'agent_end' }, { type: 'compaction_start', reason: 'manual' },
      );
      assert.equal(await view.page.locator('#compaction-indicator').count(), 1);
      assert.equal(await view.page.locator(`${group}.working`).count(), 0);
      await view.emit({ type: 'compaction_end', reason: 'manual', result: { summary }, aborted: false });
      entries.push(message('assistant', content), result(id, 'output-' + id), { type: 'compaction', summary });
    }
    await view.emit({ type: 'agent_start' }, ...assistantEvents([text('Continuing')]), { type: 'agent_end' });
    entries.push(message('assistant', [text('Continuing')]));

    const history = await open(entries);
    try {
      for (const page of [view.page, history.page]) {
        assert.deepEqual(await page.locator('#messages > .message, #messages > .compaction-message').evaluateAll(elements =>
          elements.map(element => element.classList.contains('user') ? 'user' : element.classList.contains('compaction-message') ? 'compaction' : 'assistant')),
        ['user', 'assistant', 'compaction', 'assistant', 'compaction', 'assistant']);
        assert.deepEqual(await page.locator('#messages > .compaction-message').allTextContents(), [
          'Context compacted — First handoff', 'Context compacted — Second handoff',
        ]);
        assert.deepEqual(await labels(page), ['text', 'self_compact', 'text', 'self_compact', 'text']);
        assert.equal(await visibleItems(page), 3);
      }
    } finally { await history.close(); }
  } finally { await view.close(); }
});

test('attaching mid-compaction still creates its standalone item and closes the preceding block', async () => {
  const view = await open([
    user, message('assistant', [text('Saving a handoff'), tool('compact', 'self_compact')]),
    result('compact', 'output-compact'),
  ], true);
  try {
    assert.equal(await view.page.locator('#compaction-indicator').count(), 0, 'this browser missed compaction_start');
    await view.emit({ type: 'compaction_end', reason: 'manual', result: { summary: 'Handoff saved' }, aborted: false });
    assert.deepEqual(await view.page.locator('#messages > .compaction-message').allTextContents(), ['Context compacted — Handoff saved']);
    assert.equal(await view.page.locator(`${group}.working`).count(), 0);
    assert.equal(await visibleItems(view.page), 1);
    await view.emit({ type: 'agent_start' }, ...assistantEvents([text('Continuing')]), { type: 'agent_end' });
    assert.deepEqual(await view.page.locator('#messages > .message, #messages > .compaction-message').evaluateAll(elements =>
      elements.map(element => element.classList.contains('user') ? 'user' : element.classList.contains('compaction-message') ? 'compaction' : 'assistant')),
    ['user', 'assistant', 'compaction', 'assistant']);
    assert.equal(await visibleItems(view.page), 2);
  } finally { await view.close(); }
});

test('Hide Thinking filters labels and expanded content without removing eager history or live steps', async () => {
  const view = await open([...conversation, message('user', 'Reasoning only'), message('assistant', [thinking('Only a thought')])]);
  try {
    await view.page.locator(`${group} .assistant-block-toggle`).first().click();
    assert.equal(await visibleItems(view.page), 7);
    await view.page.locator('#settings-btn').click();
    await view.page.locator('#toggle-show-thinking').click();
    await view.page.locator('#settings-close').click();
    assert.equal(await view.page.locator('body.hide-thinking').count(), 1);
    assert.equal(await visibleItems(view.page), 4);
    assert.equal(await view.page.locator(`${group}.thinking-only`).isVisible(), false);
    assert.equal(await view.page.locator('[data-label="thinking"]').count(), 3, 'hidden content remains eagerly loaded');
    assert.equal(await view.page.locator('.assistant-block-toggle').first().textContent(), 'text · bash · bash · text');

    await view.emit({ type: 'message_start', message: { role: 'user', content: 'Next' } }, { type: 'agent_start' }, ...assistantEvents([thinking('Live reasoning'), text('Live answer')]));
    assert.equal(await view.page.locator('.assistant-block-toggle').last().textContent(), 'text');
    assert.equal(await view.page.locator('[data-label="thinking"]').count(), 4);
    await view.emit({ type: 'agent_end' });
    assert.equal(await view.page.getByText('Live answer', { exact: true }).isVisible(), true);
    await view.page.locator('.assistant-block-toggle').last().click();
    assert.equal(await view.page.getByText('Live reasoning', { exact: true }).isVisible(), false);
    await view.page.locator('#settings-btn').click();
    await view.page.locator('#toggle-show-thinking').click();
    await view.page.locator('#settings-close').click();
    assert.equal(await view.page.getByText('Live reasoning', { exact: true }).isVisible(), true);
    assert.equal(await view.page.getByText('Only a thought', { exact: true }).isVisible(), true);
    assert.equal(await view.page.locator('.assistant-block-toggle').last().textContent(), 'thinking · text');
  } finally { await view.close(); }
});

test('reconnecting mid-message repairs missing and interleaved steps without duplicating the working tail', async () => {
  const view = await open([user, message('assistant', [thinking('Before reconnect'), tool('a')]), result('a', 'output-a')], true);
  try {
    assert.equal(await view.page.locator(`${group}.working`).count(), 1);
    assert.equal(await visibleItems(view.page), 0);
    await view.emit(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 4, delta: 'tail only' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'middle' } },
      { type: 'message_end', message: { role: 'assistant', content: [
        thinking('Missed reasoning'), tool('between-a'), text('Full middle'), tool('between-b'), text('Full answer including tail only'),
      ] } },
      { type: 'agent_end' },
    );
    assert.equal(await view.page.locator(group).count(), 1);
    assert.deepEqual(await labels(view.page), ['thinking', 'bash', 'thinking', 'bash', 'text', 'bash', 'text']);
    assert.equal(await visibleItems(view.page), 1);
    assert.equal(await view.page.locator(`${group} ${item}`).last().innerText(), 'Full answer including tail only');
    await view.page.locator('.assistant-block-toggle').click();
    assert.equal(await visibleItems(view.page), 7);
    assert.deepEqual(await view.page.locator('.thinking-content').allTextContents(), ['Before reconnect', 'Missed reasoning']);
    assert.deepEqual(await view.page.locator('.assistant-step-content:not(.thinking-block)').allTextContents(), ['Full middle', 'Full answer including tail only']);
    assert.equal(await view.page.locator('.tool-output').first().innerText(), 'output-a');
  } finally { await view.close(); }
});

test('revealing a long result follows the bottom but leaves a scrolled-up reader in place', async () => {
  const view = await open();
  const answer = Array.from({ length: 70 }, (_, index) => `Paragraph ${index}.`).join('\n\n');
  const atBottom = () => view.page.waitForFunction(() => {
    const messages = document.getElementById('messages')!;
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 2;
  });
  try {
    await view.emit({ type: 'agent_start' }, ...assistantEvents([thinking('Working'), text(answer)]), { type: 'agent_end' });
    await atBottom();
    // A new prompt is a boundary, just as in a real multi-turn conversation.
    await view.emit({ type: 'message_start', message: { role: 'user', content: 'Another answer' } }, { type: 'agent_start' });
    await atBottom();
    await view.page.evaluate(() => {
      const messages = document.getElementById('messages')!;
      messages.scrollTo({ top: 0, behavior: 'instant' });
    });
    await view.page.waitForSelector('#scroll-bottom-btn:not(.hidden)');
    await view.emit(...assistantEvents([text(answer)]), { type: 'agent_end' });
    assert.equal(await view.page.locator('#messages').evaluate(element => element.scrollTop), 0);
  } finally { await view.close(); }
});

