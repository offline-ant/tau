import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dictate } from '../bin/dictate.js';
import type { DictationMessage } from '../src/server/dictate.ts';
import type { Transcriber, TranscriberEvents } from '../src/server/voice-backends.ts';
import type { OpenTranscriber } from '../src/server/voice.ts';

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-dictate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A pi-mic socket that streams `audio` on every connection and records disconnects. */
async function microphone(t: TestContext, file: string, audio: Buffer[], keepOpen = true) {
  const state = { connections: 0, closed: 0 };
  const server = net.createServer((socket) => {
    state.connections++;
    socket.on('close', () => state.closed++);
    socket.on('error', () => {});
    for (const chunk of audio) socket.write(chunk);
    if (!keepOpen) socket.end();
  });
  server.listen(file);
  await once(server, 'listening');
  t.after(() => server.close());
  return state;
}

function fakeTranscriber(text = 'hello world') {
  const written: Buffer[] = [];
  let events: TranscriberEvents | null = null;
  let closed = false;
  const transcriber: Transcriber = {
    write(pcm) { written.push(pcm); events?.partial(`heard ${Buffer.concat(written).length}`); },
    finish: () => Promise.resolve(text),
    close() { closed = true; },
  };
  const open: OpenTranscriber = (handlers) => { events = handlers; return { backend: 'fake', transcriber }; };
  return { open, written, isClosed: () => closed };
}

async function until(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('dictate: newest live microphone wins; end of input stops and prints the transcript', async (t) => {
  const dir = tempDir(t);
  const older = await microphone(t, path.join(dir, 'voidpc.sock'), [Buffer.alloc(4)]);
  fs.utimesSync(path.join(dir, 'voidpc.sock'), new Date(1000), new Date(1000));
  const flip = await microphone(t, path.join(dir, 'void-flip.sock'), [Buffer.from([1, 2, 3]), Buffer.from([4, 5])]);
  fs.writeFileSync(path.join(dir, 'stale.sock'), ''); // not a socket: connection fails, skipped
  fs.utimesSync(path.join(dir, 'stale.sock'), new Date(), new Date(Date.now() + 60_000));
  const fake = fakeTranscriber();
  const input = new PassThrough();
  const messages: DictationMessage[] = [];
  const done = dictate({ micDir: dir, open: fake.open, input, emit: (message: DictationMessage) => messages.push(message) });
  await until(() => Buffer.concat(fake.written).length === 4);
  input.end();
  await done;
  assert.equal(older.connections, 0);
  await until(() => flip.closed === 1);
  // Odd chunk boundaries are rejoined into whole 16-bit samples; the trailing odd byte waits.
  assert.deepEqual([...Buffer.concat(fake.written)], [1, 2, 3, 4]);
  assert.deepEqual(messages[0], { type: 'ready', device: 'void-flip', backend: 'fake' });
  assert.ok(messages.some((message) => message.type === 'partial'));
  assert.deepEqual(messages.at(-1), { type: 'final', text: 'hello world' });
  assert.equal(fake.isClosed(), true);
});

test('dictate: no microphone, silent microphone, cancellation and the length limit', async (t) => {
  const dir = tempDir(t);
  let messages: DictationMessage[] = [];
  const emit = (message: DictationMessage) => messages.push(message);

  await dictate({ micDir: path.join(dir, 'missing'), open: fakeTranscriber().open, input: new PassThrough(), emit });
  assert.match(messages[0]?.type === 'error' ? messages[0].message : '', /No microphone connected.*pi-mic/);

  // A recorder that fails at once (nothing plugged in) closes the connection without audio.
  messages = [];
  await microphone(t, path.join(dir, 'empty.sock'), [], false);
  await dictate({ micDir: dir, open: fakeTranscriber().open, input: new PassThrough(), emit });
  const last = messages.at(-1);
  assert.equal(last?.type, 'error');
  assert.match(last?.type === 'error' ? last.message : '', /empty produced no audio/);
  fs.rmSync(path.join(dir, 'empty.sock'));

  messages = [];
  const mic = await microphone(t, path.join(dir, 'pc.sock'), [Buffer.alloc(2)]);
  const controller = new AbortController();
  const fake = fakeTranscriber();
  const cancelled = dictate({ micDir: dir, open: fake.open, input: new PassThrough(), emit, signal: controller.signal });
  await until(() => fake.written.length === 1);
  controller.abort();
  await cancelled;
  assert.deepEqual(messages.map((message) => message.type), ['ready', 'partial']);
  assert.equal(fake.isClosed(), true);
  await until(() => mic.closed === 1);

  messages = [];
  fs.rmSync(path.join(dir, 'pc.sock'));
  await microphone(t, path.join(dir, 'long.sock'), [Buffer.alloc(40_000)]);
  const limited = fakeTranscriber('long');
  await dictate({ micDir: dir, open: limited.open, input: new PassThrough(), emit, maxSeconds: 1 });
  assert.equal(Buffer.concat(limited.written).length, 32_000);
  assert.deepEqual(messages.at(-1), { type: 'final', text: 'long', limited: true });
});

test('tau-dictate CLI: reports a missing microphone as one JSON line', async (t) => {
  const dir = tempDir(t);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '../bin/dictate.js')], {
    env: { ...process.env, PI_MIC_DIR: path.join(dir, 'none'), PI_CODING_AGENT_DIR: dir },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (data) => { out += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  const lines = out.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'error');
});
