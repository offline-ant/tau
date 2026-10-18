import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { DEFAULT_LOCAL_URL, claudeAccessToken, readVoiceConfig } from '../bin/voice-config.js';
import { claudeTranscriber, localTranscriber, wav } from '../bin/voice-backends.js';
import { handleVoiceSocket } from '../bin/voice.js';
import type { Transcriber, TranscriberEvents } from '../src/server/voice-backends.ts';
import type { OpenTranscriber } from '../src/server/voice.ts';

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-voice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function events() {
  const partials: string[] = [];
  const errors: string[] = [];
  const handlers: TranscriberEvents = { partial: (text) => partials.push(text), error: (message) => errors.push(message) };
  return { partials, errors, handlers };
}

async function until(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('voice config: missing selects claude, local defaults its URL, malformed is explicit', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'voice.json');
  assert.deepEqual(readVoiceConfig(dir), { backend: 'claude' });
  writeJson(file, { backend: 'local' });
  assert.deepEqual(readVoiceConfig(dir), { backend: 'local', localUrl: DEFAULT_LOCAL_URL });
  writeJson(file, { backend: 'local', localUrl: 'http://10.0.0.5:9000' });
  assert.deepEqual(readVoiceConfig(dir), { backend: 'local', localUrl: 'http://10.0.0.5:9000' });
  writeJson(file, { backend: 'claude', localUrl: 'http://10.0.0.5:9000' });
  assert.deepEqual(readVoiceConfig(dir), { backend: 'claude' });
  for (const bad of ['{', { backend: 'openai' }, { backend: 'local', extra: 1 }, { backend: 'local', localUrl: 'ftp://x' }, []]) {
    writeJson(file, bad);
    assert.throws(() => readVoiceConfig(dir), /voice configuration/);
  }
});

test('claude token: default account, native fallback, expired and missing logins', (t) => {
  const agentDir = tempDir(t);
  const home = tempDir(t);
  const second = tempDir(t);
  const now = 1_000_000;
  const login = (dir: string, token: string, expiresAt = now + 60_000) =>
    writeJson(path.join(dir, '.credentials.json'), { claudeAiOauth: { accessToken: token, expiresAt } });
  login(path.join(home, '.claude'), 'native-token');
  login(second, 'second-token');

  assert.equal(claudeAccessToken(agentDir, home, {}, now), 'native-token');
  assert.equal(claudeAccessToken(agentDir, home, { CLAUDE_CONFIG_DIR: second }, now), 'second-token');

  writeJson(path.join(agentDir, 'claude-agent', 'accounts.json'), { accounts: [{ id: 'original', configDir: null }, { id: 'second', configDir: second }] });
  assert.equal(claudeAccessToken(agentDir, home, {}, now), 'native-token');
  writeJson(path.join(agentDir, 'claude-agent', 'default-account.json'), { account: 'second' });
  assert.equal(claudeAccessToken(agentDir, home, {}, now), 'second-token');

  login(second, 'expired-token', now - 1);
  assert.throws(() => claudeAccessToken(agentDir, home, {}, now), (error: Error) =>
    /account "second" expired/.test(error.message) && /never refreshes/.test(error.message) && !error.message.includes('expired-token'));
  fs.rmSync(path.join(second, '.credentials.json'));
  assert.throws(() => claudeAccessToken(agentDir, home, {}, now), /No Claude login for account "second"/);
});

type FakeClaude = { url: string; requests: IncomingMessage[]; sockets: WebSocket[]; frames: Array<string | Buffer>[] };

