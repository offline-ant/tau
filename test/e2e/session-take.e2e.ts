import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebSocketServer, type WebSocket } from 'ws';

// Real compiled UI, fake authenticated RPC surface; no Pi children or inference.
const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
type Command = { type: string; id?: string; sessionId?: string; message?: string; value?: string; cancelled?: boolean };
type Session = { id: string; cwd: string; sessionFile: string; sessionName: string; isStreaming: boolean; model: { provider: string; id: string }; thinkingLevel: string };
const original = (id: string): Session => ({ id, cwd: `/test/${id}`, sessionFile: `/test/${id}.jsonl`, sessionName: id, isStreaming: false, model: { provider: 'fixture', id: 'original' }, thinkingLevel: 'low' });
let sessions: Session[] = [];
const commands: Command[] = [];
const snapshots: string[] = [];
const sockets = new Set<WebSocket>();
let pending: Command | null = null;
let holdCompletion: (() => void) | null = null;
let delayCompletion = false;
let completionHeld: (() => void) | null = null;
let takeFailure: 'notify' | 'extension' | null = null;
let historicalAvailable = false;
let base: string;
let browser: Browser;
let context: BrowserContext;
function broadcast(value: unknown) { for (const socket of sockets) socket.send(JSON.stringify(value)); }
function snapshot(session: Session) {
  return { session, sessionFile: session.sessionFile, model: session.model, thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming,
    entries: [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: session.sessionName === 'Taken conversation' ? 'Restored Herdr answer' : `Original ${session.id}` }] } }] };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://fixture');
  const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname === '/api/live-sessions') return json({ sessions });
  const match = /^\/api\/live-sessions\/(.+)\/snapshot$/.exec(url.pathname);
  if (match) {
    const id = decodeURIComponent(match[1]);
    snapshots.push(id);
    const session = sessions.find(item => item.id === id)!;
    return json(snapshot(session));
  }
  if (url.pathname === '/api/rpc') {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const command = JSON.parse(body) as Command;
    commands.push(command);
    if (command.type === 'prompt') {
      assert.equal(command.message, '/take herdr');
      pending = command;
      broadcast({ type: 'event', sessionId: command.sessionId, event: { type: 'extension_ui_request', method: 'select', id: 'take-picker', title: 'Take from Herdr', options: ['Herdr: project'] } });
      // Tau can acknowledge its HTTP timeout before the Pi command actually finishes.
      return json({ type: 'response', command: 'prompt', id: command.id, success: true });
    }
    return json({ success: true, data: command.type === 'get_available_models' ? { models: [] } : {} });
  }
  if (url.pathname === '/api/health') return json({ platform: 'linux' });
  if (url.pathname === '/api/projects') return json({ projects: [] });
  if (url.pathname === '/api/sessions') return json({ projects: historicalAvailable ? [{ path: '/test/history', dirName: 'history', count: 1, lastActive: Date.now() }] : [] });
  if (url.pathname === '/api/sessions/history') return json({ sessions: [{ filePath: '/history/owned.jsonl', dir: 'history', file: 'owned.jsonl', name: 'Owned history', owner: { name: 'worker', host: 'herdr' } }] });
  if (url.pathname === '/api/sessions/history/owned.jsonl') return json({ entries: url.searchParams.get('since') === '0' ? snapshot(original('history')).entries : [], offset: 100, reset: false });
  if (url.pathname === '/api/files') {
    const session = sessions.find(item => item.id === url.searchParams.get('sessionId'))!;
    return json({ path: session.cwd, items: [] });
  }
  const file = path.resolve(publicDir, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' } as Record<string, string>)[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.send(JSON.stringify({ type: 'state', liveSessions: sessions }));
  socket.on('message', data => {
    const command = JSON.parse(String(data)) as Command;
    commands.push(command);
    // Another browser can close its obsolete copy of an already answered
    // dialog. Pi ignores such replies once that request is no longer pending.
    if (command.type !== 'extension_ui_response' || !pending) return;
    assert.equal(command.sessionId, pending.sessionId, 'the picker response stays with its original tab');
    const request = pending!;
    pending = null;
    const complete = () => {
      if (takeFailure) {
        const event = takeFailure === 'notify'
          ? { type: 'extension_ui_request', method: 'notify', notifyType: 'error', message: 'The source became busy before takeover.' }
          : { type: 'extension_error', error: 'The source connection failed before takeover.' };
        broadcast({ type: 'event', sessionId: request.sessionId, event });
      } else if (!command.cancelled) {
        const index = sessions.findIndex(item => item.id === request.sessionId);
        sessions[index] = { ...sessions[index], cwd: '/herdr/project', sessionFile: '/herdr/conversation.jsonl', sessionName: 'Taken conversation', model: { provider: 'fixture', id: 'taken-model' }, thinkingLevel: 'high' };
      }
      const current = sessions.find(session => session.id === request.sessionId)!;
      broadcast({ type: 'live_session_snapshot', sessionId: request.sessionId, ...snapshot(current) });
      broadcast({ type: 'live_session_updated', session: current });
      broadcast({ type: 'event', sessionId: request.sessionId, event: { type: 'response', command: 'prompt', id: request.id, success: true, data: { disposition: 'handled' } } });
    };
    if (delayCompletion) {
      holdCompletion = complete;
      completionHeld?.();
    } else complete();
  });
});

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY');
  browser = await chromium.launch({ executablePath });
});
after(async () => {
  holdCompletion?.();
  await context?.close();
  await browser?.close();
  for (const socket of sockets) socket.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
});
async function active(page: Page, id: string) {
  await page.waitForFunction(expected => document.querySelector<HTMLElement>('.live-tab.active')?.dataset.sessionId === expected, id);
  await page.waitForSelector('#message-input:not([disabled])');
}
async function fromPalette(page: Page) {
  await page.click('#command-btn');
  await page.getByText('Take from Herdr…', { exact: true }).click();
}
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
test('take routes through the existing picker, refuses busy/queued tabs, preserves human input and ignores a late snapshot after navigation', async () => {
  sessions = [original('one'), { ...original('two'), isStreaming: true }];
  commands.length = 0;
  snapshots.length = 0;
  context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('tau-active-live-session-id', 'two'));
  const page = await context.newPage();
  const observerContext = await browser.newContext({ serviceWorkers: 'block' });
  await observerContext.addInitScript(() => localStorage.setItem('tau-active-live-session-id', 'one'));
  const observer = await observerContext.newPage();
  await observer.goto(base);
  await active(observer, 'one');
  await observer.click('#file-sidebar-toggle');
  await observer.waitForFunction(() => document.getElementById('file-sidebar-path')?.textContent === '/test/one');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await active(page, 'two');
  await page.fill('#message-input', 'queued for two');
  await page.press('#message-input', 'Enter');
  await page.waitForSelector('.queued-msg');
  await page.fill('#message-input', 'human draft');
  await page.setInputFiles('#image-input', { name: 'keep.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.image-preview img');
  await page.getByRole('button', { name: 'Take from Herdr…', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent?.includes('queued messages'));
  assert.equal(commands.filter(item => item.type === 'prompt').length, 0);
  assert.equal(await page.locator('.queued-msg-text').textContent(), 'queued for two');

  // A linked idle tab with a paused browser queue must also be refused, not flushed.
  await page.click('.live-tab[data-session-id="one"]');
  await active(page, 'one');
  sessions[1].isStreaming = false;
  broadcast({ type: 'live_session_updated', session: sessions[1] });
  await page.evaluate(() => { location.hash = '#session=two'; });
  await active(page, 'two');
  await fromPalette(page);
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent?.includes('queued messages'));
  assert.equal(commands.filter(item => item.type === 'prompt').length, 0);
  assert.equal(await page.locator('.queued-msg').count(), 1);

  await page.click('.live-tab[data-session-id="one"]');
  await active(page, 'one');
  const before = snapshots.length;
  await fromPalette(page);
  await page.waitForSelector('.dialog-option');
  await settle(page);
  assert.equal(snapshots.length, before, 'early HTTP acknowledgement cannot refresh a still-open picker');
  broadcast({ type: 'live_session_snapshot', sessionId: 'one', ...snapshot(sessions[0]) });
  await settle(page);
  assert.equal(await page.inputValue('#message-input'), 'human draft');
  assert.equal(await page.locator('.image-preview').count(), 1);
  assert.equal(await page.locator('#send-btn').isDisabled(), true);
  assert.deepEqual(commands.filter(item => item.type === 'prompt').map(({ type, sessionId, message }) => ({ type, sessionId, message })), [{ type: 'prompt', sessionId: 'one', message: '/take herdr' }]);
  await page.locator('.dialog-option').click();
  await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('Restored Herdr answer'));
  await observer.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('Restored Herdr answer'));
  await observer.waitForFunction(() => document.getElementById('file-sidebar-path')?.textContent === '/herdr/project');
  assert.equal(await observer.locator('#model-input-label').textContent(), 'fixture/taken-model:high');
  assert.match(await observer.locator('.live-tab.active').getAttribute('title') || '', /\/herdr\/project/);
  assert.equal(snapshots.length, before, 'the authoritative broadcast updates both browsers without another snapshot request');
  assert.equal(await page.inputValue('#message-input'), 'human draft');
  assert.equal(await page.locator('.image-preview').count(), 1);
  assert.match(await page.locator('.live-tab.active').getAttribute('title') || '', /\/herdr\/project/);
  assert.equal(await page.locator('#model-input-label').textContent(), 'fixture/taken-model:high');
  await page.click('#file-sidebar-toggle');
  await page.waitForFunction(() => document.getElementById('file-sidebar-path')?.textContent === '/herdr/project');

  // A second completion can arrive after the user selects another tab. It must
  // update the taken tab, not steal the current view or submit its paused queue.
  delayCompletion = true;
  const held = new Promise<void>(resolve => { completionHeld = resolve; });
  await page.getByRole('button', { name: 'Take from Herdr…', exact: true }).click();
  await page.waitForSelector('.dialog-option');
  await page.locator('.dialog-option').click();
  await held;
  assert.ok(holdCompletion);
  await page.evaluate(() => { location.hash = '#session=two'; });
  await active(page, 'two');
  (holdCompletion as () => void)(); holdCompletion = null;
  delayCompletion = false;
  await settle(page);
  await active(page, 'two');
  assert.equal(await page.locator('.queued-msg').count(), 1);
  assert.equal(await page.inputValue('#message-input'), 'human draft');
  assert.equal(await page.locator('.image-preview').count(), 1);
  assert.equal(commands.filter(item => ['prompt', 'steer', 'follow_up'].includes(item.type)).length, 2, 'only the two explicit takeover commands were submitted');
  assert.deepEqual(errors, []);
  await observerContext.close();
  await context.close();
});

