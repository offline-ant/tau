import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import type { OpenTranscriber, Transcriber, TranscriberEvents } from 'pi-sound';
import { handleVoiceSocket } from '../bin/voice.js';

async function until(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeTranscriber implements Transcriber {
  audio: Buffer[] = [];
  closed = false;
  result: Promise<string> = Promise.resolve('final words');
  write(pcm: Buffer) { this.audio.push(pcm); }
  finish() { return this.result; }
  close() { this.closed = true; }
}

async function voiceSocket(t: TestContext, open: OpenTranscriber, limits = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  wss.on('connection', (socket) => handleVoiceSocket(socket, open, limits));
  t.after(() => wss.close());
  const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
  const messages: Array<Record<string, unknown>> = [];
  client.on('message', (data) => messages.push(JSON.parse(String(data))));
  const closed = once(client, 'close');
  await once(client, 'open');
  return { client, messages, closed };
}

test('voice socket: ready, partial previews, stop and one final transcript', async (t) => {
  const fake = new FakeTranscriber();
  let emit: TranscriberEvents | undefined;
  const { client, messages, closed } = await voiceSocket(t, (handlers) => { emit = handlers; return { backend: 'fake', transcriber: fake }; });
  await until(() => messages.length === 1);
  client.send(Buffer.from([1, 0, 2, 0]));
  emit!.partial('final');
  client.send(JSON.stringify({ type: 'stop' }));
  await closed;
  assert.deepEqual(messages, [{ type: 'ready', backend: 'fake' }, { type: 'partial', text: 'final' }, { type: 'final', text: 'final words' }]);
  assert.deepEqual(fake.audio, [Buffer.from([1, 0, 2, 0])]);
  assert.equal(fake.closed, true);
});

test('voice socket: size limit finalizes, bad input and idle audio fail, errors are reported', async (t) => {
  const limited = new FakeTranscriber();
  const first = await voiceSocket(t, () => ({ backend: 'fake', transcriber: limited }), { maxSeconds: 0.001 });
  first.client.send(Buffer.alloc(64));
  await first.closed;
  assert.deepEqual(first.messages.at(-1), { type: 'final', text: 'final words', limited: true });
  assert.equal(Buffer.concat(limited.audio).length, 32, 'audio beyond the limit is dropped');

  const odd = await voiceSocket(t, () => ({ backend: 'fake', transcriber: new FakeTranscriber() }));
  odd.client.send(Buffer.alloc(3));
  await odd.closed;
  assert.match(String(odd.messages.at(-1)?.message), /whole 16-bit samples/);

  const idle = new FakeTranscriber();
  const silent = await voiceSocket(t, () => ({ backend: 'fake', transcriber: idle }), { idleMs: 30 });
  await silent.closed;
  assert.match(String(silent.messages.at(-1)?.message), /No audio received/);
  assert.equal(idle.closed, true);

  const misconfigured = await voiceSocket(t, () => { throw new Error('Invalid voice configuration x'); });
  await misconfigured.closed;
  assert.deepEqual(misconfigured.messages, [{ type: 'error', message: 'Invalid voice configuration x' }]);

  const failing = new FakeTranscriber();
  failing.result = Promise.reject(new Error('backend down'));
  failing.result.catch(() => {});
  const broken = await voiceSocket(t, () => ({ backend: 'fake', transcriber: failing }));
  broken.client.send(JSON.stringify({ type: 'stop' }));
  await broken.closed;
  assert.deepEqual(broken.messages.at(-1), { type: 'error', message: 'backend down' });
});

test('voice socket: client disconnect cancels the backend', async (t) => {
  const fake = new FakeTranscriber();
  const { client, messages } = await voiceSocket(t, () => ({ backend: 'fake', transcriber: fake }));
  await until(() => messages.length === 1);
  client.close();
  await until(() => fake.closed);
});

test('browser downsampler: 48 kHz and 44.1 kHz to 16 kHz, continuous across chunks', async () => {
  const { Downsampler } = await import('../public/voice-input.js');
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
