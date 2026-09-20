#!/usr/bin/env node
/*
 * Tau standalone server.
 *
 * Serves the Tau web UI and manages backend-owned `pi --mode rpc` child
 * sessions. Browser connections are views only; explicit live-session DELETE or
 * server shutdown terminates child Pi processes.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, type ExecException } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Stats, Dirent } from 'node:fs';
import type { Socket } from 'node:net';
import type { WebSocket as WsType } from 'ws';
import type { JsonRecord, RpcCommand, RpcResponse, StatusError } from './types.js';
import { ARGS, AUTH_CONFIGURED, HOST, MIME_TYPES, PI_AGENT_DIR, PORT, SESSIONS_DIR, STATIC_DIR, TAU_SETTINGS, expandHome, loadTauSettings, parseArgs, saveTauSetting } from './config.js';
import { SESSION_COOKIE_NAME, SESSION_REFRESH_THRESHOLD_SECONDS, buildSessionCookie, issueSessionToken, parseCookies, verifySessionToken } from './auth.js';
import { getAvailableModels, modelLabel, normalizeModel, parseModelSpecToModel, parsePiListModels, _clearModelListCacheForTest, _setExecFileForTest } from './model-utils.js';
import { LiveSessionManager, PiRpcSession, isGenericSessionName, liveManager, makeId, _setSpawnPiForTest } from './sessions.js';
import { buildEndpoint, orchestrationEndpoint, publishEndpoint, unpublishEndpoint } from './orchestration.js';
import { sessionOwner, sessionOwners } from './session-owners.js';
import { NAVIGATE_COMMAND, NAVIGATION_MARKER_TYPE, flattenTree, isTreeNavigationInProgress, leafDescendsFrom, navigateTree, pathFromRoot, selectNavigationTarget } from './tree.js';

type TauWs = WsType & { isAlive?: boolean };

let authEnabled = AUTH_CONFIGURED && TAU_SETTINGS.authEnabled !== false;

function checkBasicAuth(req: IncomingMessage) {
  if (!authEnabled) return true;
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  return decoded.slice(0, colon) === TAU_SETTINGS.user && decoded.slice(colon + 1) === TAU_SETTINGS.pass;
}

type AuthResult = { ok: boolean; via: 'disabled' | 'basic' | 'cookie' | 'none'; expiresAt?: number };

// A wrong Basic header does not short-circuit: a valid session cookie still
// wins, so a browser resending a stale cached Basic header cannot lock the
// user out of an otherwise live session.
function checkAuth(req: IncomingMessage): AuthResult {
  if (!authEnabled) return { ok: true, via: 'disabled' };
  if (checkBasicAuth(req)) return { ok: true, via: 'basic' };
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  if (token) {
    const verdict = verifySessionToken(token);
    if (verdict.valid) return { ok: true, via: 'cookie', expiresAt: verdict.expiresAt };
  }
  return { ok: false, via: 'none' };
}

function isForwardedHttps(req: IncomingMessage): boolean {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// Mint when the request carries no valid session cookie (covers the page load
// right after the native prompt) and refresh one nearing expiry; never mint
// while auth is disabled so toggling it back on grants nothing to bystanders.
// Desktop browsers resend the Basic header on every request, so Basic-authed
// requests usually also carry a fresh cookie — don't re-mint on every response.
function maybeSetSessionCookie(req: IncomingMessage, res: ServerResponse, auth: AuthResult) {
  if (!authEnabled || !auth.ok || auth.via === 'disabled') return;
  let expiresAt = auth.expiresAt;
  if (expiresAt === undefined) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (token) {
      const verdict = verifySessionToken(token);
      if (verdict.valid) expiresAt = verdict.expiresAt;
    }
  }
  if (expiresAt !== undefined && expiresAt - Math.floor(Date.now() / 1000) >= SESSION_REFRESH_THRESHOLD_SECONDS) return;
  res.setHeader('Set-Cookie', buildSessionCookie(issueSessionToken(), { secure: isForwardedHttps(req) }));
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function errorStatus(e: unknown): number {
  if (e && typeof e === 'object' && 'status' in e) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number' && status) return status;
  }
  return 400;
}

function sendAuthRequired(res: ServerResponse, req?: IncomingMessage) {
  // Clear a presented-but-invalid session cookie so the browser stops
  // resending it and falls back to the Basic prompt.
  if (req && parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]) {
    res.setHeader('Set-Cookie', buildSessionCookie('', { secure: isForwardedHttps(req), clear: true }));
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Tau"', 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

function json(res: ServerResponse, status: number, data: unknown, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<RpcCommand> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 20 * 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) as RpcCommand : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

let lanUrl = '';
let tailscaleUrl = '';

function resolveSessionFile(filePath: string) {
  if (!filePath || typeof filePath !== 'string') throw new Error('filePath required');
  const resolved = path.resolve(filePath);
  const root = path.resolve(SESSIONS_DIR);
  if (!resolved.startsWith(root + path.sep) || !resolved.endsWith('.jsonl')) {
    throw new Error('Invalid session file');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('Session not found');
  return resolved;
}

/**
 * Validates the programmatic spawn fields of POST /api/live-sessions.
 *
 * These let an orchestration client (pi-ant) run the child with its own
 * extensions, model flags, and environment. They do not widen the server's
 * blast radius: the API already starts `pi` in a caller-chosen directory and
 * prompts it, so it is an authenticated code-execution surface either way.
 * The checks exist to turn malformed input into a 400 instead of a confusing
 * spawn failure.
 */
