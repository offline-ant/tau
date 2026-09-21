import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Loopback host so computeUrls() sets a localhost lanUrl; isolate settings.
process.env.TAU_HOST = '127.0.0.1';
// Isolate the orchestration registry under os.tmpdir(): these cases write
// session-owner records and must never touch a real one on this machine.
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-http-tmp-'));
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-http-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
// Configure a projects dir so /api/projects has something to list.
const PROJECTS_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'projects');
process.env.TAU_PROJECTS_DIR = PROJECTS_DIR;
// These routes are exercised unauthenticated; this fork configures default
// credentials, so opt out explicitly with empty values.
process.env.TAU_USER = '';
process.env.TAU_PASS = '';

// Load the server after the env is in place: the module reads it at load
// time, and ESM hoists static imports ahead of this body.
const { server, computeUrls, liveManager, SESSIONS_DIR, _setSpawnPiForTest } = (await import('../bin/tau.js')) as any;
import type { TestContext } from 'node:test';

let base = '';

const PROJ_DIR = path.join(SESSIONS_DIR, '--tmp--httpproj');
const SESSION_FILE = path.join(PROJ_DIR, 's.jsonl');

function writeSessionFileAt(projectDir: string, fileName: string, lines: Array<Record<string, unknown>>) {
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, fileName);
  fs.writeFileSync(filePath, lines.map((l: Record<string, unknown>) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

function writeSessionFile(lines: Array<Record<string, unknown>>) {
  writeSessionFileAt(PROJ_DIR, 's.jsonl', lines);
}

interface FakeHttpSession {
  id: string;
  cwd: string;
  model: string;
  modelSpec: string;
  thinkingLevel: string;
  isStreaming: boolean;
  sessionFile: string;
  sessionName: string | null;
  contextUsage: { tokens?: number; usage?: { input_tokens: number; output_tokens: number } } | null;
  metadata: () => { id: string; cwd: string; model: string; isStreaming: boolean; sessionFile: string };
  snapshot: () => { session: { id: string }; entries: unknown[]; model: string; isStreaming: boolean; sessionFile: string };
  terminate: () => Promise<void>;
}

function fakeSession(id: string): FakeHttpSession {
  return {
    id,
    cwd: '/tmp/proj',
    model: 'openai/gpt-5.5',
    modelSpec: '',
    thinkingLevel: 'off',
    isStreaming: false,
    sessionFile: `/tmp/${id}.jsonl`,
    sessionName: null,
    contextUsage: null,
    metadata: () => ({ id, cwd: '/tmp/proj', model: 'openai/gpt-5.5', isStreaming: false, sessionFile: `/tmp/${id}.jsonl` }),
    snapshot: () => ({ session: { id }, entries: [], model: 'openai/gpt-5.5', isStreaming: false, sessionFile: `/tmp/${id}.jsonl` }),
    terminate: async () => {},
  };
}

// A realistic fake `pi` child: real streams so start()'s setEncoding/on('data')
// wiring works, and an EventEmitter so on('error')/on('exit') resolve startup.
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.kill = (sig: string) => { child.killedSignal = sig; };
  return child;
}

before(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      computeUrls(port);
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  liveManager.sessions.clear();
});

async function jsonBody(res: Response) {
  return JSON.parse(await res.text());
}

test('GET /api/health reports server health and live session count', async () => {
  liveManager.sessions.set('tau_1', fakeSession('tau_1'));
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.status, 'ok');
  assert.equal(body.role, 'rpc-session-manager');
  assert.equal(body.liveSessionCount, 1);
  assert.match(body.lanUrl, /^http:\/\/localhost:\d+$/);
});

test('GET /api/live-sessions lists managed sessions', async () => {
  liveManager.sessions.set('tau_1', fakeSession('tau_1'));
  const res = await fetch(`${base}/api/live-sessions`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].id, 'tau_1');
});

test('POST /api/live-sessions requires cwd', async () => {
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = await jsonBody(res);
  assert.match(body.error, /cwd required/);
});

