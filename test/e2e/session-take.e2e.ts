import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebSocketServer, type WebSocket } from 'ws';

// Real compiled UI and a synthetic loopback RPC surface. No Pi, discovery or providers.
const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
type Command = { type: string; id?: string; sessionId?: string; message?: string; value?: string; cancelled?: boolean };
type Picker = { id: string; method: 'select'; title: string; options: string[]; createdAt: number };
type Session = { id: string; cwd: string; sessionFile: string; leafId: string; sessionName: string; isStreaming: boolean;
  pendingInteractionCount: number; model: { provider: string; id: string }; thinkingLevel: string };
// Native sessions exercise ordered browser-local queues and the revisioned interaction registry.
const original = (id: string): Session => ({ id, cwd: `/test/${id}`, sessionFile: `/test/${id}.jsonl`, leafId: `${id}-leaf`,
  sessionName: id, isStreaming: false, pendingInteractionCount: 0, model: { provider: 'fixture', id: 'original' }, thinkingLevel: 'low' });
let sessions: Session[] = [];
const commands: Command[] = [], snapshots: string[] = [];
const sockets = new Set<WebSocket>();
const pickers = new Map<string, Picker[]>(), interactionRevisions = new Map<string, number>();
let pending: Command | null = null;
let holdCompletion: (() => void) | null = null;
let delayCompletion = false;
let completionHeld: (() => void) | null = null;
let deferPickerClosure = false;
let releasePickerClosure: (() => void) | null = null;
let takeFailure: 'notify' | 'extension' | null = null;
let historicalAvailable = false;
let takenLeaf = 0, barrierId = 0;
let base: string;
let browser: Browser;
let context: BrowserContext;
function broadcast(value: unknown) { for (const socket of sockets) socket.send(JSON.stringify(value)); }
function snapshot(session: Session) {
  return { session, sessionFile: session.sessionFile, model: session.model, thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming,
    pendingDialogs: pickers.get(session.id) || [], interactionRevision: interactionRevisions.get(session.id) || 0,
    entries: [{ type: 'message', id: session.leafId, message: { role: 'assistant', content: [{ type: 'text', text: session.sessionName === 'Taken conversation' ? 'Restored Herdr answer' : `Original ${session.id}` }] } }] };
}
function setPicker(sessionId: string, dialogs: Picker[]) {
  pickers.set(sessionId, dialogs);
  const interactionRevision = (interactionRevisions.get(sessionId) || 0) + 1;
  interactionRevisions.set(sessionId, interactionRevision);
  const session = sessions.find(item => item.id === sessionId)!;
  session.pendingInteractionCount = dialogs.length;
  broadcast({ type: 'live_session_updated', session });
  broadcast({ type: 'interaction_state', sessionId, pendingDialogs: dialogs, interactionRevision });
}
function completeTake(request: Command, answer: Command) {
  if (takeFailure) {
    const event = takeFailure === 'notify'
      ? { type: 'extension_ui_request', method: 'notify', notifyType: 'error', message: 'The source became busy before takeover.' }
      : { type: 'extension_error', error: 'The source connection failed before takeover.' };
    broadcast({ type: 'event', sessionId: request.sessionId, event });
  } else if (!answer.cancelled) {
    const index = sessions.findIndex(item => item.id === request.sessionId);
    sessions[index] = { ...sessions[index], cwd: '/herdr/project', sessionFile: '/herdr/conversation.jsonl', leafId: `taken-leaf-${++takenLeaf}`,
      sessionName: 'Taken conversation', model: { provider: 'fixture', id: 'taken-model' }, thinkingLevel: 'high' };
  }
  const current = sessions.find(session => session.id === request.sessionId)!;
  broadcast({ type: 'live_session_snapshot', sessionId: request.sessionId, ...snapshot(current) });
  broadcast({ type: 'live_session_updated', session: current });
  broadcast({ type: 'event', sessionId: request.sessionId, event: { type: 'response', command: 'prompt', id: request.id, success: true, data: { disposition: 'handled' } } });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://fixture');
  const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname === '/api/live-sessions') return json({ sessions });
  const match = /^\/api\/live-sessions\/(.+)\/snapshot$/.exec(url.pathname);
  if (match) {
    const id = decodeURIComponent(match[1]);
    snapshots.push(id);
    return json(snapshot(sessions.find(item => item.id === id)!));
  }
  if (url.pathname === '/api/rpc') {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const command = JSON.parse(body) as Command;
    commands.push(command);
    if (command.type === 'prompt') {
      assert.equal(command.message, '/take herdr', 'the fixture must never submit a human draft or paused local queue');
      assert.equal(pending, null, 'only one takeover picker is pending');
      pending = command;
      setPicker(command.sessionId!, [{ method: 'select', id: `take-picker-${command.id}`, title: 'Take from Herdr', options: ['Herdr: project'], createdAt: Date.now() }]);
      // The early HTTP acknowledgement is not the forwarded Pi prompt completion.
      return json({ type: 'response', command: 'prompt', id: command.id, success: true });
    }
    if (command.type === 'extension_ui_response') {
      assert.ok(pending, 'the registry still owns the picker being answered');
      const request = pending;
      assert.equal(command.sessionId, request.sessionId, 'the HTTP picker answer stays with its original tab');
      assert.equal(command.id, pickers.get(request.sessionId!)?.[0]?.id);
      assert.equal(command.value, 'Herdr: project');
      pending = null;
      const resolvePicker = () => {
        setPicker(request.sessionId!, []);
        if (delayCompletion) {
          holdCompletion = () => completeTake(request, command);
          completionHeld?.();
        } else completeTake(request, command);
      };
      if (deferPickerClosure) releasePickerClosure = resolvePicker;
      else resolvePicker();
      return json({ success: true });
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
  // Dialog responses use HTTP. No WebSocket input is expected in these guarded journeys.
  socket.on('message', data => {
    const command = JSON.parse(String(data)) as Command;
    commands.push(command);
    assert.equal(['prompt', 'steer', 'follow_up', 'extension_ui_response'].includes(command.type), false, 'no draft, queue or picker answer is submitted on the socket');
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
function reset(next: Session[]) {
  sessions = next; commands.length = 0; snapshots.length = 0;
  pickers.clear(); interactionRevisions.clear(); pending = null;
  delayCompletion = false; deferPickerClosure = false; holdCompletion = null;
  completionHeld = null; releasePickerClosure = null; takeFailure = null;
}
async function newContext(activeId: string) {
  const created = await browser.newContext({ serviceWorkers: 'block' });
  await created.addInitScript(id => {
    localStorage.setItem('tau-active-live-session-id', id);
    const handled: string[] = [];
    Object.assign(window, { takeFixtureHandled: handled });
    const NativeSocket = window.WebSocket;
    class ObservedSocket extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', event => {
          const marker = (JSON.parse(String(event.data)) as { testMarker?: string }).testMarker;
          // Runs after the app's synchronous onmessage handler, without replacing it.
          if (marker) queueMicrotask(() => handled.push(marker));
        });
      }
    }
    Object.defineProperty(window, 'WebSocket', { value: ObservedSocket });
  }, activeId);
  return created;
}
async function active(page: Page, id: string) {
  const marker = sessions.find(session => session.id === id)?.sessionName === 'Taken conversation' ? 'Restored Herdr answer' : `Original ${id}`;
  await page.waitForFunction(({ id, marker }) => document.querySelector<HTMLElement>('.live-tab.active')?.dataset.sessionId === id && document.getElementById('messages')?.textContent?.includes(marker), { id, marker });
  await page.waitForSelector('#message-input:not([disabled])');
}
async function fromPalette(page: Page) {
  await page.click('#command-btn');
  await page.getByText('Take from Herdr…', { exact: true }).click();
}
async function barrier(page: Page, sessionId: string) {
  const marker = `handled-${++barrierId}`;
  broadcast({ type: 'live_session_updated', session: sessions.find(session => session.id === sessionId), testMarker: marker });
  await page.waitForFunction(marker => (Reflect.get(window, 'takeFixtureHandled') as string[]).includes(marker), marker);
}
async function reuse(page: Page, file: string, expectedText: string, needsConfirmation: boolean) {
  const row = page.locator('#recovered-input .queued-msg').filter({ hasText: file });
  assert.equal(await row.count(), 1);
  if (needsConfirmation) {
    const question = page.waitForEvent('dialog');
    const clicked = row.getByRole('button', { name: 'Reuse', exact: true }).click();
    const dialog = await question;
    assert.equal(dialog.type(), 'confirm');
    assert.ok(dialog.message().includes(file));
    await dialog.accept(); await clicked;
  } else await row.getByRole('button', { name: 'Reuse', exact: true }).click();
  assert.equal(await page.inputValue('#message-input'), expectedText);
}
function assertRecovery(page: Page, file: string, leaf: string, text: string) {
  const row = page.locator('#recovered-input .queued-msg').filter({ hasText: file });
  return row.innerText().then(actual => { assert.ok(actual.includes(leaf)); assert.ok(actual.includes(text)); });
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
test('take routes through the HTTP picker, refuses busy/queued tabs, quarantines human input and ignores a late completion after navigation', async () => {
  reset([original('one'), { ...original('two'), isStreaming: true }]);
  context = await newContext('two');
  const page = await context.newPage();
  const observerContext = await newContext('one');
  const observer = await observerContext.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  observer.on('pageerror', error => errors.push(error.message));
  try {
    await observer.goto(base); await active(observer, 'one');
    await observer.click('#file-sidebar-toggle');
    await observer.waitForFunction(() => document.getElementById('file-sidebar-path')?.textContent === '/test/one');
    await page.goto(base); await active(page, 'two');
    await page.getByRole('button', { name: 'Take from Herdr…', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent?.includes('queued messages'));
    assert.equal(commands.filter(item => item.type === 'prompt').length, 0, 'a busy tab refuses Take even before input is queued');
    await page.fill('#message-input', 'queued for two');
    await page.press('#message-input', 'Enter');
    await page.waitForSelector('#queued-messages .queued-msg');
    await page.fill('#message-input', 'human draft for two');
    await page.setInputFiles('#image-input', { name: 'two.png', mimeType: 'image/png', buffer: png });
    await page.waitForSelector('#image-previews .image-preview img');
    await page.getByRole('button', { name: 'Take from Herdr…', exact: true }).click();
    assert.equal(commands.filter(item => item.type === 'prompt').length, 0);
    assert.equal(await page.locator('#queued-messages .queued-msg-text').textContent(), 'queued for two');

    // A linked idle tab with a paused browser queue is refused without flushing it.
    await page.click('.live-tab[data-session-id="one"]'); await active(page, 'one');
    assert.equal(await page.inputValue('#message-input'), '');
    assert.equal(await page.locator('#image-previews .image-preview').count(), 0);
    await assertRecovery(page, '/test/two.jsonl', 'two-leaf', 'human draft for two');
    sessions[1].isStreaming = false;
    await barrier(page, 'two');
    await page.evaluate(() => { location.hash = '#session=two'; }); await active(page, 'two');
    await fromPalette(page);
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent?.includes('queued messages'));
    assert.equal(commands.filter(item => item.type === 'prompt').length, 0);
    assert.equal(await page.locator('#queued-messages .queued-msg').count(), 1);

    await page.click('.live-tab[data-session-id="one"]'); await active(page, 'one');
    // This draft is created in the very conversation Take will replace.
    await page.fill('#message-input', 'human draft for one');
    await page.setInputFiles('#image-input', { name: 'one.png', mimeType: 'image/png', buffer: png });
    await page.waitForSelector('#image-previews .image-preview img');
    const before = snapshots.length;
    const earlyAck = page.waitForResponse(response => response.url().endsWith('/api/rpc') && response.request().postDataJSON().type === 'prompt');
    await fromPalette(page); await earlyAck;
    await page.waitForSelector('.dialog-option'); await observer.waitForSelector('.dialog-option');
    assert.equal(snapshots.length, before, 'early HTTP acknowledgement cannot refresh a still-open picker');
    assert.equal(await page.locator('#take-herdr-btn').getAttribute('aria-busy'), 'true');
    broadcast({ type: 'live_session_snapshot', sessionId: 'one', ...snapshot(sessions[0]) });
    await barrier(page, 'one');
    assert.equal(await page.inputValue('#message-input'), 'human draft for one', 'a same-context redraw keeps the current draft');
    assert.equal(await page.locator('#image-previews .image-preview').count(), 1);
    assert.equal(await page.locator('#send-btn').isDisabled(), true);
    assert.deepEqual(commands.filter(item => item.type === 'prompt').map(({ type, sessionId, message }) => ({ type, sessionId, message })), [{ type: 'prompt', sessionId: 'one', message: '/take herdr' }]);
    deferPickerClosure = true;
    await page.locator('.dialog-option').click();
    await page.getByRole('status', { name: '' }).filter({ hasText: 'Waiting for the server to confirm' }).waitFor();
    assert.ok(releasePickerClosure);
    assert.equal(await page.locator('.dialog-option').count(), 1, 'HTTP answer acknowledgement alone cannot dismiss the authoritative picker');
    assert.equal(await page.locator('#take-herdr-btn').getAttribute('aria-busy'), 'true');
    deferPickerClosure = false;
    releasePickerClosure(); releasePickerClosure = null;
    await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('Restored Herdr answer'));
    await observer.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('Restored Herdr answer'));
    assert.equal(await page.locator('.dialog-option').count(), 0);
    assert.equal(await observer.locator('.dialog-option').count(), 0);
    assert.equal(await observer.locator('#model-input-label').textContent(), 'fixture/taken-model:high');
    assert.match(await observer.locator('.live-tab.active').getAttribute('title') || '', /\/herdr\/project/);
    assert.equal(snapshots.length, before, 'both browsers update from the authoritative broadcast without another snapshot request');
    assert.equal(await page.inputValue('#message-input'), '');
    assert.equal(await page.locator('#image-previews .image-preview').count(), 0);
    await assertRecovery(page, '/test/one.jsonl', 'one-leaf', 'human draft for one');
    await assertRecovery(page, '/test/two.jsonl', 'two-leaf', 'human draft for two');
    assert.match(await page.locator('.live-tab.active').getAttribute('title') || '', /\/herdr\/project/);
    assert.equal(await page.locator('#model-input-label').textContent(), 'fixture/taken-model:high');
    await page.click('#file-sidebar-toggle');
    await page.waitForFunction(() => document.getElementById('file-sidebar-path')?.textContent === '/herdr/project');
    await reuse(page, '/test/one.jsonl', 'human draft for one', true);
    assert.equal(await page.locator('#image-previews .image-preview').count(), 1, 'explicit reuse restores the original image without submitting it');

    // A later completion updates its own tab, never the newer view or paused queue.
    delayCompletion = true;
    const held = new Promise<void>(resolve => { completionHeld = resolve; });
    await page.getByRole('button', { name: 'Take from Herdr…', exact: true }).click();
    await page.waitForSelector('.dialog-option');
    await page.locator('.dialog-option').click(); await held;
    assert.ok(holdCompletion);
    await page.evaluate(() => { location.hash = '#session=two'; }); await active(page, 'two');
    holdCompletion(); holdCompletion = null; delayCompletion = false;
    await barrier(page, 'one'); await active(page, 'two');
    assert.equal(await page.locator('#queued-messages .queued-msg').count(), 1);
    assert.equal(await page.inputValue('#message-input'), '');
    assert.equal(await page.locator('#image-previews .image-preview').count(), 0);
    await assertRecovery(page, '/test/two.jsonl', 'two-leaf', 'human draft for two');
    await assertRecovery(page, '/herdr/conversation.jsonl', 'taken-leaf-1', 'human draft for one');
    await reuse(page, '/test/two.jsonl', 'human draft for two', false);
    assert.equal(await page.locator('#image-previews .image-preview').count(), 1);
    assert.equal(await page.locator('#queued-messages .queued-msg').count(), 1, 'reuse does not submit the paused queue');
    assert.equal(commands.filter(item => ['prompt', 'steer', 'follow_up'].includes(item.type)).length, 2, 'only the two explicit takeover commands were submitted');
    assert.equal(commands.filter(item => item.type === 'extension_ui_response').length, 2, 'each picker was answered once through HTTP');
    await observer.waitForFunction(() => document.getElementById('file-sidebar-path')?.textContent === '/herdr/project');
    assert.deepEqual(errors, []);
  } finally { await observerContext.close(); await context.close(); }
});