function parseSpawnOverrides(body: RpcCommand): { args?: string[]; env?: Record<string, string>; sessionFile?: string } {
  const overrides: { args?: string[]; env?: Record<string, string>; sessionFile?: string } = {};
  if (body.args !== undefined) {
    if (!Array.isArray(body.args) || body.args.some((arg) => typeof arg !== 'string')) throw new Error('args must be an array of strings');
    overrides.args = body.args as string[];
  }
  if (body.env !== undefined) {
    if (typeof body.env !== 'object' || body.env === null || Array.isArray(body.env)) throw new Error('env must be an object of string values');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new Error(`env.${key} must be a string`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
      env[key] = value;
    }
    overrides.env = env;
  }
  // Reuse the session-directory containment check: a created session may adopt
  // an existing file (an orchestration worker writes its header before start),
  // but never a path outside Pi's session storage.
  if (body.sessionFile !== undefined) overrides.sessionFile = resolveSessionFile(String(body.sessionFile));
  return overrides;
}

function appendSessionName(filePath: string, name: string) {
  const resolved = resolveSessionFile(filePath);
  fs.appendFileSync(resolved, JSON.stringify({ type: 'session_info', name, timestamp: new Date().toISOString() }) + '\n');
  return resolved;
}

function updateLiveSessionName(session: PiRpcSession | null | undefined, name: string) {
  if (!session) return;
  session.sessionName = name;
  session.titleSet = true;
  liveManager.broadcast({ type: 'event', sessionId: session.id, event: { type: 'session_name', name } });
  liveManager.broadcastUpdated(session.id);
}

function isWithinPath(root: string, target: string) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveLiveSessionPath(session: PiRpcSession | null | undefined, requestedPath?: string | null) {
  if (!session) {
    const err = new Error('Live session not found') as StatusError;
    err.status = 404;
    throw err;
  }
  const root = fs.realpathSync(path.resolve(session.cwd));
  const candidate = path.resolve(expandHome(requestedPath || session.cwd));
  let resolved = candidate;
  try { resolved = fs.realpathSync(candidate); } catch {}
  if (!isWithinPath(root, resolved)) {
    const err = new Error('Path is outside the active session directory') as StatusError;
    err.status = 403;
    throw err;
  }
  return resolved;
}

function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('Invalid URL'));
  if (process.platform === 'win32') {
    spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
    return Promise.resolve();
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise<void>((resolve, reject) => {
    execFile(opener, [url], (err: ExecException | null) => err ? reject(err) : resolve());
  });
}

// Fire-and-forget: refresh session.model/thinkingLevel from pi's get_state.
// Used after prompt/steer/follow_up acks so extension-driven model/thinking
// changes (e.g. pi-session-model's /session-model) propagate to tau and all
// clients. Silently skips on failure — the next user input or snapshot resyncs.
async function refreshSessionModel(session: PiRpcSession | null | undefined) {
  if (!session || session.terminating) return;
  const resp = await session.send({ type: 'get_state' }, { timeoutMs: 5000 });
  const data = (resp && (resp.data || resp.result || resp)) as RpcCommand;
  if (!data) return;
  if (data.model !== undefined) session.model = normalizeModel(data.model);
  if (data.thinkingLevel) session.thinkingLevel = String(data.thinkingLevel);
  liveManager.broadcastUpdated(session.id);
}

