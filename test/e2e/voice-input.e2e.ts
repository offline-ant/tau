import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleVoiceSocket } from '../../bin/voice.js';
import type { TranscriberEvents } from '../../src/server/voice-backends.ts';

// Dictation in real Chromium with its fake microphone, against the compiled UI
// and Tau's real voice socket handler with a fake transcriber (no inference).
const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
const sessions = [
  { id: 'one', cwd: '/test', sessionName: 'One', sessionFile: '/test/one.jsonl', isStreaming: false },
  { id: 'two', cwd: '/test', sessionName: 'Two', sessionFile: '/test/two.jsonl', isStreaming: false },
];

type Recording = { bytes: number; finished: boolean; closed: boolean; events?: TranscriberEvents };
let recordings: Recording[] = [];
let prompts = 0;
let base = '';
let browser: Browser;
const sockets = new Set<WebSocket>();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://fixture');
  const json = (data: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  if (url.pathname === '/api/live-sessions') return json({ sessions });
  const snapshot = /^\/api\/live-sessions\/(\w+)\/snapshot$/.exec(url.pathname);
  if (snapshot) return json({ session: sessions.find(s => s.id === snapshot[1]), entries: [], isStreaming: false });
  if (url.pathname === '/api/rpc') {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (/"prompt"/.test(body)) prompts++;
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
const wss = new WebSocketServer({ noServer: true });
const voiceWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws/voice') {
    voiceWss.handleUpgrade(request, socket, head, ws => {
      sockets.add(ws);
      handleVoiceSocket(ws, (events: TranscriberEvents) => {
        const recording: Recording = { bytes: 0, finished: false, closed: false, events };
        recordings.push(recording);
        return {
          backend: 'fake',
          transcriber: {
            write(pcm: Buffer) { recording.bytes += pcm.length; if (recording.bytes >= 3200) events.partial('dictated'); },
            async finish() { recording.finished = true; return 'dictated words'; },
            close() { recording.closed = true; },
          },
        };
      });
    });
  } else if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, ws => {
      sockets.add(ws);
      ws.send(JSON.stringify({ type: 'state', liveSessions: sessions }));
    });
  } else socket.destroy();
});

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY to run this focused browser test');
  browser = await chromium.launch({
    executablePath,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--host-resolver-rules=MAP insecure.test 127.0.0.1'],
  });
});
after(async () => {
  await browser?.close();
  for (const socket of sockets) socket.terminate();
  await new Promise<void>(resolve => voiceWss.close(() => resolve()));
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => { recordings = []; prompts = 0; });

async function open(origin = base) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1000, height: 800 } });
  await context.addInitScript(() => {
    localStorage.setItem('tau-active-live-session-id', 'one');
    // Keep every captured stream reachable so the test can check its tracks ended.
    const streams: MediaStream[] = [];
    (window as unknown as { voiceStreams: MediaStream[] }).voiceStreams = streams;
    const original = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    if (original) navigator.mediaDevices.getUserMedia = async (constraints) => { const stream = await original(constraints); streams.push(stream); return stream; };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/');
  await page.waitForSelector('.live-tab.active');
  return { page, errors, close: () => context.close() };
}

const tracksEnded = (page: Page) => page.evaluate(() =>
  (window as unknown as { voiceStreams: MediaStream[] }).voiceStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));

async function until(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('dictation inserts the final transcript once at the cursor without submitting', async () => {
  const { page, errors, close } = await open();
  try {
    const input = page.locator('#message-input');
    await input.fill('Hello world');
    await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 5));
    await page.click('#mic-btn');
    await page.waitForSelector('#mic-btn.recording');
    await until(() => (recordings[0]?.bytes ?? 0) >= 6400);
    await page.waitForSelector('#voice-status >> text=Listening: dictated');
    assert.equal(await input.inputValue(), 'Hello world', 'partial text is previewed, not inserted');
    await page.click('#mic-btn');
    await page.waitForFunction(() => (document.getElementById('message-input') as HTMLTextAreaElement).value !== 'Hello world');
    assert.equal(await input.inputValue(), 'Hello dictated words world');
    assert.equal(recordings.length, 1);
    assert.equal(recordings[0].finished, true);
    await until(() => recordings[0].closed);
    assert.equal(await page.locator('#mic-btn.recording, #mic-btn.transcribing').count(), 0);
    assert.equal(await tracksEnded(page), true);
    assert.equal(prompts, 0);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('switching sessions cancels dictation and leaves the draft unchanged', async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator('#message-input').fill('draft');
    await page.click('#mic-btn');
    await until(() => (recordings[0]?.bytes ?? 0) > 0);
    await page.click('.live-tab[data-session-id="two"]');
    await until(() => recordings[0].closed);
    assert.equal(recordings[0].finished, false);
    await page.waitForFunction(() => !document.getElementById('mic-btn')!.classList.contains('recording'));
    assert.equal(await tracksEnded(page), true);
    assert.equal(await page.locator('#message-input').inputValue(), 'draft');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('insecure origins explain that voice input needs HTTPS', async () => {
  const { page, close } = await open(base.replace('127.0.0.1', 'insecure.test'));
  try {
    await page.waitForSelector('#mic-btn.unavailable');
    await page.click('#mic-btn');
    await page.waitForSelector('#voice-status.error >> text=Voice input needs HTTPS');
    assert.equal(recordings.length, 0);
  } finally { await close(); }
});