test('handled takeover failures remain visible after the authoritative snapshot redraw without fetching again', async () => {
  reset([original('one')]);
  context = await newContext('one');
  const page = await context.newPage();
  await page.goto(base); await active(page, 'one');
  await page.fill('#message-input', 'keep this draft');
  try {
    for (const failure of ['notify', 'extension'] as const) {
      takeFailure = failure;
      const before = snapshots.length;
      await page.getByRole('button', { name: 'Take from Herdr…', exact: true }).click();
      await page.waitForSelector('.dialog-option'); await page.locator('.dialog-option').click();
      await page.waitForFunction(() => document.getElementById('take-herdr-btn')?.getAttribute('aria-busy') === 'false');
      assert.equal(snapshots.length, before, 'the authoritative snapshot redraws without a second fetch');
      await page.waitForFunction(() => document.getElementById('status-indicator')?.classList.contains('error'));
      assert.match(await page.locator('#status-text').textContent() || '', failure === 'notify' ? /source became busy/ : /source connection failed/);
      assert.equal(await page.inputValue('#message-input'), 'keep this draft', 'failed Take never changes the original file or leaf');
      assert.match(await page.locator('#messages').textContent() || '', /Original one/);
      assert.equal(await page.locator('#send-btn').isDisabled(), false);
      assert.equal(await page.locator('#recovered-input .queued-msg').count(), 0);
    }
    assert.equal(commands.filter(command => command.type === 'prompt').length, 2, 'neither failure submits the human draft or starts inference');
  } finally { takeFailure = null; await context.close(); }
});

