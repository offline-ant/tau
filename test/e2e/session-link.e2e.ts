import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebSocketServer, type WebSocket } from 'ws';

// Actual compiled UI with a read-only fake backend: no Pi subprocess, inference,
// user settings, or running Tau service. Uses installed Chromium when available.
const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
type Session = { id: string; cwd: string; sessionName: string; sessionFile: string; isStreaming: boolean };
const session = (id: string): Session => ({ id, cwd: '/test', sessionName: id, sessionFile: `/test/${id}.jsonl`, isStreaming: false });
let live: Session[] = [];
const requests: string[] = [];
const submitted: unknown[] = [];
let deferState = false;
let holdSnapshot: { id: string; resolve: () => void } | null = null;
let base = '';
let browser: Browser;
const sockets = new Set<WebSocket>();
const contexts = new Set<BrowserContext>();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://fixture');
  requests.push(`${req.method} ${url.pathname}`);
  const json = (data: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  if (url.pathname === '/api/live-sessions') return json({ sessions: live });
  const snapshot = /^\/api\/live-sessions\/(.+)\/snapshot$/.exec(url.pathname);
  if (snapshot) {
    const id = decodeURIComponent(snapshot[1]);
    if (holdSnapshot?.id === id) await new Promise<void>((resolve) => { holdSnapshot!.resolve = resolve; });
    const found = live.find(item => item.id === id);
    if (!found) { res.statusCode = 404; return json({ error: 'Missing test tab' }); }
    return json({ session: found, entries: [], isStreaming: found.isStreaming });
  }
  if (url.pathname === '/api/rpc') {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const command = JSON.parse(body) as { type: string };
    if (['prompt', 'steer', 'follow_up'].includes(command.type)) submitted.push(command);
    return json({ success: true, data: command.type === 'get_available_models' ? { models: [] } : {} });
  }
  if (url.pathname === '/api/health') return json({ platform: 'linux' });
  if (url.pathname === '/api/projects') return json({ projects: [] });
  if (url.pathname === '/api/sessions') return json({ projects: [] });
  if (url.pathname === '/api/files') return json({ items: [], path: '/test' });
  const file = path.resolve(publicDir, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  const type: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  res.setHeader('Content-Type', type[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', data => submitted.push(JSON.parse(String(data))));
  if (!deferState) socket.send(JSON.stringify({ type: 'state', liveSessions: live }));
});
function broadcast(data: unknown) { for (const socket of sockets) socket.send(JSON.stringify(data)); }

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY to run this focused browser test');
  browser = await chromium.launch({ executablePath });
});
after(async () => {
  for (const context of contexts) await context.close();
  await browser?.close();
  for (const socket of sockets) socket.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function open(hash: string, saved = 'one') {
  requests.length = 0;
  submitted.length = 0;
  const context = await browser.newContext({ serviceWorkers: 'block' });
  contexts.add(context);
  await context.addInitScript(id => {
    if (localStorage.getItem('tau-active-live-session-id') === null) {
      localStorage.setItem('tau-active-live-session-id', id);
    }
  }, saved);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/' + hash);
  return { page, errors, async close() { await context.close(); contexts.delete(context); } };
}
async function active(page: Page, id: string) {
  await page.waitForFunction(expected => document.querySelector<HTMLElement>('.live-tab.active')?.dataset.sessionId === expected, id);
  await page.waitForSelector('#message-input:not([disabled])');
}
async function settled(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
function assertReadOnly() {
  assert.equal(requests.some(request => request === 'POST /api/live-sessions' || request === 'POST /api/live-sessions/resume'), false);
  assert.deepEqual(submitted, []);
}

test('initial encoded link beats saved tab, preserves draft, and never submits work', async () => {
  const id = 'linked/plus+and&';
  live = [session('one'), session(id)];
  const view = await open(`#session=${encodeURIComponent(id)}`);
  try {
    await active(view.page, id);
    await view.page.fill('#message-input', 'human draft');
    await view.page.evaluate(() => { location.hash = '#session=one'; });
    await active(view.page, 'one');
    assert.equal(await view.page.inputValue('#message-input'), 'human draft');
    assertReadOnly();
    assert.deepEqual(view.errors, []);
  } finally { await view.close(); }
});

test('without a link the saved active tab is restored', async () => {
  live = [session('one'), session('two')];
  const view = await open('');
  try { await active(view.page, 'one'); assertReadOnly(); } finally { await view.close(); }
});

test('a consumed link preserves the query and reload restores a later user-selected tab', async () => {
  live = [session('one'), session('two')];
  const view = await open('?view=chat#session=one');
  try {
    await active(view.page, 'one');
    assert.equal(view.page.url(), `${base}/?view=chat`);
    await view.page.click('.live-tab[data-session-id="two"]');
    await active(view.page, 'two');
    await view.page.reload();
    await active(view.page, 'two');
    assert.equal(view.page.url(), `${base}/?view=chat`);
    assertReadOnly();
    assert.deepEqual(view.errors, []);
  } finally { await view.close(); }
});

for (const hash of ['#session=missing', '#session=%FF']) {
  test(`reload after consuming ${hash} restores the saved tab`, async () => {
    live = [session('one')];
    const view = await open(hash);
    try {
      await view.page.waitForFunction(() => /Invalid Tau session link|no longer live/.test(document.getElementById('status-text')?.textContent || ''));
      assert.equal(await view.page.locator('.live-tab.active').count(), 0);
      assert.equal(new URL(view.page.url()).hash, '');
      await view.page.reload();
      await active(view.page, 'one');
      assertReadOnly();
      assert.deepEqual(view.errors, []);
    } finally { await view.close(); }
  });
}

test('unrelated fragments survive initial restoration and later hash changes', async () => {
  live = [session('one')];
  const view = await open('#settings');
  try {
    await active(view.page, 'one');
    assert.equal(new URL(view.page.url()).hash, '#settings');
    await view.page.evaluate(() => { location.hash = '#other'; });
    await settled(view.page);
    assert.equal(new URL(view.page.url()).hash, '#other');
    await active(view.page, 'one');
    assertReadOnly();
  } finally { await view.close(); }
});

test('missing initial link does not select fallback or wait for a future matching id', async () => {
  live = [session('one')];
  const view = await open('#session=later');
  try {
    await view.page.waitForFunction(() => document.getElementById('status-text')?.textContent?.includes('no longer live'));
    assert.equal(await view.page.locator('.live-tab.active').count(), 0);
    const later = session('later'); live.push(later);
    broadcast({ type: 'live_session_created', session: later });
    await view.page.waitForSelector('.live-tab[data-session-id="later"]');
    broadcast({ type: 'state', liveSessions: live });
    await settled(view.page);
    assert.equal(await view.page.locator('.live-tab.active').count(), 0);
    assertReadOnly();
  } finally { await view.close(); }
});

test('hashchange selects newly created live tab but reconnect never reapplies consumed link', async () => {
  live = [session('one')];
  const view = await open('');
  try {
    await active(view.page, 'one');
    const later = session('later'); live.push(later);
    broadcast({ type: 'live_session_created', session: later });
    await view.page.waitForSelector('.live-tab[data-session-id="later"]');
    await view.page.evaluate(() => { location.hash = '#session=later'; });
    await active(view.page, 'later');
    assert.equal(new URL(view.page.url()).hash, '');
    await view.page.click('.live-tab[data-session-id="one"]');
    await active(view.page, 'one');
    broadcast({ type: 'state', liveSessions: live });
    await settled(view.page);
    await active(view.page, 'one');
    assertReadOnly();
    assert.deepEqual(view.errors, []);
  } finally { await view.close(); }
});

test('malformed and stale hash changes preserve the current tab and draft', async () => {
  live = [session('one')];
  const view = await open('');
  try {
    await active(view.page, 'one');
    await view.page.fill('#message-input', 'keep this');
    for (const hash of ['#session=%FF', '#session=missing']) {
      await view.page.evaluate(value => { location.hash = value; }, hash);
      await view.page.waitForFunction(() => /Invalid Tau session link|no longer live/.test(document.getElementById('status-text')?.textContent || ''));
      await active(view.page, 'one');
      assert.equal(new URL(view.page.url()).hash, '');
      assert.equal(await view.page.inputValue('#message-input'), 'keep this');
    }
    assertReadOnly();
  } finally { await view.close(); }
});

test('a pending link waits for initial server state and latest hash wins', async () => {
  live = [session('one'), session('two')];
  deferState = true;
  const view = await open('#session=one');
  try {
    await view.page.evaluate(() => { location.hash = '#session=two'; });
    await settled(view.page);
    broadcast({ type: 'state', liveSessions: live });
    await active(view.page, 'two');
    assertReadOnly();
  } finally { deferState = false; await view.close(); }
});

test('a slow linked snapshot cannot undo a later manual tab selection', async () => {
  live = [session('one'), session('two')];
  holdSnapshot = { id: 'two', resolve() {} };
  const view = await open('#session=two');
  try {
    await view.page.waitForFunction(() => document.querySelector<HTMLElement>('.live-tab.active')?.dataset.sessionId === 'two');
    await view.page.click('.live-tab[data-session-id="one"]');
    await active(view.page, 'one');
    holdSnapshot.resolve(); holdSnapshot = null;
    await settled(view.page);
    await active(view.page, 'one');
    assertReadOnly();
    assert.deepEqual(view.errors, []);
  } finally { holdSnapshot?.resolve(); holdSnapshot = null; await view.close(); }
});

test('hash navigation does not flush a tab\'s queued messages', async () => {
  const one = session('one'); one.isStreaming = true;
  live = [one, session('two')];
  const view = await open('');
  try {
    await active(view.page, 'one');
    await view.page.fill('#message-input', 'queued human input');
    await view.page.press('#message-input', 'Enter');
    await view.page.waitForSelector('.queued-msg');
    await view.page.click('.live-tab[data-session-id="two"]');
    await active(view.page, 'two');
    one.isStreaming = false;
    broadcast({ type: 'live_session_updated', session: one });
    await view.page.evaluate(() => { location.hash = '#session=one'; });
    await active(view.page, 'one');
    await settled(view.page);
    assertReadOnly();
    assert.equal(await view.page.locator('.queued-msg').count(), 1);
    broadcast({ type: 'state', liveSessions: live });
    await settled(view.page);
    assertReadOnly();
    assert.equal(await view.page.locator('.queued-msg').count(), 1);
  } finally { await view.close(); }
});