test('GET /api/live-sessions/:id/snapshot returns 404 for missing session', async () => {
  const res = await fetch(`${base}/api/live-sessions/tau_missing/snapshot`);
  assert.equal(res.status, 404);
});

test('GET /api/live-sessions/:id/snapshot returns snapshot for a live session', async () => {
  liveManager.sessions.set('tau_1', fakeSession('tau_1'));
  const res = await fetch(`${base}/api/live-sessions/tau_1/snapshot`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.session.id, 'tau_1');
  assert.deepEqual(body.entries, []);
});

test('DELETE /api/live-sessions/:id terminates and returns 200', async () => {
  const s = fakeSession('tau_1');
  let terminated = false;
  s.terminate = async () => { terminated = true; };
  liveManager.sessions.set('tau_1', s);
  const res = await fetch(`${base}/api/live-sessions/tau_1`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.success, true);
  assert.equal(terminated, true);
  assert.equal(liveManager.sessions.has('tau_1'), false);
});

test('DELETE /api/live-sessions/:id returns 404 for missing session', async () => {
  const res = await fetch(`${base}/api/live-sessions/tau_missing`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('DELETE /api/live-sessions/:id/snapshot is not a termination route and falls through', async () => {
  const s = fakeSession('tau_1');
  let terminated = false;
  s.terminate = async () => { terminated = true; };
  liveManager.sessions.set('tau_1', s);
  const res = await fetch(`${base}/api/live-sessions/tau_1/snapshot`, { method: 'DELETE' });
  // snapshot subroute has no DELETE handler -> falls through to 404
  assert.equal(res.status, 404);
  assert.equal(terminated, false, 'snapshot DELETE must not terminate the child');
  assert.equal(liveManager.sessions.has('tau_1'), true);
});

test('GET /api/files without sessionId is rejected with 400', async () => {
  const res = await fetch(`${base}/api/files`);
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /No live session selected/);
});

test('GET /api/file/preview without sessionId is rejected with 400', async () => {
  const res = await fetch(`${base}/api/file/preview?path=/x.png`);
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /No live session selected/);
});

test('malformed static URL returns 400 instead of crashing the server', async () => {
  const res = await fetch(`${base}/%E0%A4%A`);
  assert.equal(res.status, 400);
  // server stays up for subsequent requests
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
});

test('malformed live-session id returns 400 instead of crashing the server', async () => {
  const res = await fetch(`${base}/api/live-sessions/%E0%A4%A`);
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /Malformed live session id/);
  // server stays up
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
});

test('cross-origin API preflight is rejected with 403 and no CORS headers', async () => {
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://evil.example', Host: new URL(base).host, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(res.status, 403);
  // a rejected origin must not get an Access-Control-Allow-Origin header
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('same-origin API preflight is allowed with 200 and full CORS headers', async () => {
  const host = new URL(base).host;
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'OPTIONS',
    headers: { Origin: base, Host: host, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), base);
  assert.equal(res.headers.get('vary'), 'Origin');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, DELETE, OPTIONS');
  assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type');
});

test('cross-origin POST is rejected with 403', async () => {
  const res = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', Host: new URL(base).host },
    body: JSON.stringify({ type: 'get_auth' }),
  });
  assert.equal(res.status, 403);
});

test('same-origin POST /api/rpc proxies to handleRpcCommand', async () => {
  const host = new URL(base).host;
  const res = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: host },
    body: JSON.stringify({ type: 'get_auth' }),
  });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.success, true);
  assert.equal(body.data.configured, false);
});

test('GET /api/sessions returns an empty project list when no sessions exist', async () => {
  const res = await fetch(`${base}/api/sessions`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.deepEqual(body.projects, []);
});

test('POST /api/sessions/delete removes the session file from disk', async () => {
  writeSessionFile([{ type: 'session', id: 's' }]);
  assert.equal(fs.existsSync(SESSION_FILE), true);
  const res = await fetch(`${base}/api/sessions/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: SESSION_FILE }),
  });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.success, true);
  assert.equal(fs.existsSync(SESSION_FILE), false);
});

test('POST /api/sessions/delete rejects an invalid filePath with 400', async () => {
  const res = await fetch(`${base}/api/sessions/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: '/etc/hosts' }),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /Invalid session file/);
});

