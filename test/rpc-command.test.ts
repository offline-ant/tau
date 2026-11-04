import { runtimeEnvironment } from './rpc-test-environment.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { until } from './fake-pimux.ts';
import { test, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as tau from '../bin/tau.js';

const TMP = runtimeEnvironment.root;

// The first environment module supplies synthetic credentials before Tau loads.
const {
  handleRpcCommand,
  PiRpcSession,
  liveManager,
  appendSessionName,
  parsePiListModels,
  _setAuthForTest,
  _setExecFileForTest,
  SESSIONS_DIR,
  PI_COMMAND,
} = tau as any;

interface RpcTestSession {
  id: string;
  cwd: string;
  model: string;
  modelSpec: string;
  thinkingLevel: string;
  isStreaming: boolean;
  sessionFile: string;
  sessionName: string | null;
  titleSet: boolean;
  entries: Array<Record<string, unknown>>;
  contextUsage: { tokens?: number; usage?: { input_tokens: number; output_tokens: number } } | null;
  metadata: () => Record<string, unknown>;
  snapshot: () => Record<string, unknown>;
  send: (cmd: { id?: string; type?: string; [k: string]: unknown }) =>
    Promise<{ type: string; id?: string; success: boolean; data?: Record<string, unknown>; error?: string }>;
  referencesSessionFile: (file: string) => boolean;
  attachment: { muxId: string; ready: boolean; leafId: string | null;
    inputContext: { sessionFile: string | null; leafId: string | null; contextId: string } };
  browserInputContext: (command: Record<string, unknown>) => unknown;
}

const PROJ = path.join(SESSIONS_DIR, '--tmp--proj');
const SESSION_FILE = path.join(PROJ, 's.jsonl');

before(() => {
  fs.mkdirSync(PROJ, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ type: 'session', id: 's' }) + '\n');
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  liveManager.sessions.clear();
  _setAuthForTest(true);
  _setExecFileForTest(null);
});

function contextFor(session: { sessionFile: string | null; attachment: { muxId: string; leafId: string | null; inputContext: unknown } | null }) {
  return { agentId: session.attachment?.muxId ?? null, file: session.sessionFile,
    leafId: session.attachment?.leafId ?? null, runtimeContext: session.attachment?.inputContext ?? null };
}

function injectSession(overrides: Partial<RpcTestSession> = {}): RpcTestSession {
  const session: RpcTestSession = {
    id: 'tau_test',
    cwd: '/tmp/proj',
    model: 'openai/gpt-5.5',
    modelSpec: '',
    thinkingLevel: 'off',
    isStreaming: false,
    sessionFile: SESSION_FILE,
    sessionName: null,
    titleSet: false,
    entries: [{ type: 'message', message: { role: 'user', content: 'hi' } }],
    contextUsage: null,
    metadata: () => ({
      id: session.id, cwd: session.cwd, model: session.model, modelSpec: session.modelSpec,
      modelLabel: session.model, thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming,
      sessionFile: session.sessionFile, sessionName: session.sessionName, contextUsage: session.contextUsage,
    }),
    snapshot: () => ({
      session: { id: session.id },
      entries: session.entries,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      contextUsage: null,
    }),
    send: async (cmd) => ({ type: 'response', id: cmd.id, success: true, data: {} }),
    referencesSessionFile: () => false,
    attachment: { muxId: 'rpc-test-mux', ready: true, leafId: null,
      inputContext: { sessionFile: SESSION_FILE, leafId: null, contextId: 'rpc-test-context' } },
    browserInputContext(command) { return PiRpcSession.prototype.browserInputContext.call(this, command); },
    ...overrides,
  };
  liveManager.sessions.set(session.id, session);
  return session;
}

test('get_auth reports configured + enabled state', async () => {
  _setAuthForTest(false);
  let resp = await handleRpcCommand({ type: 'get_auth' });
  assert.equal(resp.success, true);
  assert.equal(resp.data.configured, true);
  assert.equal(resp.data.enabled, false);
  _setAuthForTest(true);
  resp = await handleRpcCommand({ type: 'get_auth' });
  assert.equal(resp.data.enabled, true);
});

