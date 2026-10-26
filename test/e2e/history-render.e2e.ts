import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FakePi } from '../fake-pi.ts';
import type { TreeEntry } from '../../src/server/tree.ts';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

// Real-browser integration of eager history rendering and assistant blocks,
// against the in-process server with faux Pi children (no inference).
process.env.TAU_HOST = '127.0.0.1';
process.env.TAU_USER = '';
process.env.TAU_PASS = '';
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-e2e-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
process.env.TAU_PROJECTS_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'projects');

// The server reads these environment variables at module initialization.
const { server, computeUrls, SESSIONS_DIR, liveManager, _setSpawnPiForTest, _setExecFileForTest } = await import('../../bin/tau.js');

let base = '';
let browser: Browser;
const contexts: BrowserContext[] = [];
const PROJ_DIR = path.join(SESSIONS_DIR, '--tmp--e2eproj');

function makeFakeChild(args: string[]) {
  const sessionFile = args[args.indexOf('--session') + 1];
  const entries = fs.readFileSync(sessionFile, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as TreeEntry).filter((entry) => entry.type !== 'session');
  return new FakePi({ sessionFile, tree: entries.map((entry) => ({ entry })), leafId: entries.at(-1)?.id ?? null }).asChild();
}

// Each round is one user bubble and one assistant block. Every fifth block
// contains text followed by a tool; its result is attached to that tool item.
const ROUNDS = 700;
const TOOL_EVERY = 5;
const TOTAL_MESSAGES = ROUNDS * 2;
const TOTAL_TOOLS = Math.ceil(ROUNDS / TOOL_EVERY);
const LAST_USAGE = { input: 12000, cacheRead: 30000, cost: { total: 0.001 } };
const LAST_MARKER = `msg-asst-${String(ROUNDS - 1).padStart(4, '0')}`;
const pad = (i: number) => String(i).padStart(4, '0');

function buildLargeSession(cwd: string) {
  const entries: Array<Record<string, unknown>> = [
    { type: 'session', id: 'e2e-large', timestamp: '2026-01-01T00:00:00.000Z', cwd },
  ];
  for (let i = 0; i < ROUNDS; i++) {
    entries.push({ type: 'message', message: { role: 'user', content: `msg-user-${pad(i)} question with *markdown* and $x_${i}$` } });
    const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: `msg-asst-${pad(i)} **answer**` }];
    if (i % TOOL_EVERY === 0) {
      blocks.push({ type: 'toolCall', id: `tool-${pad(i)}`, name: 'bash', arguments: { command: `echo round ${i}` } });
    }
    const usage = i === ROUNDS - 1 ? LAST_USAGE : { input: 100 + i, cost: { total: 0.001 } };
    entries.push({ type: 'message', message: { role: 'assistant', content: blocks, usage } });
    if (i % TOOL_EVERY === 0) {
      entries.push({
        type: 'message',
        message: { role: 'toolResult', toolCallId: `tool-${pad(i)}`, content: [{ type: 'text', text: `tool-result-${pad(i)}` }] },
      });
    }
  }
  entries.push({ type: 'session_info', name: 'Large E2E Session' });
  return entries;
}

const B_ROUNDS = 3;
function buildSmallSession(cwd: string) {
  const entries: Array<Record<string, unknown>> = [
    { type: 'session', id: 'e2e-small', timestamp: '2026-01-02T00:00:00.000Z', cwd },
  ];
  for (let i = 0; i < B_ROUNDS; i++) {
    entries.push({ type: 'message', message: { role: 'user', content: `other-user-${i}` } });
    entries.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `other-asst-${i}` }] } });
  }
  entries.push({ type: 'session_info', name: 'Small E2E Session' });
  return entries;
}

function writeSession(fileName: string, lines: Array<Record<string, unknown>>) {
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  const filePath = path.join(PROJ_DIR, fileName);
  const entries = lines.map((entry, index) => index === 0 ? entry
    : { ...entry, id: `entry-${index}`, parentId: index === 1 ? null : `entry-${index - 1}` });
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return filePath;
}

let largeFile = '';
let smallFile = '';