test('POST /api/sessions/delete rejects a missing filePath with 400', async () => {
  const res = await fetch(`${base}/api/sessions/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /filePath required/);
});

test('POST /api/sessions/switch is no longer a supported API', async () => {
  const res = await fetch(`${base}/api/sessions/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 404);
  const body = await jsonBody(res);
  assert.equal(body.error, 'Not found');
});

test('GET /api/sessions/:project/:file streams the parsed session entries', async () => {
  writeSessionFile([{ type: 'session', id: 's' }, { type: 'message', message: { role: 'user', content: 'hi' } }]);
  const res = await fetch(`${base}/api/sessions/--tmp--httpproj/s.jsonl`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.entries.length, 2);
  assert.equal(body.entries[0].type, 'session');
});

test('GET /api/sessions/:project/:file returns 404 for a missing file', async () => {
  const res = await fetch(`${base}/api/sessions/--tmp--httpproj/nope.jsonl`);
  assert.equal(res.status, 404);
});

test('GET /api/sessions/:project/:file reads only what was appended since a byte offset', async () => {
  writeSessionFile([{ type: 'session', id: 'tail' }, { type: 'message', message: { role: 'user', content: 'first' } }]);
  const initial = await jsonBody(await fetch(`${base}/api/sessions/--tmp--httpproj/s.jsonl`));
  assert.equal(initial.entries.length, 2);
  assert.equal(initial.offset, fs.statSync(SESSION_FILE).size);
  assert.equal(initial.reset, false);

  const empty = await jsonBody(await fetch(`${base}/api/sessions/--tmp--httpproj/s.jsonl?since=${initial.offset}`));
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.offset, initial.offset);

  fs.appendFileSync(SESSION_FILE, `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'second' } })}\n`);
  const appended = await jsonBody(await fetch(`${base}/api/sessions/--tmp--httpproj/s.jsonl?since=${initial.offset}`));
  assert.equal(appended.entries.length, 1);
  assert.equal(appended.entries[0].message.content, 'second');
  assert.equal(appended.offset, fs.statSync(SESSION_FILE).size);

  // A partial final line is left for the next read, so entries never split.
  fs.appendFileSync(SESSION_FILE, '{"type":"message"');
  const partial = await jsonBody(await fetch(`${base}/api/sessions/--tmp--httpproj/s.jsonl?since=${appended.offset}`));
  assert.deepEqual(partial.entries, []);
  assert.equal(partial.offset, appended.offset);

  // A rewritten (shorter) file answers from the start rather than mid-record.
  writeSessionFile([{ type: 'session', id: 'tail' }]);
  const rewritten = await jsonBody(await fetch(`${base}/api/sessions/--tmp--httpproj/s.jsonl?since=${appended.offset}`));
  assert.equal(rewritten.reset, true);
  assert.equal(rewritten.entries.length, 1);

  const invalid = await fetch(`${base}/api/sessions/--tmp--httpproj/s.jsonl?since=-1`);
  assert.equal(invalid.status, 400);
});

