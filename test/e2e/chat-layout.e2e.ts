import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import { WebSocketServer, type WebSocket } from 'ws';

// Chat bubble layout and the mobile fullscreen default, against the compiled
// UI with a read-only fake backend (no Pi subprocess or inference). Set
// TAU_E2E_SCREENSHOTS=<dir> to also save screenshots of the layouts.
const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
const screenshots = process.env.TAU_E2E_SCREENSHOTS;
const session = { id: 'chat', cwd: '/test', sessionName: 'Chat', sessionFile: '/test/chat.jsonl', isStreaming: false };
const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'message', message: { role, content, ...extra } });
const entries = [
  message('user', 'Can you check the **build** and explain the failure?'),
  message('assistant', [
    { type: 'thinking', thinking: 'The user wants the build checked first.' },
    { type: 'text', text: 'Running the build now.' },
    { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'npm run check' } },
  ]),
  message('toolResult', [{ type: 'text', text: 'error TS2322: Type string is not assignable to number.' }], { toolCallId: 'tool-1' }),
  message('assistant', [{ type: 'text', text: [
    'The check fails in `src/count.ts`:',
    '',
    '```ts',
    'const total: number = input.value;',
    '```',
    '',
    '- `input.value` is a string',
    '- parse it first, e.g. $n = \\lfloor x \\rfloor$',
  ].join('\n') }], { usage: { input: 10, cost: { total: 0.0123 } } }),
  message('user', 'ok'),
  message('assistant', [{ type: 'text', text: 'Fixed.' }]),
];

let base = '';
let browser: Browser;
const sockets = new Set<WebSocket>();
const contexts = new Set<BrowserContext>();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://fixture');
  const json = (data: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  if (url.pathname === '/api/live-sessions') return json({ sessions: [session] });
  if (url.pathname === `/api/live-sessions/${session.id}/snapshot`) return json({ session, entries, isStreaming: false });
  if (url.pathname === '/api/rpc') {
    for await (const _chunk of req) { /* drain */ }
    return json({ success: true, data: {} });
  }
  if (url.pathname === '/api/health') return json({ platform: 'linux' });
  if (url.pathname === '/api/projects' || url.pathname === '/api/sessions') return json({ projects: [] });
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
  socket.send(JSON.stringify({ type: 'state', liveSessions: [session] }));
});

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY to run this focused browser test');
  browser = await chromium.launch({ executablePath });
  if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
});
after(async () => {
  for (const context of contexts) await context.close();
  await browser?.close();
  for (const socket of sockets) socket.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const mobile: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const desktop: BrowserContextOptions = { viewport: { width: 1100, height: 800 } };

async function open(options: BrowserContextOptions, theme?: string) {
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
  contexts.add(context);
  await context.addInitScript(saved => {
    localStorage.setItem('tau-active-live-session-id', 'chat');
    if (saved && localStorage.getItem('tau-theme') === null) localStorage.setItem('tau-theme', saved);
  }, theme ?? '');
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/');
  await page.waitForSelector('.message.assistant >> text=Fixed.');
  await page.waitForSelector('.tool-card');
  return { page, errors, async close() { await context.close(); contexts.delete(context); } };
}

async function bubbles(page: Page) {
  return page.evaluate(() => {
    const container = document.getElementById('messages')!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('.message')].map(element => {
      const content = element.querySelector('.message-content')!;
      const box = content.getBoundingClientRect();
      const row = element.getBoundingClientRect();
      const tail = getComputedStyle(content, '::before');
      return {
        role: element.classList.contains('user') ? 'user' : 'assistant',
        left: box.left - container.left,
        right: container.right - box.right,
        background: getComputedStyle(content).backgroundColor,
        tail: tail.content !== 'none' ? tail.backgroundColor : null,
        tailSide: tail.content !== 'none' ? (tail.left.startsWith('-') ? 'left' : 'right') : null,
        // History rows use content-visibility, which clips paint to the row.
        tailRoom: element.classList.contains('user') ? row.right - box.right : box.left - row.left,
        tailWidth: parseFloat(tail.width),
      };
    });
  });
}

for (const [name, options] of [['desktop', desktop], ['mobile', mobile]] as const) {
  for (const theme of ['night', 'clean']) {
    test(`${name} ${theme}: user bubbles sit right with a right tail, agent bubbles left with a left tail`, async () => {
      const view = await open(options, theme);
      try {
        if (screenshots) await view.page.screenshot({ path: path.join(screenshots, `chat-${name}-${theme}.png`) });
        const found = await bubbles(view.page);
        assert.deepEqual(found.map(bubble => bubble.role), ['user', 'assistant', 'assistant', 'user', 'assistant']);
        for (const bubble of found) {
          assert.notEqual(bubble.background, 'rgba(0, 0, 0, 0)', `${bubble.role} bubble has a background`);
          assert.equal(bubble.tail, bubble.background, `${bubble.role} tail matches its bubble`);
          assert.equal(bubble.tailSide, bubble.role === 'user' ? 'right' : 'left');
          assert.ok(bubble.tailRoom >= bubble.tailWidth, `${bubble.role} tail fits inside its row`);
          if (bubble.role === 'user') assert.ok(bubble.right < bubble.left, 'user bubble is right-aligned');
          else assert.ok(bubble.left < bubble.right, 'agent bubble is left-aligned');
        }
        assert.deepEqual(view.errors, []);
      } finally { await view.close(); }
    });
  }
}

test('thinking-only agent bubbles disappear when thinking is hidden', async () => {
  const view = await open(desktop);
  try {
    await view.page.evaluate(() => {
      const messages = document.getElementById('messages')!;
      const only = document.createElement('div');
      only.className = 'message assistant thinking-only-probe';
      only.innerHTML = '<div class="message-content"><div class="thinking-block">t</div></div>';
      messages.appendChild(only);
      document.body.classList.add('hide-thinking');
    });
    assert.equal(await view.page.isVisible('.thinking-only-probe'), false);
    assert.equal(await view.page.isVisible('.message.assistant >> text=Fixed.'), true);
  } finally { await view.close(); }
});

async function fullscreen(page: Page) {
  return page.evaluate(() => Boolean(document.fullscreenElement));
}
async function toggle(page: Page) {
  return page.evaluate(() => document.getElementById('toggle-fullscreen')!.classList.contains('on'));
}

test('mobile defaults to fullscreen on the first tap and remembers turning it off', async () => {
  const view = await open(mobile);
  try {
    assert.equal(await toggle(view.page), true);
    assert.equal(await fullscreen(view.page), false);
    await view.page.tap('#messages');
    await view.page.waitForFunction(() => Boolean(document.fullscreenElement));
    await view.page.tap('#settings-btn');
    await view.page.tap('#toggle-fullscreen');
    await view.page.waitForFunction(() => !document.fullscreenElement);
    assert.equal(await toggle(view.page), false);
    await view.page.reload();
    await view.page.waitForSelector('.message.assistant >> text=Fixed.');
    assert.equal(await toggle(view.page), false);
    await view.page.tap('#messages');
    assert.equal(await fullscreen(view.page), false);
    assert.deepEqual(view.errors, []);
  } finally { await view.close(); }
});

test('desktop keeps fullscreen off by default', async () => {
  const view = await open(desktop);
  try {
    assert.equal(await toggle(view.page), false);
    await view.page.click('#messages');
    assert.equal(await fullscreen(view.page), false);
  } finally { await view.close(); }
});
