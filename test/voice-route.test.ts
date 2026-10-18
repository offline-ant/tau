import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

// The server reads its agent directory and credentials at load time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-voice-route-'));
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');
process.env.TAU_USER = 'voice-user';
process.env.TAU_PASS = 'voice-pass';
fs.mkdirSync(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });

const { server, _setAuthForTest } = (await import('../bin/tau.js')) as any;

let base = '';
let transcriptions = 0;
const local = http.createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    transcriptions++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ text: 'routed words' }));
  });
});

before(async () => {
  local.listen(0, '127.0.0.1');
  await once(local, 'listening');
  fs.writeFileSync(path.join(TMP, 'voice.json'), JSON.stringify({ backend: 'local', localUrl: `http://127.0.0.1:${(local.address() as AddressInfo).port}` }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `127.0.0.1:${server.address().port}`;
  _setAuthForTest(true);
});

after(() => {
  server.closeAllConnections();
  server.close();
  local.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function upgradeStatus(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws/voice`, { headers });
    ws.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('error', reject);
  });
}

const basic = `Basic ${Buffer.from('voice-user:voice-pass').toString('base64')}`;

test('voice route rejects foreign origins and missing authentication', async () => {
  assert.equal(await upgradeStatus({ Origin: 'http://evil.example', Authorization: basic }), 403);
  assert.equal(await upgradeStatus({ Origin: `http://${base}` }), 401);
  assert.equal(await upgradeStatus({ Origin: `http://${base}`, Authorization: `Basic ${Buffer.from('voice-user:wrong').toString('base64')}` }), 401);
});

test('authenticated same-origin voice recording reaches the configured backend', async () => {
  const ws = new WebSocket(`ws://${base}/ws/voice`, { headers: { Origin: `http://${base}`, Authorization: basic } });
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data))));
  const closed = once(ws, 'close');
  await once(ws, 'open');
  ws.send(Buffer.alloc(3200));
  ws.send(JSON.stringify({ type: 'stop' }));
  await closed;
  assert.deepEqual(messages, [{ type: 'ready', backend: 'local' }, { type: 'final', text: 'routed words' }]);
  assert.equal(transcriptions, 1);
});