test('set_auth toggles the enabled flag when credentials are configured', async () => {
  const resp = await handleRpcCommand({ type: 'set_auth', enabled: false });
  assert.equal(resp.success, true);
  assert.equal(resp.data.enabled, false);
  // toggling back on
  const resp2 = await handleRpcCommand({ type: 'set_auth', enabled: true });
  assert.equal(resp2.data.enabled, true);
});

test('parsePiListModels preserves slashful model ids from pi table output', () => {
  const out = parsePiListModels(`provider      model                                               context  max-out  thinking  images
anthropic     claude-opus-4-5                                     200K     64K      yes       yes
fireworks     accounts/fireworks/models/deepseek-v4-flash         1M       384K     yes       no
`);
  assert.deepEqual(out, [
    { provider: 'anthropic', id: 'claude-opus-4-5', context: '200K', maxOutput: '64K', thinking: true, images: true },
    { provider: 'fireworks', id: 'accounts/fireworks/models/deepseek-v4-flash', context: '1M', maxOutput: '384K', thinking: true, images: false },
  ]);
});

test('get_available_models returns parsed pi model list', async () => {
  _setExecFileForTest((file: string, args: string[], opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    assert.equal(file, PI_COMMAND);
    assert.equal(path.isAbsolute(file), true, 'metadata never invokes global Pi');
    assert.deepEqual(args, ['--list-models']);
    cb(null, `provider      model                                               context  max-out  thinking  images
openrouter    z-ai/glm-5.2                                        128K     16K      yes       no
`, '');
  });
  const resp = await handleRpcCommand({ type: 'get_available_models' });
  assert.equal(resp.success, true);
  assert.deepEqual(resp.data.models, [
    { provider: 'openrouter', id: 'z-ai/glm-5.2', context: '128K', maxOutput: '16K', thinking: true, images: false },
  ]);
});

test('set_session_name with filePath appends a session_info record', async () => {
  const resp = await handleRpcCommand({ type: 'set_session_name', filePath: SESSION_FILE, name: 'Plan' });
  assert.equal(resp.success, true);
  assert.equal(resp.data.name, 'Plan');
  const lines = fs.readFileSync(SESSION_FILE, 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[lines.length - 1]).name, 'Plan');
});