async function handleRpcCommand(command: RpcCommand): Promise<RpcResponse> {
  const id = command.id;
  const cmd = command.type;
  const success = (data?: unknown): RpcResponse => ({ type: 'response', command: cmd, success: true, id, ...(data !== undefined ? { data } : {}) });
  const error = (message: string): RpcResponse => ({ type: 'response', command: cmd, success: false, error: message, id });

  // Backend-local commands do not require a live Pi child.
  if (cmd === 'get_auth') return success({ configured: AUTH_CONFIGURED, enabled: authEnabled });
  if (cmd === 'set_auth') {
    if (!AUTH_CONFIGURED) return error('No credentials configured. Set tau.user and tau.pass in settings.json');
    const wasEnabled = authEnabled;
    authEnabled = !!command.enabled;
    saveTauSetting('authEnabled', authEnabled);
    liveManager.broadcast({ type: 'event', event: { type: 'auth_changed', enabled: authEnabled } });
    if (!wasEnabled && authEnabled) {
      const timer = setTimeout(() => {
        for (const client of Array.from(liveManager.clients)) {
          try { client.close(4001, 'Authentication enabled'); } catch {}
        }
      }, 25);
      timer.unref?.();
    }
    return success({ enabled: authEnabled });
  }
  if (cmd === 'get_available_models') return success({ models: await getAvailableModels() });
  if (cmd === 'set_session_name') {
    const name = (command.name || '').trim();
    if (!name) return error('Name cannot be empty');
    const session = command.sessionId ? liveManager.get(command.sessionId) : null;
    let resolvedFile = null;
    const targetFile = command.filePath || session?.sessionFile;
    if (targetFile) {
      try { resolvedFile = appendSessionName(targetFile, name); } catch (e) { return error(errorMessage(e)); }
    }
    const matchingLive = resolvedFile
      ? Array.from(liveManager.sessions.values()).find((s) => s.sessionFile && path.resolve(s.sessionFile) === resolvedFile)
      : null;
    if (session) updateLiveSessionName(session, name);
    else if (matchingLive) updateLiveSessionName(matchingLive, name);
    else if (!resolvedFile) return error('sessionId or filePath required');
    return success({ name });
  }

  const session = command.sessionId ? liveManager.get(command.sessionId) : null;
  // Backend-local: move the session-tree leaf to an earlier entry (pi's
  // native RPC protocol has no leaf-move command, so tau drives the bundled
  // /tau-tree-navigate extension command in-process — see src/server/tree.ts).
  if (cmd === 'navigate_tree') {
    if (!session) return error('Live session not found');
    const entryId = typeof command.entryId === 'string' ? command.entryId.trim() : '';
    if (!entryId) return error('entryId required');
    try {
      const result = await navigateTree(session, entryId);
      return success({ editorText: result.editorText });
    } catch (e) { return error(errorMessage(e)); }
  }
  if (cmd === 'export_html') {
    try {
      if (command.sessionId && !session) throw new Error('Live session not found');
      const sf = command.filePath ? resolveSessionFile(command.filePath) : session?.sessionFile;
      if (!sf) throw new Error('No session file to export yet');
      const args = ['--export', sf];
      if (command.outputPath) args.push(resolveExportOutputPath(command.outputPath, sf));
      const output = await new Promise<string>((resolve, reject) => {
        execFile('pi', args, { cwd: session?.cwd || path.dirname(sf), timeout: 30000, encoding: 'utf8' }, (err: ExecException | null, stdout: string, stderr: string) => {
          if (err) reject(new Error(stderr || err.message)); else resolve(stdout);
        });
      });
      let result = output.trim().split('\n').pop() || sf.replace(/\.jsonl$/, '.html');
      result = path.resolve(expandHome(result));
      if (!fs.existsSync(result)) result = sf.replace(/\.jsonl$/, '.html');
      return success({ path: result });
    } catch (e) { return error(errorMessage(e)); }
  }

  if (!session) return error('No active Tau session. Create or select an in-page Tau tab first.');

  if (cmd === 'get_state') {
    return success({
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      autoCompactionEnabled: true,
    });
  }
  if (cmd === 'get_messages') return success({ entries: session.entries });
  if (cmd === 'live_session_snapshot_request') return { type: 'live_session_snapshot', sessionId: session.id, ...session.snapshot() };
  if (cmd === 'set_auto_compaction') return success({ enabled: !!command.enabled });

  const native = new Set(['prompt', 'steer', 'follow_up', 'abort', 'compact', 'set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'get_session_stats', 'get_tree', 'get_entries', 'extension_ui_response']);
  if (!native.has(cmd ?? '')) return error(`Unknown command: ${cmd}`);

  // While navigate_tree is moving the child's leaf (pi's stdin loop does not
  // serialize a new prompt behind a running extension command), a prompt
  // racing into that window could land its entries on the branch being
  // abandoned. Refuse it up front so the user's turn is never dropped or
  // misplaced without them knowing.
  if ((cmd === 'prompt' || cmd === 'steer' || cmd === 'follow_up') && isTreeNavigationInProgress(session.id)) {
    return error('A session-tree navigation is in progress for this session; wait a moment and send again');
  }

  // `set_thinking_level` is forwarded to pi but pi's response carries no
  // level/thinkingLevel field, so updateStateFromResponse would never update
  // session.thinkingLevel — yet touch(true)->broadcastUpdated would echo the
  // stale level to all clients (reverting a client's just-set optimistic
  // level). Record the level optimistically here and restore on pi failure.
  const isSetThinkingLevel = cmd === 'set_thinking_level';
  let prevThinkingLevel: string | null = null;
  if (isSetThinkingLevel) {
    prevThinkingLevel = session.thinkingLevel;
    if (command.level) session.thinkingLevel = command.level;
  }

  try {
    const resp = await session.send(command, { timeoutMs: cmd === 'prompt' ? 10000 : 60000 });
    if (isSetThinkingLevel && resp.success === false && prevThinkingLevel !== null) {
      session.thinkingLevel = prevThinkingLevel;
    }
    // Extension-driven model/thinking changes (e.g. the pi-session-model
    // `/session-model` slash command) call pi.setModel/pi.setThinkingLevel
    // inside a prompt/steer/follow_up. Those acks carry no model data and emit
    // no runtime stream event, so tau would stay stale. Fire-and-forget a
    // get_state refresh so tau and all clients learn the new model/level. Do
    // NOT block this HTTP response — return the original ack first.
    if (resp.success !== false && (cmd === 'prompt' || cmd === 'steer' || cmd === 'follow_up')) {
      refreshSessionModel(session).catch(() => {});
    }
    return { ...resp, success: resp.success !== false };
  } catch (e) {
    if (isSetThinkingLevel && prevThinkingLevel !== null) session.thinkingLevel = prevThinkingLevel;
    // Some commands are ack-less fire-and-forget in practice; keep UX moving
    // only when the write succeeded and the child simply did not acknowledge.
    const isAckTimeout = /^RPC command timed out:/.test(errorMessage(e));
    if (isAckTimeout && (cmd === 'prompt' || cmd === 'abort' || cmd === 'extension_ui_response')) return success();
    return error(errorMessage(e));
  }
}

function serveStaticFile(req: IncomingMessage, res: ServerResponse) {
  let urlPath = req.url || '/';
  const auth = checkAuth(req);
  if (authEnabled && !urlPath.startsWith('/api/health') && !auth.ok) return sendAuthRequired(res, req);
  maybeSetSessionCookie(req, res, auth);
  if (urlPath.startsWith('/api/')) return handleApiRoute(req, res, urlPath);
  urlPath = urlPath.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  const staticRoot = path.resolve(STATIC_DIR);
  const filePath = path.resolve(path.join(staticRoot, decodedPath));
  if (filePath !== staticRoot && !filePath.startsWith(staticRoot + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, (err: NodeJS.ErrnoException | null, stats: Stats) => {
    if (err || !stats.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': (MIME_TYPES as Record<string, string>)[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function isAllowedApiOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function setCorsForAllowedOrigin(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!isAllowedApiOrigin(req)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

function handleApiRoute(req: IncomingMessage, res: ServerResponse, urlPath: string) {
  const originAllowed = setCorsForAllowedOrigin(req, res);
  if (req.method === 'OPTIONS') {
    if (!originAllowed) return json(res, 403, { error: 'Origin not allowed' });
    res.writeHead(200);
    res.end();
    return;
  }
  if (!originAllowed) return json(res, 403, { error: 'Origin not allowed' });

  const parsed = new URL(`http://localhost${req.url}`);
  const cleanPath = parsed.pathname;

  if (cleanPath === '/api/health') return json(res, 200, { status: 'ok', role: 'rpc-session-manager', liveSessionCount: liveManager.sessions.size, lanUrl, tailscaleUrl: tailscaleUrl || undefined, platform: process.platform });
  if (cleanPath === '/api/live-sessions' && req.method === 'GET') return json(res, 200, { sessions: liveManager.list() });
  if (cleanPath === '/api/live-sessions' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      if (!body.cwd) return json(res, 400, { error: 'cwd required' });
      let overrides: { args?: string[]; env?: Record<string, string>; sessionFile?: string };
      try {
        overrides = parseSpawnOverrides(body);
      } catch (e) { return json(res, 400, { error: errorMessage(e) }); }
      try {
        const session = await liveManager.create({ cwd: body.cwd, model: body.model || '', ...overrides });
        json(res, 200, { session: session.metadata() });
      } catch (e) { json(res, 400, { error: errorMessage(e) }); }
    }).catch((e) => json(res, 400, { error: errorMessage(e) }));
    return;
  }
  if (cleanPath === '/api/live-sessions/resume' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      if (!body.filePath || typeof body.filePath !== 'string') return json(res, 400, { error: 'filePath required' });
      let resolvedFile: string;
      try { resolvedFile = resolveSessionFile(body.filePath); } catch (e) { return json(res, 400, { error: errorMessage(e) }); }
      const existing = liveManager.findBySessionFile(resolvedFile);
      if (existing) return json(res, 200, { session: existing.metadata(), reused: true });
      // Another Pi process is appending to this file. Resuming would make this
      // server a second writer on the same conversation.
      const owner = sessionOwner(resolvedFile);
      if (owner && body.force !== true) {
        return json(res, 409, {
          error: `Session is running as ${owner.name} on ${owner.host}. Follow it read-only, or resume with force to take it over.`,
          owner,
        });
      }
      let cwd: string | null = normalizeSessionCwd(body.cwd);
      if (!cwd) cwd = readSessionHeaderCwd(resolvedFile);
      if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return json(res, 400, { error: 'Cannot resume session because its project directory no longer exists' });
      }
      const entries = readSessionEntries(resolvedFile) as JsonRecord[];
      const sessionName = deriveSessionNameFromEntries(entries);
      const reusedPending = liveManager.hasPendingResume(resolvedFile);
      try {
        const session = await liveManager.resume({ sessionFile: resolvedFile, cwd, model: body.model || '', entries, sessionName });
        json(res, 200, { session: session.metadata(), ...(reusedPending ? { reused: true } : {}) });
      } catch (e) { json(res, 400, { error: errorMessage(e) }); }
    }).catch((e) => json(res, 400, { error: errorMessage(e) }));
    return;
  }
  const liveMatch = cleanPath.match(/^\/api\/live-sessions\/([^/]+)(?:\/snapshot)?$/);
  if (liveMatch) {
    let id;
    try {
      id = decodeURIComponent(liveMatch[1]);
    } catch {
      return json(res, 400, { error: 'Malformed live session id' });
    }
    const session = liveManager.get(id);
    if (!session) return json(res, 404, { error: 'Live session not found' });
    const isSnapshotRoute = cleanPath.endsWith('/snapshot');
    if (isSnapshotRoute && req.method === 'GET') return json(res, 200, session.snapshot());
    if (!isSnapshotRoute && req.method === 'DELETE') { liveManager.delete(id, 'closed_by_user').then(() => json(res, 200, { success: true })); return; }
  }

  if (cleanPath === '/api/projects' && req.method === 'GET') return serveProjectsList(res);
  if (cleanPath === '/api/sessions' && req.method === 'GET') return serveProjectSummaries(res);
  if ((cleanPath === '/api/files') && req.method === 'GET') {
    const explicitPath = parsed.searchParams.get('path');
    const sessionId = parsed.searchParams.get('sessionId');
    if (!sessionId) return json(res, 400, { error: 'No live session selected' });
    const session = liveManager.get(sessionId);
    if (!session) return json(res, 404, { error: 'Live session not found' });
    try {
      const dirPath = resolveLiveSessionPath(session, explicitPath || session.cwd);
      return serveFileList(res, dirPath);
    } catch (e) { return json(res, errorStatus(e), { error: errorMessage(e) }); }
  }
  if (cleanPath === '/api/file/preview' && req.method === 'GET') {
    const sessionId = parsed.searchParams.get('sessionId');
    if (!sessionId) return json(res, 400, { error: 'No live session selected' });
    const session = liveManager.get(sessionId);
    if (!session) return json(res, 404, { error: 'Live session not found' });
    try {
      const filePath = resolveLiveSessionPath(session, parsed.searchParams.get('path'));
      return serveFilePreview(res, filePath);
    } catch (e) { return json(res, errorStatus(e), { error: errorMessage(e) }); }
  }
  if (cleanPath === '/api/open' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const filePath = resolveOpenPath(body);
        return openNative(filePath)
          .then(() => json(res, 200, { ok: true }))
          .catch((e) => json(res, 500, { error: errorMessage(e) }));
      } catch (e) {
        return json(res, errorStatus(e), { error: errorMessage(e) });
      }
    }).catch((e) => json(res, 400, { error: errorMessage(e) }));
    return;
  }
  if (cleanPath === '/api/rpc' && req.method === 'POST') {
    readBody(req).then((body) => handleRpcCommand(body).then((resp) => json(res, 200, resp))).catch((e) => json(res, 400, { error: errorMessage(e) }));
    return;
  }
  if (cleanPath === '/api/sessions/delete' && req.method === 'POST') {
    readBody(req).then((body) => {
      if (!body.filePath || typeof body.filePath !== 'string') return json(res, 400, { error: 'filePath required' });
      const sessionFile = resolveSessionFile(body.filePath);
      fs.unlinkSync(sessionFile);
      json(res, 200, { success: true });
    }).catch((e) => json(res, 400, { error: errorMessage(e) }));
    return;
  }
  const projectMatch = cleanPath.match(/^\/api\/sessions\/([^/]+)$/);
  if (projectMatch && req.method === 'GET') return serveProjectSessions(res, projectMatch[1]);
  const sessionMatch = cleanPath.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
  if (sessionMatch && req.method === 'GET') return serveSessionFile(res, sessionMatch[1], sessionMatch[2], parsed.searchParams.get('since'));

  json(res, 404, { error: 'Not found' });
}