test('a session owned by an orchestration worker is listed as owned and is not resumed by default', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-owned-'));
  writeSessionFileAt(PROJ_DIR, 'owned.jsonl', [
    { type: 'session', id: 'owned-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd },
    { type: 'message', message: { role: 'user', content: 'worker task' } },
    { type: 'message', message: { role: 'assistant', content: 'working' } },
    // Two user messages: the listing skips sessions that never got going.
    { type: 'message', message: { role: 'user', content: 'continue' } },
  ]);
  const sessionFile = path.join(PROJ_DIR, 'owned.jsonl');
  const registry = path.join(os.tmpdir(), 'pi-orchestration-targets');
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, 'delegate-7.json'),
    JSON.stringify({ target: { host: 'tmux', name: 'delegate-7', id: '%3', kind: 'pi', sessionFile } }));
  // A session this server hosts is a live tab here, not somebody else's.
  fs.writeFileSync(path.join(registry, 'web-worker.json'),
    JSON.stringify({ target: { host: 'web', name: 'web-worker', id: 'tau_9', kind: 'pi', sessionFile: path.join(PROJ_DIR, 'resume.jsonl') } }));
  t.after(() => fs.rmSync(registry, { recursive: true, force: true }));

  const listing = await jsonBody(await fetch(`${base}/api/sessions/--tmp--httpproj`));
  const sessions = listing.sessions;
  const owned = sessions.find((entry: { file?: string }) => entry.file === 'owned.jsonl');
  assert.deepEqual(owned.owner, { name: 'delegate-7', host: 'tmux' });
  for (const entry of sessions.filter((item: { file?: string }) => item.file !== 'owned.jsonl')) assert.equal(entry.owner, null);

  const refused = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(refused.status, 409);
  const refusedBody = await jsonBody(refused);
  assert.deepEqual(refusedBody.owner, { name: 'delegate-7', host: 'tmux' });
  assert.match(refusedBody.error, /running as delegate-7 on tmux/);
  assert.equal(liveManager.findBySessionFile(sessionFile), undefined);

  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));
  const forced = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile, force: true }),
  });
  assert.equal(forced.status, 200);
  const forcedBody = await jsonBody(forced);
  assert.equal(forcedBody.session.sessionFile, sessionFile);
  await liveManager.delete(forcedBody.session.id);
  child.stdin.end();
});