test('set_session_name rejects empty names and invalid file paths', async () => {
  const empty = await handleRpcCommand({ type: 'set_session_name', filePath: SESSION_FILE, name: '   ' });
  assert.equal(empty.success, false);
  assert.match(empty.error, /Name cannot be empty/);
  const bad = await handleRpcCommand({ type: 'set_session_name', filePath: '/etc/hosts', name: 'x' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /Invalid session file/);
});

test('set_session_name with sessionId renames through the live Pi, which owns the file', async () => {
  const sent: Array<{ type?: string; name?: string }> = [];
  const session = injectSession({ send: async (cmd) => { sent.push(cmd); return { type: 'response', id: cmd.id, success: true, data: {} }; } });
  const before = fs.readFileSync(SESSION_FILE, 'utf8');
  const resp = await handleRpcCommand({ type: 'set_session_name', sessionId: session.id, name: 'Live title', inputContext: contextFor(session) });
  assert.equal(resp.success, true);
  assert.deepEqual(sent.map(({ type, name }) => ({ type, name })), [{ type: 'set_session_name', name: 'Live title' }]);
  assert.equal(fs.readFileSync(SESSION_FILE, 'utf8'), before, 'Tau never appends to a file a live Pi writes');
  assert.equal(session.sessionName, 'Live title');
  assert.equal(session.titleSet, true);
});

test('set_session_name with a filePath matching a live session renames through that session', async () => {
  const sent: string[] = [];
  const session = injectSession({
    referencesSessionFile: (file: string) => file === path.resolve(SESSION_FILE),
    send: async (cmd) => { sent.push(String(cmd.type)); return { type: 'response', id: cmd.id, success: true, data: {} }; },
  });
  const resp = await handleRpcCommand({ type: 'set_session_name', filePath: session.sessionFile, name: 'From file' });
  assert.equal(resp.success, true);
  assert.deepEqual(sent, ['set_session_name']);
  assert.equal(session.sessionName, 'From file');
  assert.equal(session.titleSet, true);
});

test('set_session_name reports a live Pi refusing the rename', async () => {
  const session = injectSession({ send: async (cmd) => ({ type: 'response', id: cmd.id, success: false, error: 'nope' }) });
  const resp = await handleRpcCommand({ type: 'set_session_name', sessionId: session.id, name: 'Refused', inputContext: contextFor(session) });
  assert.equal(resp.success, false);
  assert.match(resp.error, /nope/);
  assert.equal(session.sessionName, null);
});

test('set_session_name rejects when neither sessionId nor filePath is provided', async () => {
  const resp = await handleRpcCommand({ type: 'set_session_name', name: 'Orphan' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /sessionId or filePath required/);
});

test('get_state returns cached backend state for the session', async () => {
  const session = injectSession({ model: 'anthropic/claude', thinkingLevel: 'high', isStreaming: true });
  const resp = await handleRpcCommand({ type: 'get_state', sessionId: session.id });
  assert.equal(resp.success, true);
  assert.equal(resp.data.model, 'anthropic/claude');
  assert.equal(resp.data.thinkingLevel, 'high');
  assert.equal(resp.data.isStreaming, true);
  assert.equal(resp.data.sessionFile, SESSION_FILE);
});

test('a fresh state probe asks Pi rather than mistaking cached idle for prompt completion', async () => {
  const calls: Record<string, unknown>[] = [];
  const session = injectSession({
    isStreaming: false,
    send: async command => {
      calls.push(command);
      return { type: 'response', success: true, data: { isStreaming: true, isCompacting: false, model: { provider: 'openrouter', id: 'z-ai/glm-5.2' } } };
    },
  });
  const response = await handleRpcCommand({ type: 'get_state', sessionId: session.id, refresh: true });
  assert.equal(response.success, true);
  assert.equal(response.data.isStreaming, true);
  assert.equal(response.data.isCompacting, false);
  assert.deepEqual(response.data.model, { provider: 'openrouter', id: 'z-ai/glm-5.2' });
  assert.deepEqual(calls, [{ type: 'get_state' }]);
});

test('a failed fresh state probe never falls back to cached idle', async () => {
  const session = injectSession({ send: async () => { throw new Error('RPC command timed out: get_state'); } });
  const response = await handleRpcCommand({ type: 'get_state', sessionId: session.id, refresh: true });
  assert.equal(response.success, false);
  assert.match(response.error, /timed out/);
});

test('get_messages returns cached entries', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'get_messages', sessionId: session.id });
  assert.equal(resp.success, true);
  assert.equal(resp.data.entries.length, 1);
});

test('live_session_snapshot_request returns a live_session_snapshot payload', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'live_session_snapshot_request', sessionId: session.id });
  assert.equal(resp.type, 'live_session_snapshot');
  assert.equal(resp.sessionId, session.id);
  assert.deepEqual(resp.entries, session.entries);
});

test('set_auto_compaction changes the setting in Pi and get_state reports Pi\'s value', async () => {
  const calls: Record<string, unknown>[] = [];
  const session = injectSession({
    send: async (cmd) => {
      calls.push(cmd);
      return { type: 'response', id: cmd.id, success: true, data: {} };
    },
  });
  (session as unknown as { autoCompactionEnabled: boolean }).autoCompactionEnabled = true;
  const resp = await handleRpcCommand({ type: 'set_auto_compaction', sessionId: session.id, enabled: false, inputContext: contextFor(session) });
  assert.equal(resp.success, true);
  assert.equal(resp.data.enabled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'set_auto_compaction');
  assert.equal(calls[0].enabled, false);
  const state = await handleRpcCommand({ type: 'get_state', sessionId: session.id });
  assert.equal(state.data.autoCompactionEnabled, false);
});