function liveFilesSet() {
  return new Set(liveManager.list().map((s) => s.sessionFile).filter(Boolean));
}

function normalizeSessionCwd(cwd: unknown) {
  return typeof cwd === 'string' && cwd.trim() ? path.resolve(expandHome(cwd)) : null;
}

function readSessionEntries(filePath: string): unknown[] {
  const entries: unknown[] = [];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
    }
  } catch { /* file may not exist yet */ }
  return entries;
}

function deriveSessionNameFromEntries(entries: JsonRecord[]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: string; name?: unknown };
    const name = typeof e?.name === 'string' ? e.name.trim() : '';
    if (e?.type === 'session_info' && name && !isGenericSessionName(name)) return name;
  }
  for (const entry of entries) {
    const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (e?.type !== 'message' || e.message?.role !== 'user') continue;
    const title = titleFromMessageContent(e.message.content);
    if (title) return title;
  }
  return null;
}

function titleFromMessageContent(content: unknown) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((b): b is { type?: unknown; text?: unknown } => !!b && typeof b === 'object')
      .filter((b) => b.type === 'text')
      .map((b) => typeof b.text === 'string' ? b.text : '')
      .join('\n');
  }
  let title = text.replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, '').replace(/\n.*/s, '').trim();
  if (!title) return null;
  const sentenceEnd = title.search(/[.!?]\s/);
  if (sentenceEnd > 10 && sentenceEnd < 80) title = title.slice(0, sentenceEnd);
  if (title.length > 60) title = title.slice(0, 57).replace(/\s+\S*$/, '') + '…';
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title || null;
}