test('handled takeover failures remain visible after the authoritative snapshot redraw without fetching again', async () => {
  sessions = [original('one')];
  commands.length = 0;
  snapshots.length = 0;
  delayCompletion = false;
  context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('tau-active-live-session-id', 'one'));
  const page = await context.newPage();
  await page.goto(base);
  await active(page, 'one');
  await page.fill('#message-input', 'keep this draft');
  try {
    for (const failure of ['notify', 'extension'] as const) {
      takeFailure = failure;
      const before = snapshots.length;
      await page.getByRole('button', { name: 'Take from Herdr…', exact: true }).click();
      await page.waitForSelector('.dialog-option');
      await page.locator('.dialog-option').click();
      await page.waitForFunction(() => document.getElementById('take-herdr-btn')?.getAttribute('aria-busy') === 'false');
      assert.equal(snapshots.length, before, 'the authoritative snapshot replaces the conversation without a second fetch');
      await page.waitForFunction(() => document.getElementById('status-indicator')?.classList.contains('error'));
      assert.match(await page.locator('#status-text').textContent() || '', failure === 'notify' ? /source became busy/ : /source connection failed/);
      assert.equal(await page.inputValue('#message-input'), 'keep this draft');
      assert.match(await page.locator('#messages').textContent() || '', /Original one/);
      assert.equal(await page.locator('#send-btn').isDisabled(), false);
    }
    assert.equal(commands.filter(command => command.type === 'prompt').length, 2, 'neither failure submits the human draft or starts inference');
  } finally {
    takeFailure = null;
    await context.close();
  }
});