test('GET /api/sessions lists projects without parsing their transcripts', async () => {
  const projectDir = path.join(SESSIONS_DIR, '--tmp--listproj');
  writeSessionFileAt(projectDir, 'older.jsonl', [
    { type: 'session', id: 'older', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/listproj' },
    { type: 'message', message: { role: 'user', content: 'older session' } },
  ]);
  writeSessionFileAt(projectDir, 'newer.jsonl', [
    { type: 'session', id: 'newer', timestamp: '2026-01-02T00:00:00.000Z', cwd: '/tmp/listproj' },
    { type: 'message', message: { role: 'user', content: 'newer session' } },
  ]);

  const body = await jsonBody(await fetch(`${base}/api/sessions`));
  const project = body.projects.find((p: { dirName: string }) => p.dirName === '--tmp--listproj');
  assert.equal(project.path, path.resolve('/tmp/listproj'));
  assert.equal(project.count, 2);
  assert.ok(project.lastActive > 0);
  assert.equal(project.sessions, undefined);
});

test('GET /api/sessions/:project summarises the sessions of that project, newest first', async () => {
  const projectDir = path.join(SESSIONS_DIR, '--tmp--summaryproj');
  writeSessionFileAt(projectDir, 'older.jsonl', [
    { type: 'session', id: 'older', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/summaryproj' },
    { type: 'message', message: { role: 'user', content: 'older session' } },
  ]);
  writeSessionFileAt(projectDir, 'newer.jsonl', [
    { type: 'session', id: 'newer', timestamp: '2026-01-02T00:00:00.000Z', cwd: '/tmp/summaryproj' },
    { type: 'message', message: { role: 'user', content: 'newer session' } },
  ]);

  const body = await jsonBody(await fetch(`${base}/api/sessions/--tmp--summaryproj`));
  assert.deepEqual(body.sessions.map((s: { id: string }) => s.id), ['newer', 'older']);
  assert.equal(body.sessions[0].firstMessage, 'Newer session');
  assert.equal(body.sessions[0].file, 'newer.jsonl');
  assert.equal(body.sessions[0].dir, '--tmp--summaryproj');
  assert.equal(body.sessions[0].live, false);
  assert.equal(body.sessions[0].owner, null);
});

test('GET /api/sessions/:project summarises a transcript larger than the read window from both ends', async () => {
  const filler = { type: 'message', message: { role: 'assistant', content: 'x'.repeat(4096) } };
  writeSessionFileAt(PROJ_DIR, 'big.jsonl', [
    { type: 'session', id: 'big', timestamp: '2026-01-03T00:00:00.000Z', cwd: '/tmp/httpproj' },
    { type: 'message', message: { role: 'user', content: 'opening question' } },
    ...Array.from({ length: 40 }, () => filler),
    { type: 'session_info', name: 'Renamed after a long chat' },
  ]);

  const body = await jsonBody(await fetch(`${base}/api/sessions/--tmp--httpproj`));
  const big = body.sessions.find((s: { file: string }) => s.file === 'big.jsonl');
  assert.equal(big.id, 'big');
  assert.equal(big.firstMessage, 'Opening question');
  assert.equal(big.name, 'Renamed after a long chat');
});

test('GET /api/sessions/:project finds the first user message behind system records larger than the read window', async () => {
  // Multi-byte text exercises window boundaries that split a character.
  const system = { type: 'message', message: { role: 'system', content: 'é'.repeat(50 * 1024) } };
  writeSessionFileAt(PROJ_DIR, 'system.jsonl', [
    { type: 'session', id: 'system', timestamp: '2026-01-04T00:00:00.000Z', cwd: '/tmp/httpproj' },
    system, system,
    { type: 'message', message: { role: 'user', content: 'question after the prompt' } },
    { type: 'message', message: { role: 'assistant', content: 'short answer' } },
    { type: 'session_info', name: 'Named at the end' },
  ]);

  const body = await jsonBody(await fetch(`${base}/api/sessions/--tmp--httpproj`));
  const session = body.sessions.find((s: { file: string }) => s.file === 'system.jsonl');
  assert.equal(session.id, 'system');
  assert.equal(session.firstMessage, 'Question after the prompt');
  assert.equal(session.name, 'Named at the end');
});

test('GET /api/sessions/:project returns 404 for an unknown project', async () => {
  const res = await fetch(`${base}/api/sessions/--tmp--nosuchproject`);
  assert.equal(res.status, 404);
});

test('GET /api/sessions preserves hyphenated project cwd from the session header', async () => {
  const projectPath = path.join(PROJECTS_DIR, 'agent-scratch');
  const encodedDir = path.join(SESSIONS_DIR, '--tmp--agent-scratch');
  writeSessionFileAt(encodedDir, 'hyphen.jsonl', [
    { type: 'session', id: 'hyphen', timestamp: '2026-01-01T00:00:00.000Z', cwd: projectPath },
    { type: 'message', message: { role: 'user', content: 'first message' } },
    { type: 'message', message: { role: 'assistant', content: 'reply' } },
    { type: 'message', message: { role: 'user', content: 'second message' } },
  ]);

  const res = await fetch(`${base}/api/sessions`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  const project = body.projects.find((p: { path: string }) => p.path === path.resolve(projectPath));
  assert.ok(project);
  assert.equal(path.basename(project.path), 'agent-scratch');
  assert.ok(!project.path.includes(`${path.sep}agent${path.sep}scratch`));
});

test('GET /api/projects lists project directories under the configured projects dir', async () => {
  fs.mkdirSync(path.join(PROJECTS_DIR, 'myproj'), { recursive: true });
  const res = await fetch(`${base}/api/projects`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  const names = body.projects.map((p: { name: string; active: boolean }) => p.name);
  assert.ok(names.includes('myproj'));
  const proj = body.projects.find((p: { name: string; active: boolean }) => p.name === 'myproj');
  assert.equal(proj.active, false);
});

test('GET /api/projects counts sessions for hyphenated project names using header cwd', async () => {
  const projectPath = path.join(PROJECTS_DIR, 'agent-scratch');
  fs.mkdirSync(projectPath, { recursive: true });
  writeSessionFileAt(path.join(SESSIONS_DIR, '--tmp--agent-scratch-projects'), 'hyphen-projects.jsonl', [
    { type: 'session', id: 'hyphen-projects', timestamp: '2026-01-01T00:00:00.000Z', cwd: projectPath },
    { type: 'message', message: { role: 'user', content: 'project count message' } },
  ]);

  const res = await fetch(`${base}/api/projects`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  const proj = body.projects.find((p: { name: string; sessionCount: number }) => p.name === 'agent-scratch');
  assert.ok(proj);
  assert.ok(proj.sessionCount >= 1);
});

test('GET /api/files lists the directory for a live session', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-files-'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'hi');
  const s = fakeSession('tau_1');
  s.cwd = cwd;
  liveManager.sessions.set('tau_1', s);
  const res = await fetch(`${base}/api/files?sessionId=tau_1`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.ok(body.items.some((i: { name: string }) => i.name === 'a.txt'));
});

test('GET /api/file/preview streams a previewable image inside the session cwd', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-prev-'));
  const png = path.join(cwd, 'img.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const s = fakeSession('tau_1');
  s.cwd = cwd;
  liveManager.sessions.set('tau_1', s);
  const res = await fetch(`${base}/api/file/preview?sessionId=tau_1&path=${encodeURIComponent(png)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
});

test('POST /api/open rejects a missing filePath with 400', async () => {
  const res = await fetch(`${base}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /filePath required/);
});

test('static-file path traversal is rejected with 403', async () => {
  // %2e%2e decodes to '..'; the decoded path resolves outside STATIC_DIR and
  // must be blocked by serveStaticFile's containment guard.
  const res = await fetch(`${base}/%2e%2e%2fsecret`);
  assert.equal(res.status, 403);
  // server stays up for subsequent requests
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
});

test('GET /api/file/preview rejects a non-image with 415', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-prev415-'));
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'hi');
  const s = fakeSession('tau_1');
  s.cwd = cwd;
  liveManager.sessions.set('tau_1', s);
  const res = await fetch(`${base}/api/file/preview?sessionId=tau_1&path=${encodeURIComponent(path.join(cwd, 'notes.txt'))}`);
  assert.equal(res.status, 415);
  assert.match((await jsonBody(res)).error, /Not a previewable image/);
});

test('POST /api/rpc with a malformed JSON body returns 400', async () => {
  const res = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const body = await jsonBody(res);
  assert.ok(body.error);
});

test('POST /api/live-sessions creates a live session and returns 200', async (t: TestContext) => {
  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-post-create-'));
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ cwd, model: 'openai/gpt-5.5' }),
  });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.session.id.startsWith('tau_'), true);
  assert.equal(body.session.cwd, path.resolve(cwd));
  assert.equal(body.session.modelSpec, 'openai/gpt-5.5');
  // end the fake stdin so start()'s 250ms get_state/get_session_stats probes
  // reject immediately instead of scheduling long pending timers.
  child.stdin.end();
});