function readSessionHeaderCwd(filePath: string) {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry?.type === 'session') return normalizeSessionCwd(entry.cwd);
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return null;
}

function serveProjectsList(res: ServerResponse) {
  const projectsDir = TAU_SETTINGS.projectsDir;
  if (!projectsDir || !fs.existsSync(projectsDir)) return json(res, 200, { projects: [], ...(projectsDir ? { error: 'Directory not found' } : {}) });
  try {
    const projectsRoot = path.resolve(projectsDir);
    const sessionInfo = new Map<string, { count: number; lastActive: number }>();
    for (const project of projectSummaries()) {
      if (!project.path || !isWithinPath(projectsRoot, project.path)) continue;
      sessionInfo.set(project.path, { count: project.count, lastActive: project.lastActive });
    }
    const liveCwds = new Set(liveManager.list().map((s) => s.cwd));
    const projects = fs.readdirSync(projectsRoot, { withFileTypes: true })
      .filter((e: Dirent) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e: Dirent) => {
        const fullPath = path.join(projectsRoot, e.name);
        const info = sessionInfo.get(fullPath) || { count: 0, lastActive: 0 };
        return { name: e.name, path: fullPath, sessionCount: info.count, lastActive: info.lastActive || null, active: liveCwds.has(fullPath) };
      });
    json(res, 200, { projects });
  } catch (e) { json(res, 500, { error: errorMessage(e) }); }
}