async function fakeClaude(t: TestContext, onMessage: (socket: WebSocket, frame: string | Buffer) => void, status?: number): Promise<FakeClaude> {
  const server = http.createServer();
  const fake: FakeClaude = { url: '', requests: [], sockets: [], frames: [] };
  if (status) {
    server.on('upgrade', (request, socket) => {
      fake.requests.push(request);
      socket.end(`HTTP/1.1 ${status} Unauthorized\r\nContent-Length: 0\r\n\r\n`);
    });
  } else {
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket, request) => {
      fake.requests.push(request);
      fake.sockets.push(socket);
      const frames: Array<string | Buffer> = [];
      fake.frames.push(frames);
      socket.on('message', (data: Buffer, binary: boolean) => {
        const frame = binary ? Buffer.from(data) : data.toString();
        frames.push(frame);
        onMessage(socket, frame);
      });
    });
    t.after(() => wss.close());
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  fake.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws/speech_to_text/voice_stream`;
  return fake;
}

const say = (socket: WebSocket, type: string, data?: string) => socket.send(JSON.stringify(data === undefined ? { type } : { type, data }));

test('claude backend: headers, keepalive, audio, interim replacement and endpoint commit', async (t) => {
  const fake = await fakeClaude(t, (socket, frame) => {
    if (Buffer.isBuffer(frame) && frame.length === 4) {
      say(socket, 'TranscriptInterim', 'hel');
      say(socket, 'TranscriptText', 'hello there');
      say(socket, 'TranscriptEndpoint');
      say(socket, 'TranscriptInterim', 'second');
    }
    if (frame === '{"type":"CloseStream"}') {
      say(socket, 'TranscriptText', 'second part');
      say(socket, 'TranscriptEndpoint');
    }
  });
  const { partials, errors, handlers } = events();
  const transcriber = claudeTranscriber({ token: 'secret-token', url: fake.url }, handlers);
  transcriber.write(Buffer.from([1, 0, 2, 0])); // queued until the socket opens
  await until(() => partials.length === 3);
  assert.equal(await transcriber.finish(), 'hello there second part');
  assert.deepEqual(partials, ['hel', 'hello there', 'hello there second', 'hello there second part']);
  assert.deepEqual(errors, []);

  const request = fake.requests[0];
  assert.equal(request.headers.authorization, 'Bearer secret-token');
  assert.equal(request.headers['x-app'], 'cli');
  const query = new URL(request.url!, 'http://x').searchParams;
  assert.equal(query.get('encoding'), 'linear16');
  assert.equal(query.get('sample_rate'), '16000');
  assert.equal(query.get('language'), 'en');
  const frames = fake.frames[0];
  assert.equal(frames[0], '{"type":"KeepAlive"}');
  assert.deepEqual(frames[1], Buffer.from([1, 0, 2, 0]));
  assert.equal(frames.at(-1), '{"type":"CloseStream"}');
});

test('claude backend: finish promotes pending text when no endpoint arrives', async (t) => {
  const fake = await fakeClaude(t, (socket, frame) => {
    if (Buffer.isBuffer(frame)) say(socket, 'TranscriptInterim', 'unfinished');
  });
  const { partials, handlers } = events();
  const transcriber = claudeTranscriber({ token: 't', url: fake.url, noDataMs: 30 }, handlers);
  transcriber.write(Buffer.alloc(2));
  await until(() => partials.length === 1);
  assert.equal(await transcriber.finish(), 'unfinished');
});

test('claude backend: rejected login and transcription errors are reported', async (t) => {
  const rejected = await fakeClaude(t, () => {}, 401);
  const first = events();
  claudeTranscriber({ token: 't', url: rejected.url }, first.handlers);
  await until(() => first.errors.length > 0);
  assert.match(first.errors[0], /rejected the login \(HTTP 401\)/);

  const failing = await fakeClaude(t, (socket, frame) => {
    if (Buffer.isBuffer(frame)) socket.send(JSON.stringify({ type: 'TranscriptError', description: 'bad audio' }));
  });
  const second = events();
  const transcriber = claudeTranscriber({ token: 't', url: failing.url }, second.handlers);
  transcriber.write(Buffer.alloc(2));
  await until(() => second.errors.length > 0);
  assert.equal(second.errors.length, 1);
  assert.match(second.errors[0], /bad audio/);
  await assert.rejects(transcriber.finish(), /bad audio/);
});

test('local backend: posts one standard multipart WAV and returns its text', async (t) => {
  let body = Buffer.alloc(0);
  let contentType = '';
  let requestPath = '';
  let status = 200;
  const server = http.createServer(async (request, response) => {
    requestPath = request.url ?? '';
    contentType = request.headers['content-type'] ?? '';
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(status === 200 ? JSON.stringify({ text: ' hello local \n' }) : '{"error":"model missing"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const transcriber = localTranscriber({ url });
  transcriber.write(Buffer.from([1, 0]));
  transcriber.write(Buffer.from([2, 0]));
  assert.equal(await transcriber.finish(), 'hello local');
  assert.equal(requestPath, '/v1/audio/transcriptions');
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  const text = body.toString('latin1');
  assert.match(text, /name="file"; filename="recording.wav"/);
  assert.match(text, /name="model"\r\n\r\nwhisper-1/);
  assert.ok(body.includes(wav(Buffer.from([1, 0, 2, 0]))));

  assert.equal(await localTranscriber({ url }).finish(), '', 'empty recordings make no request');
  status = 500;
  const failing = localTranscriber({ url });
  failing.write(Buffer.alloc(2));
  await assert.rejects(failing.finish(), /HTTP 500.*model missing/);
  const unreachable = localTranscriber({ url: 'http://127.0.0.1:9' });
  unreachable.write(Buffer.alloc(2));
  await assert.rejects(unreachable.finish(), /unavailable/);
});

test('wav header describes 16 kHz mono 16-bit PCM', () => {
  const file = wav(Buffer.alloc(320));
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.readUInt32LE(24), 16000);
  assert.equal(file.readUInt16LE(22), 1);
  assert.equal(file.readUInt16LE(34), 16);
  assert.equal(file.readUInt32LE(40), 320);
});

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