test('POST /api/live-sessions/resume rejects missing filePath with 400', async () => {
  const res = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /filePath required/);
});

test('POST /api/live-sessions/resume rejects a filePath outside SESSIONS_DIR with 400', async () => {
  const res = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: '/etc/hosts' }),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /Invalid session file/);
});

test('POST /api/live-sessions/resume creates a live session with matching sessionFile', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume-http-'));
  writeSessionFileAt(PROJ_DIR, 'resume.jsonl', [
    { type: 'session', id: 'resume-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd },
    { type: 'message', message: { role: 'user', content: 'first message' } },
    { type: 'message', message: { role: 'assistant', content: 'reply' } },
    { type: 'session_info', name: 'Named Chat' },
  ]);
  const sessionFile = path.join(PROJ_DIR, 'resume.jsonl');

  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));

  const res = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.session.id.startsWith('tau_'), true);
  assert.equal(body.session.sessionFile, path.resolve(sessionFile));
  assert.equal(body.session.sessionName, 'Named Chat');
  assert.equal(body.reused, undefined);
  // Verify the session was added to liveManager.
  assert.equal(liveManager.get(body.session.id)?.sessionFile, path.resolve(sessionFile));
  child.stdin.end();
});

test('POST /api/live-sessions/resume exposes historical entries through the live snapshot', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume-snapshot-'));
  const entries = [
    { type: 'session', id: 'resume-snapshot-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd },
    { type: 'message', message: { role: 'user', content: 'resume this historical thread' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'historical reply' }] } },
    { type: 'session_info', name: 'Snapshot Chat' },
  ];
  writeSessionFileAt(PROJ_DIR, 'resume-snapshot.jsonl', entries);
  const sessionFile = path.join(PROJ_DIR, 'resume-snapshot.jsonl');

  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));

  const resumeRes = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(resumeRes.status, 200);
  const resumeBody = await jsonBody(resumeRes);

  const snapshotRes = await fetch(`${base}/api/live-sessions/${encodeURIComponent(resumeBody.session.id)}/snapshot`);
  assert.equal(snapshotRes.status, 200);
  const snapshot = await jsonBody(snapshotRes);
  assert.equal(snapshot.session.id, resumeBody.session.id);
  assert.equal(snapshot.session.sessionFile, path.resolve(sessionFile));
  assert.equal(snapshot.session.sessionName, 'Snapshot Chat');
  assert.deepEqual(snapshot.entries, entries);
  child.stdin.end();
});