/**
 * One project per session directory: pi derives that directory name from the
 * session cwd, so a directory is a project and its newest file carries the
 * current cwd. Listing costs a readdir and a stat per file, no transcript
 * parsing — the sidebar loads a project's sessions only when it is expanded.
 */
function projectSummaries() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const projects: Array<{ path: string; dirName: string; count: number; lastActive: number }> = [];
  for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(SESSIONS_DIR, dir.name);
    let count = 0, lastActive = 0, newest = '';
    for (const file of fs.readdirSync(projectDir)) {
      if (!file.endsWith('.jsonl')) continue;
      count++;
      const mtime = fs.statSync(path.join(projectDir, file)).mtimeMs;
      if (mtime >= lastActive) { lastActive = mtime; newest = file; }
    }
    if (!count) continue;
    projects.push({ path: readSessionHeaderCwd(path.join(projectDir, newest)) || '', dirName: dir.name, count, lastActive });
  }
  projects.sort((a, b) => b.lastActive - a.lastActive);
  return projects;
}

function serveProjectSummaries(res: ServerResponse) {
  try {
    json(res, 200, { projects: projectSummaries() });
  } catch (e) { json(res, 500, { error: errorMessage(e) }); }
}

function serveProjectSessions(res: ServerResponse, dirName: string) {
  try {
    const projectDir = path.join(SESSIONS_DIR, dirName);
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) return json(res, 404, { error: 'Project not found' });
    const liveFiles = liveFilesSet();
    const owners = sessionOwners();
    const sessions = fs.readdirSync(projectDir)
      .filter((file: string) => file.endsWith('.jsonl'))
      .map((file: string) => {
        const filePath = path.join(projectDir, file);
        return {
          ...readSessionSummary(filePath), file, dir: dirName, filePath,
          live: liveFiles.has(filePath), owner: owners.get(filePath) ?? null,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    json(res, 200, { sessions });
  } catch (e) { json(res, 500, { error: errorMessage(e) }); }
}

/** Bytes read from each end of a transcript to summarise it for the sidebar. */
const SUMMARY_WINDOW = 64 * 1024;

/**
 * Summarises one stored session without reading it whole: the header and the
 * first user message are at the start of the file, and a rename is appended at
 * the end, so sampling both ends is enough for everything the sidebar shows.
 * Transcripts here reach tens of megabytes, and a project holds thousands.
 */
function readSessionSummary(filePath: string) {
  const { size, mtimeMs } = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  let head: string, tail = '';
  try {
    head = readWindow(fd, 0, Math.min(size, SUMMARY_WINDOW));
    if (size > SUMMARY_WINDOW) tail = readWindow(fd, size - SUMMARY_WINDOW, SUMMARY_WINDOW);
  } finally {
    fs.closeSync(fd);
  }
  // A window cuts mid-line at the end of the head and the start of the tail;
  // those partial records are dropped rather than parsed.
  const headLines = head.split(/\r?\n/);
  if (size > SUMMARY_WINDOW) headLines.pop();
  const tailLines = tail.split(/\r?\n/).slice(1);

  let id = '', timestamp = '', name: string | null = null, firstMessage: string | null = null;
  for (const line of headLines.concat(tailLines)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'session') { id = entry.id || ''; timestamp = entry.timestamp || ''; }
    else if (entry.type === 'session_info' && entry.name) name = entry.name;
    else if (!firstMessage && entry.type === 'message' && entry.message?.role === 'user') {
      firstMessage = titleFromMessageContent(entry.message.content);
    }
  }
  return { id, timestamp, name, firstMessage, mtime: mtimeMs };
}

function readWindow(fd: number, position: number, length: number) {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buffer, 0, length, position);
  return buffer.toString('utf8', 0, bytesRead);
}

/**
 * Reads a stored session. `since` is a byte offset from a previous read, so a
 * follower polls only the entries appended since then; a file that shrank or
 * was rewritten answers from the start with `reset`, because its earlier bytes
 * no longer describe the same conversation.
 */