test('passive takeover snapshots preserve read-only history and quarantine its earlier live draft until explicit reuse', async () => {
  reset([original('one')]); historicalAvailable = true;
  context = await newContext('one');
  const page = await context.newPage();
  try {
    await page.goto(base); await active(page, 'one');
    await page.fill('#message-input', 'leave this draft alone');
    await page.click('.project-header'); await page.getByText('Owned history', { exact: true }).click();
    await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('Read-only: worker'));
    const history = await page.locator('#messages').textContent();
    assert.match(history || '', /Original history/);
    assert.equal(await page.locator('#message-input').isDisabled(), true);
    assert.equal(await page.inputValue('#message-input'), '');
    await assertRecovery(page, '/test/one.jsonl', 'one-leaf', 'leave this draft alone');
    sessions[0] = { ...sessions[0], sessionFile: '/herdr/conversation.jsonl', leafId: 'taken-leaf', cwd: '/herdr/project', sessionName: 'Taken conversation' };
    broadcast({ type: 'live_session_snapshot', sessionId: 'one', ...snapshot(sessions[0]) });
    await barrier(page, 'one');
    assert.equal(await page.locator('#messages').textContent(), history, 'the old live tab cannot replace followed history');
    assert.equal(await page.locator('#message-input').isDisabled(), true);
    assert.equal(await page.locator('#send-btn').isDisabled(), true);
    assert.equal(await page.inputValue('#message-input'), '');
    await assertRecovery(page, '/test/one.jsonl', 'one-leaf', 'leave this draft alone');
    assert.equal(commands.filter(command => command.type === 'prompt').length, 0);
    await page.click('.live-tab[data-session-id="one"]'); await active(page, 'one');
    assert.equal(await page.inputValue('#message-input'), '');
    await assertRecovery(page, '/test/one.jsonl', 'one-leaf', 'leave this draft alone');
    await reuse(page, '/test/one.jsonl', 'leave this draft alone', true);
    assert.match(await page.locator('.live-tab.active').getAttribute('title') || '', /\/herdr\/project/);
    assert.equal(commands.filter(command => command.type === 'prompt').length, 0, 'explicit reuse edits the composer, never submits it');
  } finally { historicalAvailable = false; await context.close(); }
});