test('passive takeover snapshots preserve a read-only history view, but explicit live selection loads the replacement', async () => {
  sessions = [original('one')];
  commands.length = 0;
  snapshots.length = 0;
  historicalAvailable = true;
  delayCompletion = false;
  context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('tau-active-live-session-id', 'one'));
  const page = await context.newPage();
  try {
    await page.goto(base);
    await active(page, 'one');
    await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('Original one'));
    await page.fill('#message-input', 'leave this draft alone');
    await page.click('.project-header');
    await page.getByText('Owned history', { exact: true }).click();
    await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('Read-only: worker'));
    const history = await page.locator('#messages').textContent();
    assert.match(history || '', /Original history/);
    assert.equal(await page.locator('#message-input').isDisabled(), true);

    sessions[0] = { ...sessions[0], sessionFile: '/herdr/conversation.jsonl', cwd: '/herdr/project', sessionName: 'Taken conversation' };
    broadcast({ type: 'live_session_snapshot', sessionId: 'one', ...snapshot(sessions[0]) });
    // This later event is a barrier proving the preceding snapshot was handled.
    broadcast({ type: 'live_session_updated', session: sessions[0] });
    await page.waitForFunction(() => document.querySelector('.live-tab-title')?.textContent === 'Taken conversation');
    assert.equal(await page.locator('#messages').textContent(), history, 'the formerly selected live tab cannot replace followed history');
    assert.equal(await page.locator('#message-input').isDisabled(), true);
    assert.equal(await page.locator('#send-btn').isDisabled(), true);
    assert.equal(await page.inputValue('#message-input'), 'leave this draft alone');
    assert.equal(commands.filter(command => command.type === 'prompt').length, 0);

    await page.click('.live-tab[data-session-id="one"]');
    await active(page, 'one');
    await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('Restored Herdr answer'));
    assert.equal(await page.inputValue('#message-input'), 'leave this draft alone');
    assert.match(await page.locator('.live-tab.active').getAttribute('title') || '', /\/herdr\/project/);
  } finally {
    historicalAvailable = false;
    await context.close();
  }
});