function serveSessionFile(res: ServerResponse, dirName: string, file: string, since: string | null) {
  const filePath = path.join(SESSIONS_DIR, dirName, file);
  if (!fs.existsSync(filePath)) return json(res, 404, { error: 'Session not found' });
  const size = fs.statSync(filePath).size;
  const requested = since === null ? 0 : Number(since);
  if (!Number.isInteger(requested) || requested < 0) return json(res, 400, { error: 'since must be a byte offset' });
  const reset = requested > size;
  const start = reset ? 0 : requested;
  const entries: unknown[] = [];
  if (start >= size) return json(res, 200, { entries, offset: size, reset });
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', start });
  let buffer = '';
  // Whole lines only: the last partial line stays unread until its newline
  // arrives, so the next poll starts at a record boundary.
  let consumed = start;
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop() || '';
    for (const line of lines) {
      consumed += Buffer.byteLength(line) + 1;
      if (line.trim()) { try { entries.push(JSON.parse(line)); } catch {} }
    }
  });
  stream.on('end', () => json(res, 200, { entries, offset: consumed, reset }));
  stream.on('error', (e: Error) => json(res, 500, { error: e.message }));
}

const IGNORED_NAMES = new Set(['node_modules', '.git', '__pycache__', '.DS_Store', '.Trash', '.next', '.nuxt', 'dist', 'build', '.cache', '.turbo', 'venv', '.venv', 'env', '.env.local', '.pi', 'coverage', '.nyc_output', '.parcel-cache']);
function serveFileList(res: ServerResponse, dirPath: string) {
  try {
    dirPath = path.resolve(expandHome(dirPath));
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return json(res, 400, { error: 'Not a directory' });
    const items = [];
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      if (IGNORED_NAMES.has(entry.name)) continue;
      try {
        const fullPath = path.join(dirPath, entry.name);
        const stat = fs.statSync(fullPath);
        items.push({ name: entry.name, path: fullPath, isDirectory: entry.isDirectory(), size: entry.isDirectory() ? null : stat.size, mtime: stat.mtimeMs });
      } catch {}
    }
    items.sort((a, b) => a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name));
    json(res, 200, { path: dirPath, items });
  } catch (e) { json(res, 500, { error: errorMessage(e) }); }
}

function serveFilePreview(res: ServerResponse, filePath: string) {
  if (!filePath) return json(res, 400, { error: 'path required' });
  const mimes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };
  const mime = mimes[path.extname(filePath).toLowerCase().slice(1)];
  if (!mime) return json(res, 415, { error: 'Not a previewable image' });
  try {
    if (!fs.statSync(filePath).isFile()) throw new Error('Not a file');
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=60' });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) { json(res, 404, { error: errorMessage(e) }); }
}

function resolveExportedSessionPath(filePath: string) {
  const resolved = path.resolve(expandHome(filePath || ''));
  const root = path.resolve(SESSIONS_DIR);
  if (!resolved.startsWith(root + path.sep) || path.extname(resolved).toLowerCase() !== '.html') {
    const err = new Error('Can only open exported session HTML without a live session') as StatusError;
    err.status = 403;
    throw err;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    const err = new Error('File not found') as StatusError;
    err.status = 404;
    throw err;
  }
  return resolved;
}

function resolveExportOutputPath(outputPath: string, sessionFile: string) {
  if (!outputPath || typeof outputPath !== 'string') throw new Error('outputPath required');
  const sessionDir = path.dirname(path.resolve(sessionFile));
  const sessionDirReal = fs.realpathSync(sessionDir);
  const expanded = expandHome(outputPath);
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(sessionDir, expanded);
  if (!isWithinPath(sessionDir, resolved) || path.extname(resolved).toLowerCase() !== '.html') {
    const err = new Error('Export outputPath must be an .html file in the session directory') as StatusError;
    err.status = 403;
    throw err;
  }
  const parentDir = path.dirname(resolved);
  let parentReal;
  try { parentReal = fs.realpathSync(parentDir); } catch {
    const err = new Error('Export output directory not found') as StatusError;
    err.status = 404;
    throw err;
  }
  if (!isWithinPath(sessionDirReal, parentReal) || (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink())) {
    const err = new Error('Export outputPath must stay inside the session directory') as StatusError;
    err.status = 403;
    throw err;
  }
  return resolved;
}

function resolveOpenPath(body: RpcCommand) {
  if (!body?.filePath || typeof body.filePath !== 'string') throw new Error('filePath required');
  if (body.sessionId) {
    const session = liveManager.get(body.sessionId);
    const resolved = resolveLiveSessionPath(session, body.filePath);
    if (!fs.existsSync(resolved)) {
      const err = new Error('File not found') as StatusError;
      err.status = 404;
      throw err;
    }
    return resolved;
  }
  return resolveExportedSessionPath(body.filePath);
}

async function openNative(fp: string) {
  if (!fp || typeof fp !== 'string') throw new Error('filePath required');
  const resolved = path.resolve(expandHome(fp));
  if (!fs.existsSync(resolved)) throw new Error('File not found');
  if (process.platform === 'win32') {
    spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    execFile('open', [resolved], () => {});
  } else {
    execFile('xdg-open', [resolved], () => {});
  }
}