test('POST /api/live-sessions/resume falls back to the first user message for generic or missing names', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume-title-'));
  writeSessionFileAt(PROJ_DIR, 'resume-title.jsonl', [
    { type: 'session', id: 'resume-title-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd },
    { type: 'message', message: { role: 'user', content: 'please investigate the flaky tab switching behavior\nwith details' } },
    { type: 'session_info', name: 'chat' },
  ]);
  const sessionFile = path.join(PROJ_DIR, 'resume-title.jsonl');

  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));

  const res = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.session.sessionName, 'Investigate the flaky tab switching behavior');
  child.stdin.end();
});

test('POST /api/live-sessions/resume returns reused:true when a live session already exists for the file', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume-reuse-'));
  writeSessionFileAt(PROJ_DIR, 'reuse.jsonl', [
    { type: 'session', id: 'reuse-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd },
  ]);
  const sessionFile = path.join(PROJ_DIR, 'reuse.jsonl');

  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));

  // First resume creates the session.
  const res1 = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(res1.status, 200);
  const body1 = await jsonBody(res1);
  assert.equal(body1.reused, undefined);

  // Second resume returns the same session with reused:true.
  const res2 = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(res2.status, 200);
  const body2 = await jsonBody(res2);
  assert.equal(body2.reused, true);
  assert.equal(body2.session.id, body1.session.id);
  // Only one session in the manager.
  assert.equal(liveManager.sessions.size, 1);
  child.stdin.end();
});

test('POST /api/live-sessions/resume rejects when the session header cwd no longer exists', async () => {
  writeSessionFileAt(PROJ_DIR, 'gone-cwd.jsonl', [
    { type: 'session', id: 'gone-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/definitely/not/a/real/path/tau' },
  ]);
  const sessionFile = path.join(PROJ_DIR, 'gone-cwd.jsonl');

  const res = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /Cannot resume session because its project directory no longer exists/);
});

test('POST /api/live-sessions returns 400 when the cwd does not exist', async (t: TestContext) => {
  _setSpawnPiForTest(() => makeFakeChild());
  t.after(() => _setSpawnPiForTest(null));
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ cwd: '/definitely/not/a/real/path/tau' }),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /Directory not found/);
});

test('GET /api/files filters dotfiles and ignored directories from the listing', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-filter-'));
  fs.mkdirSync(path.join(cwd, 'node_modules'));
  fs.mkdirSync(path.join(cwd, '.hidden'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'hi');
  const s = fakeSession('tau_1');
  s.cwd = cwd;
  liveManager.sessions.set('tau_1', s);
  const res = await fetch(`${base}/api/files?sessionId=tau_1`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  const names = body.items.map((i: { name: string }) => i.name);
  assert.ok(names.includes('a.txt'));
  assert.ok(!names.includes('node_modules'));
  assert.ok(!names.includes('.hidden'));
});