async function openPage() {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  contexts.push(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  await page.goto(base);
  // Project-first sidebars fetch session summaries only when expanded.
  await page.click('.project-header');
  await page.waitForSelector('.session-item');
  return { page, errors };
}

function sessionItemSelector(filePath: string) {
  return `.session-item[data-file-path="${path.resolve(filePath)}"]`;
}

async function openLargeSession(page: Page) {
  await page.click(sessionItemSelector(largeFile));
  await page.waitForSelector(`.assistant-block >> text=${LAST_MARKER}`, { timeout: 30000 });
}

async function command(page: Page, label: string) {
  await page.click('#command-btn');
  await page.getByText(label, { exact: true }).click();
}

before(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-e2e-cwd-'));
  largeFile = writeSession('large.jsonl', buildLargeSession(cwd));
  smallFile = writeSession('small.jsonl', buildSmallSession(cwd));
  _setSpawnPiForTest((_cmd: string, args: string[]) => makeFakeChild(args));
  _setExecFileForTest((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, '', ''));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  computeUrls(address.port);
  base = `http://127.0.0.1:${address.port}`;
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY to run this focused browser test');
  browser = await chromium.launch({ executablePath });
});

after(async () => {
  for (const context of contexts) await context.close();
  await browser?.close();
  await liveManager.shutdown();
  _setSpawnPiForTest(null);
  _setExecFileForTest(null);
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('a large session renders every block eagerly in chronological order and opens at the bottom with correct stats', async () => {
  const { page, errors } = await openPage();
  await page.click(sessionItemSelector(largeFile));
  // Observe the count in the same browser task that first finds the newest
  // answer. Older blocks and tool output must already be present, not deferred.
  const rendered = await page.waitForFunction(marker => {
    const container = document.getElementById('messages');
    if (!container?.textContent?.includes(marker)) return null;
    return {
      messages: container.querySelectorAll(':scope > .message').length,
      blocks: container.querySelectorAll(':scope > .assistant-block').length,
      tools: container.querySelectorAll('.tool-card').length,
    };
  }, LAST_MARKER, { timeout: 30000 });
  assert.deepEqual(await rendered.jsonValue(), { messages: TOTAL_MESSAGES, blocks: ROUNDS, tools: TOTAL_TOOLS });
  const ordered = await page.evaluate(() => [...document.querySelectorAll('#messages > .message')].map(element => ({
    user: element.classList.contains('user'),
    text: element.textContent || '',
  })));
  for (let i = 0; i < ROUNDS; i++) {
    assert.equal(ordered[i * 2].user, true);
    assert.match(ordered[i * 2].text, new RegExp(`msg-user-${pad(i)}`));
    assert.equal(ordered[i * 2 + 1].user, false);
    assert.match(ordered[i * 2 + 1].text, new RegExp(`msg-asst-${pad(i)}`));
  }
  await page.waitForFunction(() => {
    const messages = document.getElementById('messages')!;
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 10;
  });
  const lastToolRound = Math.floor((ROUNDS - 1) / TOOL_EVERY) * TOOL_EVERY;
  for (const round of [0, lastToolRound]) {
    const card = page.locator(`.assistant-block .tool-card[data-tool-call-id="tool-${pad(round)}"]`);
    assert.equal(await card.locator('.tool-output').textContent(), `tool-result-${pad(round)}`);
    assert.match(await card.locator('.tool-args').textContent() || '', new RegExp(`echo round ${round}`));
  }
  const pill = await page.waitForSelector('#context-pill.visible');
  assert.match((await pill.textContent())?.trim() || '', /^(42\.0k|<1%|\d+%)$/);
  assert.deepEqual(errors, []);
});

test('expanding large grouped history and switching away and back does not retain stale DOM or card references', async () => {
  const { page, errors } = await openPage();
  await openLargeSession(page);
  await command(page, 'Expand All Steps');
  let expanded = await page.locator('.assistant-block:has(.tool-card) > .message-content > .assistant-block-toggle').evaluateAll(buttons =>
    buttons.map(button => button.getAttribute('aria-expanded')));
  assert.equal(expanded.length, TOTAL_TOOLS);
  assert.ok(expanded.every(value => value === 'true'));
  assert.equal(await page.locator('.tool-card').first().isVisible(), true);
  assert.equal(await page.locator('.tool-card-body').first().isVisible(), true);
  assert.equal(await page.locator('.assistant-block-item[data-label="text"]').first().isVisible(), true);

  await command(page, 'Collapse All Steps');
  expanded = await page.locator('.assistant-block:has(.tool-card) > .message-content > .assistant-block-toggle').evaluateAll(buttons =>
    buttons.map(button => button.getAttribute('aria-expanded')));
  assert.ok(expanded.every(value => value === 'false'));
  assert.equal(await page.locator('.assistant-block-item[data-label="text"]').first().isVisible(), false, 'earlier text is folded');
  assert.equal(await page.locator('.tool-card-body').first().isVisible(), true, 'the final tool item remains the visible result');
  await page.click(sessionItemSelector(smallFile));
  await page.waitForSelector(`.assistant-block >> text=other-asst-${B_ROUNDS - 1}`);
  const found = await page.evaluate(() => ({
    stale: /msg-user-|msg-asst-|tool-result-/.test(document.getElementById('messages')!.textContent || ''),
    messages: document.querySelectorAll('#messages > .message').length,
    blocks: document.querySelectorAll('#messages > .assistant-block').length,
    tools: document.querySelectorAll('#messages .tool-card').length,
  }));
  assert.deepEqual(found, { stale: false, messages: B_ROUNDS * 2, blocks: B_ROUNDS, tools: 0 });
  await openLargeSession(page);
  const firstTool = page.locator('.tool-card[data-tool-call-id="tool-0000"]');
  assert.equal(await firstTool.locator('.tool-output').textContent(), 'tool-result-0000');
  await command(page, 'Expand All Steps');
  assert.equal(await page.locator('.assistant-block-item[data-label="text"]').first().isVisible(), true);
  await command(page, 'Collapse All Steps');
  assert.equal(await page.locator('.assistant-block-item[data-label="text"]').first().isVisible(), false);
  assert.deepEqual(errors, []);
});

test('scroll to bottom reaches a large tool result added while reading older history', async () => {
  const { page, errors } = await openPage();
  await openLargeSession(page);
  await page.waitForFunction(() => {
    const messages = document.getElementById('messages')!;
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 10;
  });
  await page.evaluate(() => { document.getElementById('messages')!.scrollTop = 0; });
  await page.waitForSelector('#scroll-bottom-btn:not(.hidden)');

  const session = liveManager.findBySessionFile(largeFile);
  assert.ok(session, 'fixture should have a resumed live session');
  const toolCallId = 'live-large-tool';
  const marker = 'live-tool-args-final-line';
  for (const event of [
    { type: 'message_start', message: { role: 'user', content: 'Create the large file.' } },
    { type: 'agent_start' },
    { type: 'tool_execution_start', toolCallId, toolName: 'write', args: { path: '/tmp/large.txt', content: `${'large argument line\n'.repeat(1000)}${marker}` } },
    { type: 'tool_execution_end', toolCallId, result: { content: [{ type: 'text', text: 'File written.' }] }, isError: false },
    { type: 'agent_end' },
  ]) liveManager.broadcast({ type: 'event', sessionId: session.id, event });
  const card = page.locator(`.tool-card[data-tool-call-id="${toolCallId}"]`);
  await card.waitFor();
  assert.match(await card.textContent() || '', new RegExp(marker));
  assert.equal(await card.locator('.tool-card-body').isVisible(), true);
  await page.click('#scroll-bottom-btn');
  await page.waitForFunction(() => {
    const messages = document.getElementById('messages')!;
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 10;
  });
  const position = await card.evaluate(element => {
    const messages = document.getElementById('messages')!.getBoundingClientRect();
    const output = element.querySelector('.tool-output')!.getBoundingClientRect();
    return { top: output.top, bottom: output.bottom, viewportTop: messages.top, viewportBottom: messages.bottom };
  });
  assert.ok(position.bottom > position.viewportTop && position.bottom <= position.viewportBottom + 1, 'the latest tool output is visible at the bottom');
  assert.deepEqual(errors, []);
});