test('set_auto_compaction keeps the old value when Pi refuses it', async () => {
  const session = injectSession({
    send: async (cmd) => ({ type: 'response', id: cmd.id, success: false, data: {}, error: 'settings are read-only' }),
  });
  (session as unknown as { autoCompactionEnabled: boolean }).autoCompactionEnabled = true;
  const resp = await handleRpcCommand({ type: 'set_auto_compaction', sessionId: session.id, enabled: false, inputContext: contextFor(session) });
  assert.equal(resp.success, false);
  const state = await handleRpcCommand({ type: 'get_state', sessionId: session.id });
  assert.equal(state.data.autoCompactionEnabled, true);
});

test('compact is refused while a reply runs, so the reply is never aborted', async () => {
  const calls: Record<string, unknown>[] = [];
  const session = injectSession({
    isStreaming: true,
    send: async (cmd) => { calls.push(cmd); return { type: 'response', id: cmd.id, success: true, data: {} }; },
  });
  const resp = await handleRpcCommand({ type: 'compact', sessionId: session.id, inputContext: contextFor(session) });
  assert.equal(resp.success, false);
  assert.match(resp.error, /stop it first/);
  assert.equal(resp.compactionStarted, false);
  assert.deepEqual(calls, []);
});

test('compact allows a slow summary up to ten minutes and passes the instructions to Pi', async () => {
  const sent: Array<{ cmd: Record<string, unknown>; opts: { timeoutMs?: number } }> = [];
  const session = injectSession();
  (session as unknown as { send: unknown }).send = async (cmd: Record<string, unknown>, opts: { timeoutMs?: number }) => {
    sent.push({ cmd, opts });
    return { type: 'response', id: cmd.id, success: true, data: { summary: 'S' } };
  };
  const resp = await handleRpcCommand({ type: 'compact', sessionId: session.id, customInstructions: 'keep the API notes', inputContext: contextFor(session) });
  assert.equal(resp.success, true);
  assert.equal(resp.compactionStarted, false);
  assert.equal(sent[0].cmd.customInstructions, 'keep the API notes');
  assert.equal(sent[0].opts.timeoutMs, 10 * 60000);
});

test('a failed compact says whether Pi had started compacting', async () => {
  const session = injectSession();
  const fake = session as unknown as { compactionRevision: number; send: unknown };
  fake.compactionRevision = 0;
  fake.send = async (cmd: Record<string, unknown>) => {
    fake.compactionRevision++; // Pi emitted compaction_start before it failed.
    return { type: 'response', id: cmd.id, success: false, error: 'Nothing to compact (session too small)' };
  };
  const resp = await handleRpcCommand({ type: 'compact', sessionId: session.id, inputContext: contextFor(session) });
  assert.equal(resp.success, false);
  assert.equal(resp.compactionStarted, true);
});

test('native commands require an active live session', async () => {
  const resp = await handleRpcCommand({ type: 'prompt', message: 'hi' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /No active Tau session/);
});

test('unknown command is rejected', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'bogus', sessionId: session.id, inputContext: contextFor(session) });
  assert.equal(resp.success, false);
  assert.match(resp.error, /Unknown command: bogus/);
});

test('new_session moves the same shared runtime rather than creating a frontend-owned tab', async () => {
  const commands: string[] = [];
  const session = injectSession({ send: async command => { commands.push(String(command.type)); return { type: 'response', success: true, data: {} }; } });
  const response = await handleRpcCommand({ type: 'new_session', sessionId: session.id, inputContext: contextFor(session) });
  assert.equal(response.success, true);
  assert.deepEqual(commands, ['new_session']);
});

test('native commands are proxied to the child and success is preserved', async () => {
  const session = injectSession({
    send: async (cmd) => ({ type: 'response', id: cmd.id, success: true, data: { ok: 1 } }),
  });
  const resp = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: 'hi', inputContext: contextFor(session) });
  assert.equal(resp.success, true);
  assert.equal(resp.data.ok, 1);
});

