import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import type { OpenTranscriber, Transcriber, TranscriberEvents } from 'pi-sound';
import { configuredTranscriber, handleVoiceSocket } from '../bin/voice.js';
import { Downsampler } from '../public/voice-input.js';

async function until(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

class FakeTranscriber implements Transcriber {
  audio: Buffer[] = [];
  closed = false;
  closeCount = 0;
  finishCount = 0;
  result: Promise<string> = Promise.resolve('final words');
  write(pcm: Buffer) { this.audio.push(pcm); }
  finish() { this.finishCount++; return this.result; }
  close() { this.closed = true; this.closeCount++; }
}

async function voiceSocket(t: TestContext, open: OpenTranscriber, limits = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const received: string[] = [];
  wss.on('connection', (socket) => {
    socket.on('message', (data, binary) => received.push(binary ? 'pcm' : String(data)));
    handleVoiceSocket(socket, open, limits);
  });
  const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  const messages: Array<Record<string, unknown>> = [];
  client.on('message', (data) => messages.push(JSON.parse(String(data))));
  const closed = once(client, 'close');
  await once(client, 'open');
  return { client, messages, received, closed, ready: () => until(() => messages.some((message) => message.type === 'ready')) };
}

test('voice socket: async readiness, partial previews, stop and one final transcript', async (t) => {
  const fake = new FakeTranscriber();
  let emit: TranscriberEvents | undefined;
  let signal: AbortSignal | undefined;
  const socket = await voiceSocket(t, async (handlers, abort) => {
    emit = handlers; signal = abort;
    return { backend: 'fake', transcriber: fake };
  });
  await socket.ready();
  socket.client.send(Buffer.from([1, 0, 2, 0]));
  emit!.partial('final');
  socket.client.send(JSON.stringify({ type: 'stop' }));
  await socket.closed;
  assert.deepEqual(socket.messages, [{ type: 'ready', backend: 'fake' }, { type: 'partial', text: 'final' }, { type: 'final', text: 'final words' }]);
  assert.deepEqual(fake.audio, [Buffer.from([1, 0, 2, 0])]);
  assert.equal(fake.closeCount, 1);
  assert.equal(signal?.aborted, true);
});

test('voice socket: maximum audio finalizes at complete samples and discards excess', async (t) => {
  const fake = new FakeTranscriber();
  const socket = await voiceSocket(t, async () => ({ backend: 'fake', transcriber: fake }), { maxSeconds: 0.001 });
  await socket.ready();
  socket.client.send(Buffer.alloc(64));
  await socket.closed;
  assert.deepEqual(socket.messages.at(-1), { type: 'final', text: 'final words', limited: true });
  assert.equal(Buffer.concat(fake.audio).length, 32);
  assert.equal(fake.finishCount, 1);
  assert.equal(fake.closeCount, 1);
});

test('voice socket: odd samples and oversized frames fail without backend writes', async (t) => {
  for (const [size, expected] of [[3, /whole 16-bit samples/], [65_538, /64 KiB limit/]] as const) {
    const fake = new FakeTranscriber();
    const socket = await voiceSocket(t, async () => ({ backend: 'fake', transcriber: fake }));
    await socket.ready();
    socket.client.send(Buffer.alloc(size));
    await socket.closed;
    assert.match(String(socket.messages.at(-1)?.message), expected);
    assert.deepEqual(fake.audio, []);
    assert.equal(fake.closeCount, 1);
  }
});

test('voice socket: silence closes the backend with one error', async (t) => {
  const fake = new FakeTranscriber();
  const socket = await voiceSocket(t, async () => ({ backend: 'fake', transcriber: fake }), { idleMs: 30 });
  await socket.closed;
  assert.match(String(socket.messages.at(-1)?.message), /No audio received/);
  assert.equal(fake.closeCount, 1);
  assert.equal(socket.messages.filter((message) => message.type === 'error').length, 1);
});

test('voice socket: opener rejection, thrown writes and rejected finishes release resources', async (t) => {
  const rejected = await voiceSocket(t, async () => { throw new Error('Invalid voice configuration x'); });
  await rejected.closed;
  assert.deepEqual(rejected.messages, [{ type: 'error', message: 'Invalid voice configuration x' }]);

  const writeFailed = new FakeTranscriber();
  writeFailed.write = () => { throw new Error('write failed'); };
  const writer = await voiceSocket(t, async () => ({ backend: 'fake', transcriber: writeFailed }));
  await writer.ready();
  writer.client.send(Buffer.alloc(2));
  await writer.closed;
  assert.deepEqual(writer.messages.at(-1), { type: 'error', message: 'write failed' });
  assert.equal(writeFailed.closeCount, 1);

  const failing = new FakeTranscriber();
  const result = deferred<string>();
  failing.result = result.promise;
  const finisher = await voiceSocket(t, async () => ({ backend: 'fake', transcriber: failing }));
  await finisher.ready();
  finisher.client.send(JSON.stringify({ type: 'stop' }));
  await until(() => failing.finishCount === 1);
  result.reject(new Error('backend down'));
  await finisher.closed;
  assert.deepEqual(finisher.messages.at(-1), { type: 'error', message: 'backend down' });
  assert.equal(failing.closeCount, 1);
});

test('voice socket: client disconnect cancels streaming and opening backends', async (t) => {
  const fake = new FakeTranscriber();
  let streamingSignal: AbortSignal | undefined;
  const streaming = await voiceSocket(t, async (_events, signal) => {
    streamingSignal = signal;
    return { backend: 'fake', transcriber: fake };
  });
  await streaming.ready();
  streaming.client.close();
  await streaming.closed;
  await until(() => fake.closed);
  assert.equal(streamingSignal?.aborted, true);
  assert.equal(fake.closeCount, 1);

  const opening = deferred<{ backend: string; transcriber: Transcriber }>();
  const late = new FakeTranscriber();
  let openingSignal: AbortSignal | undefined;
  const disconnected = await voiceSocket(t, (_events, signal) => { openingSignal = signal; return opening.promise; });
  disconnected.client.close();
  await disconnected.closed;
  await until(() => openingSignal?.aborted === true);
  opening.resolve({ backend: 'late', transcriber: late });
  await until(() => late.closed);
  assert.deepEqual(disconnected.messages, []);
  assert.equal(late.closeCount, 1);
});

test('voice socket: an opening backend times out, receives cancellation and releases a late transcriber', async (t) => {
  const opening = deferred<{ backend: string; transcriber: Transcriber }>();
  const fake = new FakeTranscriber();
  let signal: AbortSignal | undefined;
  const socket = await voiceSocket(t, (_events, abort) => { signal = abort; return opening.promise; }, { idleMs: 30 });
  await socket.closed;
  assert.deepEqual(socket.messages.map((message) => message.type), ['error']);
  assert.match(String(socket.messages[0].message), /did not become ready in time/);
  assert.equal(signal?.aborted, true);
  opening.resolve({ backend: 'fake', transcriber: fake });
  await until(() => fake.closed);
  assert.equal(fake.closeCount, 1);
});

test('voice socket: stop during opening waits for readiness and finalizes once without PCM', async (t) => {
  const opening = deferred<{ backend: string; transcriber: Transcriber }>();
  const fake = new FakeTranscriber();
  const socket = await voiceSocket(t, () => opening.promise);
  socket.client.send(JSON.stringify({ type: 'stop' }));
  socket.client.send(JSON.stringify({ type: 'stop' }));
  await until(() => socket.received.length === 2);
  assert.deepEqual(socket.messages, [], 'opening has not published readiness');
  opening.resolve({ backend: 'fake', transcriber: fake });
  await socket.closed;
  assert.deepEqual(socket.messages, [{ type: 'ready', backend: 'fake' }, { type: 'final', text: 'final words' }]);
  assert.equal(fake.finishCount, 1);
  assert.equal(fake.closeCount, 1);
  assert.deepEqual(fake.audio, []);
});

test('voice socket: PCM before ready fails explicitly and closes an eventually opened backend', async (t) => {
  const opening = deferred<{ backend: string; transcriber: Transcriber }>();
  const fake = new FakeTranscriber();
  let signal: AbortSignal | undefined;
  const socket = await voiceSocket(t, (_events, abort) => { signal = abort; return opening.promise; });
  socket.client.send(Buffer.alloc(2));
  await socket.closed;
  assert.deepEqual(socket.messages.map((message) => message.type), ['error']);
  assert.match(String(socket.messages[0].message), /before the speech backend was ready/);
  assert.equal(signal?.aborted, true);
  opening.resolve({ backend: 'fake', transcriber: fake });
  await until(() => fake.closed);
  assert.deepEqual(fake.audio, []);
});

test('voice socket: synchronous error callback before opener resolves never publishes ready or duplicate errors', async (t) => {
  const fake = new FakeTranscriber();
  let signal: AbortSignal | undefined;
  const socket = await voiceSocket(t, async (events, abort) => {
    signal = abort;
    events.error('opening failed');
    events.partial('not ready');
    return { backend: 'fake', transcriber: fake };
  });
  await socket.closed;
  assert.deepEqual(socket.messages, [{ type: 'error', message: 'opening failed' }]);
  assert.equal(signal?.aborted, true);
  assert.equal(fake.closeCount, 1);
});

test('voice socket: a backend error racing successful finish has exactly one terminal result', async (t) => {
  const fake = new FakeTranscriber();
  const result = deferred<string>();
  fake.result = result.promise;
  let events: TranscriberEvents | undefined;
  const socket = await voiceSocket(t, async (handlers) => { events = handlers; return { backend: 'fake', transcriber: fake }; });
  await socket.ready();
  socket.client.send(JSON.stringify({ type: 'stop' }));
  await until(() => fake.finishCount === 1);
  events!.error('late backend error');
  result.resolve('ambiguous result');
  await socket.closed;
  assert.deepEqual(socket.messages, [{ type: 'ready', backend: 'fake' }, { type: 'error', message: 'late backend error' }]);
  assert.equal(fake.closeCount, 1);
});

test('public voice configuration is disabled by default and reads no native credentials or capture/device settings', async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-voice-public-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const reads: string[] = [];
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    reads.push(String(args[0]));
    assert.equal(String(args[0]), path.join(agentDir, 'voice.json'), 'only explicit generic voice settings may be read');
    return original(...args);
  });
  const socket = await voiceSocket(t, configuredTranscriber(agentDir));
  await socket.closed;
  assert.deepEqual(socket.messages.map((message) => message.type), ['error']);
  assert.match(String(socket.messages[0].message), /disabled.*explicitly/);
  assert.deepEqual(reads, [path.join(agentDir, 'voice.json')]);
});

test('browser downsampler: 48 kHz and 44.1 kHz to 16 kHz, continuous across chunks', () => {
  const whole = new Downsampler(48000).push(new Float32Array(4800).fill(0.5));
  assert.equal(whole.length, 1600);
  assert.equal(whole[0], Math.trunc(0.5 * 0x7fff));
  assert.ok(whole.every((sample: number) => sample === whole[0]));
  const split = new Downsampler(44100);
  let total = 0;
  for (const size of [127, 128, 1000, 3155]) total += split.push(new Float32Array(size).fill(-1)).length;
  assert.equal(total, Math.floor(4410 / (44100 / 16000)));
  assert.equal(new Downsampler(44100).push(new Float32Array(441).fill(-1))[0], -0x8000);
});
