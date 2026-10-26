import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FakePi } from './fake-pi.ts';
import type { SessionTreeNodeLike, TreeEntry } from '../src/server/tree.ts';

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
const { server, computeUrls, liveManager, SESSIONS_DIR, _setSpawnPiForTest, SessionLifecycleError, PiRpcSession } = (await import('../bin/tau.js')) as any;
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
  snapshot: () => Promise<{ session: { id: string }; entries: unknown[]; model: string; isStreaming: boolean; sessionFile: string }>;
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
    snapshot: async () => ({ session: { id }, entries: [], model: 'openai/gpt-5.5', isStreaming: false, sessionFile: `/tmp/${id}.jsonl` }),
    terminate: async () => {},
  };
}

function installFakeChild(t: TestContext, child = new FakePi()) {
  _setSpawnPiForTest((_cmd: string, args: string[]) => {
    const index = args.indexOf('--session');
    if (index !== -1) {
      const file = args[index + 1];
      child.state.sessionFile = file;
      const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as TreeEntry)
        .filter((entry) => entry.type !== 'session' && typeof entry.id === 'string');
      child.tree = entries.map((entry): SessionTreeNodeLike => ({ entry }));
      child.leafId = entries.at(-1)?.id ?? null;
    }
    return child.asChild();
  });
  t.after(() => _setSpawnPiForTest(null));
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
  assert.match(body.lanUrl, /^https:\/\/localhost:\d+$/);
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
  assert.equal(refusedBody.childStopped, undefined, 'an ownership conflict never authorizes source rollback');
  assert.equal(liveManager.findBySessionFile(sessionFile), undefined);
  const invalid = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath: sessionFile, args: [42], force: true }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await jsonBody(invalid)).childStopped, false, 'invalid input and force do not erase a terminal owner');

  const child = installFakeChild(t);
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
  const child = installFakeChild(t);
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
  // No more RPC commands are expected after this request.
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
  const body = await jsonBody(res);
  assert.match(body.error, /Invalid session file/);
  assert.equal(body.childStopped, true);
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

  const child = installFakeChild(t);

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
  assert.equal(body.started, true);
  // Verify the session was added to liveManager.
  assert.equal(liveManager.get(body.session.id)?.sessionFile, path.resolve(sessionFile));
  child.stdin.end();
});

test('POST /api/live-sessions/resume exposes historical entries through the live snapshot', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume-snapshot-'));
  const entries = [
    { type: 'session', id: 'resume-snapshot-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd },
    { id: 'user', parentId: null, type: 'message', message: { role: 'user', content: 'resume this historical thread' } },
    { id: 'answer', parentId: 'user', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'historical reply' }] } },
    { id: 'name', parentId: 'answer', type: 'session_info', name: 'Snapshot Chat' },
  ];
  writeSessionFileAt(PROJ_DIR, 'resume-snapshot.jsonl', entries);
  const sessionFile = path.join(PROJ_DIR, 'resume-snapshot.jsonl');

  const child = installFakeChild(t);

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

  const child = installFakeChild(t);

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

  const child = installFakeChild(t);

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
  assert.equal(body1.started, true);
  assert.equal(body2.started, false);
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
  const body = await jsonBody(res);
  assert.match(body.error, /Cannot resume session because its project directory no longer exists/);
  assert.equal(body.childStopped, true);
});

test('POST /api/live-sessions returns 400 when the cwd does not exist', async (t: TestContext) => {
  _setSpawnPiForTest(() => new FakePi().asChild());
  t.after(() => _setSpawnPiForTest(null));
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ cwd: '/definitely/not/a/real/path/tau' }),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /Directory not found/);
});

test('resume forwards validated args/env and rejects malformed overrides before spawn', async (t: TestContext) => {
  const file = writeSessionFileAt(PROJ_DIR, 'overrides.jsonl', [{ type: 'session', id: 'overrides', cwd: PROJECTS_DIR }]);
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  _setSpawnPiForTest((_cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    calls.push({ args, env: opts.env });
    return new FakePi({ sessionFile: file }).asChild();
  });
  t.after(() => _setSpawnPiForTest(null));
  const request = (body: Record<string, unknown>) => fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: file, ...body }),
  });
  for (const invalid of [{ args: '--model' }, { args: [42] }, { env: { KEY: 2 } }, { env: { 'BAD KEY': 'value' } }, { model: 42 }, { refresh: 'true' }, { refresh: null }]) {
    const response = await request(invalid);
    assert.equal(response.status, 400);
    assert.equal((await jsonBody(response)).childStopped, true);
  }
  assert.equal(calls.length, 0);
  const args = ['--provider', 'example', '--model', 'model', '--thinking', 'high'];
  const env = { PI_CODING_AGENT_DIR: '/tmp/original-agent', HERDR_SOCKET_PATH: '/tmp/original-herdr.sock' };
  const response = await request({ args, env });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-args.length), args);
  for (const [key, value] of Object.entries(env)) assert.equal(calls[0].env[key], value);
  await liveManager.delete((await jsonBody(response)).session.id);
});