function computeUrls(port: number) {
  const isLoopback = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';
  let localIp = 'localhost';
  let tailscaleIp = '';
  if (!isLoopback) {
    const nets = os.networkInterfaces();
    for (const name of ['en0', 'en1', 'wlan0', 'eth0']) {
      for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break; }
      if (localIp !== 'localhost') break;
    }
    if (localIp === 'localhost') {
      outer: for (const name of Object.keys(nets)) {
        if (/^(bridge|utun|lo)/.test(name)) continue;
        for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break outer; }
      }
    }
    for (const name of Object.keys(nets)) for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal && net.address.startsWith('100.')) tailscaleIp = net.address;
  }
  lanUrl = `http://${localIp}:${port}`;
  tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${port}` : '';
}

const server = http.createServer(serveStaticFile);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
  if (!isAllowedApiOrigin(request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (authEnabled && !checkAuth(request).ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Tau"\r\n\r\n');
    socket.destroy();
    return;
  }
  if (request.url === '/ws') wss.handleUpgrade(request, socket, head, (ws: TauWs) => wss.emit('connection', ws, request));
  else socket.destroy();
});

wss.on('connection', (ws: TauWs) => {
  liveManager.addClient(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'state', liveSessions: liveManager.list() }));
  ws.on('message', async (data: Buffer) => {
    try {
      const command = JSON.parse(data.toString());
      const resp = await handleRpcCommand(command);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(resp));
    } catch (e) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: errorMessage(e) }));
    }
  });
  ws.on('close', () => liveManager.removeClient(ws));
  ws.on('error', () => liveManager.removeClient(ws));
});

setInterval(() => {
  for (const client of liveManager.clients) {
    if (client.readyState !== WebSocket.OPEN) { liveManager.removeClient(client); continue; }
    if (!client.isAlive) { try { client.terminate(); } catch {} liveManager.removeClient(client); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, 20000).unref();

function listen(port: number, attemptsLeft = 10) {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`[Tau] Port ${port} in use, trying ${port + 1}...`);
      server.removeAllListeners('error');
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`[Tau] Failed to start: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    computeUrls(port);
    publishEndpoint(port);
    console.log(`[Tau] Server running on ${lanUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ''}`);
    console.log(`[Tau] Static assets: ${STATIC_DIR}`);
    if (ARGS.open) openUrl(lanUrl).catch(() => {});
  });
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Tau] Shutting down (${signal}); terminating ${liveManager.sessions.size} Pi session(s)...`);
  try { wss.close(); } catch {}
  unpublishEndpoint();
  await liveManager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500).unref();
}
function startCli() {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => {
    unpublishEndpoint();
    for (const session of liveManager.sessions.values()) {
      try { session.child?.kill('SIGTERM'); } catch {}
    }
  });
  process.on('uncaughtException', (err) => { console.error(err); shutdown('uncaughtException'); });
  process.on('unhandledRejection', (err) => { console.error(err); });
  listen(PORT);
}

// Test-only helper to reset module-level auth state between cases.
function _setAuthForTest(enabled: boolean) { authEnabled = !!enabled; }

// Test-only helpers for the session-cookie flow: mutate the live credentials
// (tokens embed a credential fingerprint) and mint tokens at chosen expiries.
function _setCredentialsForTest(user: string, pass: string) { TAU_SETTINGS.user = user; TAU_SETTINGS.pass = pass; }
function _issueSessionTokenForTest(expiresAtSeconds?: number) { return issueSessionToken(expiresAtSeconds); }

// Test-only hook to substitute the `pi` spawn so LiveSessionManager.create()
// can be exercised without launching a real Pi process.

export {
  parseArgs,
  expandHome,
  loadTauSettings,
  modelLabel,
  normalizeModel,
  parseModelSpecToModel,
  parsePiListModels,
  getAvailableModels,
  makeId,
  PiRpcSession,
  LiveSessionManager,
  liveManager,
  resolveSessionFile,
  appendSessionName,
  updateLiveSessionName,
  isWithinPath,
  resolveLiveSessionPath,
  resolveExportOutputPath,
  resolveExportedSessionPath,
  resolveOpenPath,
  openUrl,
  handleRpcCommand,
  NAVIGATE_COMMAND,
  NAVIGATION_MARKER_TYPE,
  flattenTree,
  isTreeNavigationInProgress,
  leafDescendsFrom,
  navigateTree,
  pathFromRoot,
  selectNavigationTarget,
  buildEndpoint,
  orchestrationEndpoint,
  parseSpawnOverrides,
  sessionOwner,
  sessionOwners,
  isAllowedApiOrigin,
  setCorsForAllowedOrigin,
  handleApiRoute,
  serveStaticFile,
  server,
  wss,
  computeUrls,
  listen,
  startCli,
  SESSIONS_DIR,
  PI_AGENT_DIR,
  checkAuth,
  SESSION_COOKIE_NAME,
  _setAuthForTest,
  _setCredentialsForTest,
  _issueSessionTokenForTest,
  _setSpawnPiForTest,
  _setExecFileForTest,
  _clearModelListCacheForTest,
};