test('Abort acknowledgement timeout reports failure and preserves the running state', async t => {
  const { session } = await runtimeFixture(t);
  session.isStreaming = true;
  session.send = async () => { throw new Error('RPC command timed out: abort'); };
  liveManager.sessions.set(session.id, session);
  const resp = await handleRpcCommand({ type: 'abort', sessionId: session.id, inputContext: contextFor(session) });
  assert.equal(resp.success, false);
  assert.match(resp.error, /timed out/);
  assert.equal(session.isStreaming, true);
  assert.equal(session.metadata().abortState, 'timed_out');
});

test('UI reply acknowledges socket delivery without an RPC timer and membership waits for mux closure', async t => {
  const { session, mux, emit } = await runtimeFixture(t);
  liveManager.sessions.set(session.id, session);
  await emit({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm' });
  await until(() => session.attachment?.dialogs.has('confirm-1'), 'dialog received');
  const response = await handleRpcCommand({ type: 'extension_ui_response', id: 'confirm-1', sessionId: session.id, confirmed: false, inputContext: contextFor(session) });
  assert.equal(response.success, true);
  assert.deepEqual(response.data, { delivered: true });
  assert.equal(session.pending.size, 0);
  assert.equal(session.attachment?.dialogs.has('confirm-1'), true);
  await until(() => mux.commands.some(command => command.id === 'confirm-1' && command.confirmed === false), 'reply delivered');
  await emit({ type: 'pimux_dialog_closed', id: 'confirm-1', reason: 'answered' });
  await until(() => !session.attachment?.dialogs.has('confirm-1'), 'mux closure');
  const stale = await handleRpcCommand({ type: 'extension_ui_response', id: 'confirm-1', sessionId: session.id, confirmed: true, inputContext: contextFor(session) });
  assert.equal(stale.success, false);
});

test('prompt acknowledgement timeout is not treated as acceptance', async () => {
  const session = injectSession({ send: async () => { throw new Error('RPC command timed out: prompt'); } });
  const resp = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: 'hi', inputContext: contextFor(session) });
  assert.equal(resp.success, false);
  assert.match(resp.error, /timed out/);
  assert.equal(resp.delivery, 'uncertain');
});

test('explicit prompt rejection is safe to retry', async () => {
  const session = injectSession({ send: async () => ({ type: 'response', success: false, error: 'Rejected', data: {} }) });
  const resp = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: 'hi', inputContext: contextFor(session) });
  assert.equal(resp.delivery, 'rejected');
  const missing = await handleRpcCommand({ type: 'prompt', sessionId: 'missing', message: 'hi' });
  assert.equal(missing.delivery, 'rejected');
});

test('immediate send failures are reported as errors, not swallowed', async () => {
  const session = injectSession({
    send: async () => { throw new Error('Pi RPC session is not running'); },
  });
  const resp = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: 'hi', inputContext: contextFor(session) });
  assert.equal(resp.success, false);
  assert.match(resp.error, /not running/);
});

test('export_html rejects an invalid session file path', async () => {
  const resp = await handleRpcCommand({ type: 'export_html', filePath: '/etc/hosts' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /Invalid session file/);
});

test('export_html rejects a sessionId that does not resolve to a live session', async () => {
  const resp = await handleRpcCommand({ type: 'export_html', sessionId: 'tau_missing' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /Live session not found/);
});

test('export_html rejects an outputPath outside the session directory before invoking pi', async () => {
  const resp = await handleRpcCommand({
    type: 'export_html',
    filePath: SESSION_FILE,
    outputPath: '/tmp/escaped.html',
  });
  assert.equal(resp.success, false);
  assert.match(resp.error, /session directory/);
});

test('set_auth persists the enabled flag to settings.json', async () => {
  await handleRpcCommand({ type: 'set_auth', enabled: true });
  const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR!, 'settings.json');
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(parsed.tau.authEnabled, true);
});