test('resume validation never authorizes rollback for an existing, pending, or closing writer', async (t: TestContext) => {
  const file = writeSessionFileAt(PROJ_DIR, 'validation-writer.jsonl', [{ type: 'session', id: 'writer', cwd: PROJECTS_DIR }]);
  const session = new PiRpcSession(liveManager, { id: 'writer', cwd: PROJECTS_DIR, sessionFile: file });
  t.after(() => {
    liveManager.sessions.delete(session.id);
    liveManager.pendingResumes.delete(file);
    liveManager.terminatingResumes.delete(file);
  });
  for (const state of ['existing', 'pending', 'terminating']) {
    if (state === 'existing') liveManager.sessions.set(session.id, session);
    if (state === 'pending') liveManager.pendingResumes.set(file, Promise.resolve(session));
    if (state === 'terminating') liveManager.terminatingResumes.set(file, Promise.resolve());
    const response = await fetch(`${base}/api/live-sessions/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: file, args: [42] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await jsonBody(response)).childStopped, false, state);
    liveManager.sessions.delete(session.id);
    liveManager.pendingResumes.delete(file);
    liveManager.terminatingResumes.delete(file);
  }
});

test('resume validation accounts for an in-progress create on the same file', async (t: TestContext) => {
  const file = writeSessionFileAt(PROJ_DIR, 'creating-writer.jsonl', [{ type: 'session', id: 'creating', cwd: PROJECTS_DIR }]);
  const child = installFakeChild(t, new FakePi({ autoRespond: false }));
  const creating = liveManager.create({ cwd: PROJECTS_DIR, sessionFile: file });
  try {
    assert.equal(liveManager.hasStartingSession(file), true);
    assert.equal(liveManager.findBySessionFile(file), undefined);
    assert.equal(liveManager.hasPendingResume(file), false);
    const response = await fetch(`${base}/api/live-sessions/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: file, env: [] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await jsonBody(response)).childStopped, false);
  } finally {
    child.autoRespond = true;
    child.respond(child.commands[0]);
    const session = await creating;
    assert.equal(liveManager.hasStartingSession(file), false);
    await liveManager.delete(session.id);
  }
});

test('unidentified and unexpected resume errors do not authorize rollback', async (t: TestContext) => {
  for (const body of ['{bad-json', '{}', '{"filePath":42}']) {
    const response = await fetch(`${base}/api/live-sessions/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, 400);
    assert.equal((await jsonBody(response)).childStopped, undefined);
  }
  const file = writeSessionFileAt(PROJ_DIR, 'unexpected.jsonl', [{ type: 'session', id: 'unexpected', cwd: PROJECTS_DIR }]);
  t.mock.method(liveManager, 'findBySessionFile', () => { throw new Error('unexpected lookup failure'); });
  const response = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: file }),
  });
  assert.equal(response.status, 400);
  const body = await jsonBody(response);
  assert.equal(body.error, 'unexpected lookup failure');
  assert.equal(body.childStopped, undefined);
});

test('failed startup reports childStopped only after cleanup and does not keep a dead tab', async (t: TestContext) => {
  const file = writeSessionFileAt(PROJ_DIR, 'failed-start.jsonl', [{ type: 'session', id: 'failed', cwd: PROJECTS_DIR }]);
  const child = installFakeChild(t);
  t.mock.method(child, 'respond', (command: { id?: string; type?: string }) => {
    child.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: false, error: 'cannot load state' }) + '\n');
  });
  const response = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: file }),
  });
  const body = await jsonBody(response);
  assert.equal(response.status, 400);
  assert.equal(body.childStopped, true);
  assert.equal(typeof body.sessionId, 'string');
  assert.match(body.error, /cannot load state/);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(liveManager.findBySessionFile(file), undefined);
});

test('DELETE cleanup uncertainty is an explicit error and keeps the child tracked', async () => {
  const session = fakeSession('uncertain');
  session.terminate = async () => { throw new SessionLifecycleError('exit not confirmed', session.id, false); };
  liveManager.sessions.set(session.id, session);
  const response = await fetch(`${base}/api/live-sessions/${session.id}`, { method: 'DELETE' });
  assert.equal(response.status, 503);
  assert.deepEqual(await jsonBody(response), { error: 'exit not confirmed', sessionId: session.id, childStopped: false });
  assert.equal(liveManager.get(session.id), session);
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

test('resume refresh keeps the tab and reloads its confirmed active history; ordinary reuse does not reload', async (t: TestContext) => {
  const file = writeSessionFileAt(PROJ_DIR, 'refresh.jsonl', [{ type: 'session', id: 'refresh', cwd: PROJECTS_DIR }]);
  const child = installFakeChild(t, new FakePi({ state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } }));
  const respond = child.respond.bind(child);
  t.mock.method(child, 'respond', (command: { type?: string; id?: string }) => {
    respond(command, command.type === 'switch_session' ? { data: { cancelled: false } } : {});
  });
  const request = (refresh?: boolean) => fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: file, refresh }),
  });
  const created = await jsonBody(await request(true));
  assert.equal(created.started, true);
  assert.equal(created.refreshed, undefined);
  assert.equal(child.commands.some((command) => command.type === 'switch_session'), false);
  const entry = { id: 'new-entry', parentId: null, type: 'message', message: { role: 'user', content: 'latest from terminal' } };
  child.tree = [{ entry }];
  child.leafId = entry.id;
  const reused = await jsonBody(await request());
  assert.equal(reused.started, false);
  assert.equal(reused.refreshed, undefined);
  assert.equal(child.commands.some((command) => command.type === 'switch_session'), false);
  const refreshed = await jsonBody(await request(true));
  assert.equal(refreshed.session.id, created.session.id);
  assert.equal(refreshed.started, false);
  assert.equal(refreshed.reused, true);
  assert.equal(refreshed.refreshed, true);
  const snapshot = await jsonBody(await fetch(`${base}/api/live-sessions/${created.session.id}/snapshot`));
  assert.equal(snapshot.entries.at(-1).id, entry.id);
  assert.equal(liveManager.sessions.size, 1);
  const arbitrary = await jsonBody(await fetch(`${base}/api/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'switch_session', sessionId: created.session.id, sessionPath: file }),
  }));
  assert.equal(arbitrary.success, false);
  assert.match(arbitrary.error, /Unknown command/);
  child.state.pendingMessageCount = 1;
  const busy = await request(true);
  assert.equal(busy.status, 400);
  const rejected = await jsonBody(busy);
  assert.match(rejected.error, /queued prompts/);
  assert.equal(rejected.refreshed, undefined);
  assert.equal(rejected.childStopped, undefined);
  assert.equal(liveManager.sessions.size, 1);
  assert.deepEqual(child.signals, []);
  await liveManager.delete(created.session.id);
});

test('refresh never bypasses a terminal owner and succeeds after source teardown removes ownership', async (t: TestContext) => {
  const file = writeSessionFileAt(PROJ_DIR, 'refresh-owner.jsonl', [{ type: 'session', id: 'owner-refresh', cwd: PROJECTS_DIR }]);
  const child = installFakeChild(t, new FakePi({ state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } }));
  const respond = child.respond.bind(child);
  t.mock.method(child, 'respond', (command: { type?: string; id?: string }) => respond(command, command.type === 'switch_session' ? { data: { cancelled: false } } : {}));
  const request = () => fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: file, refresh: true }),
  });
  const created = await jsonBody(await request());
  const registry = path.join(os.tmpdir(), 'pi-orchestration-targets');
  fs.mkdirSync(registry, { recursive: true });
  const ownerFile = path.join(registry, 'refresh-source.json');
  fs.writeFileSync(ownerFile, JSON.stringify({ target: { host: 'herdr', name: 'source', id: 'p1', kind: 'pi', sessionFile: file } }));
  t.after(() => fs.rmSync(ownerFile, { force: true }));
  const denied = await request();
  assert.equal(denied.status, 409);
  assert.equal(child.commands.some((command) => command.type === 'switch_session'), false);
  fs.rmSync(ownerFile);
  const refreshed = await jsonBody(await request());
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.session.id, created.session.id);
  await liveManager.delete(created.session.id);
});
