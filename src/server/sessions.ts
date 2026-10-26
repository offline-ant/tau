import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

import type { ChildProcess } from 'node:child_process';
import type { JsonRecord, LiveClient, ModelIdentity, PendingCommand, RpcCommand, RpcResponse, SessionSpawnOverrides } from './types.js';
import { expandHome } from './config.js';
import { readSessionHeader } from './session-header.js';
import { orchestrationEndpoint } from './orchestration.js';
import { modelLabel, normalizeModel, parseModelSpecToModel } from './model-utils.js';
import { NAVIGATE_COMMAND, flattenTree, isTreeNavigationInProgress, pathFromRoot, type SessionTreeNodeLike } from './tree.js';

type SpawnFn = (cmd: string, args: string[], opts: JsonRecord) => ChildProcess;
type PiMessageContent = string | Array<{ type: string; text?: string }>;
type PiMessage = { role?: string; content?: PiMessageContent; usage?: JsonRecord; model?: string };
type PiRpcPayload = {
  command?: string;
  id?: string;
  provider?: string;
  model?: unknown;
  thinkingLevel?: string;
  level?: string;
  sessionFile?: string;
  sessionName?: string;
  name?: string;
  contextUsage?: JsonRecord;
  tokens?: JsonRecord;
  [key: string]: unknown;
};
type PiRpcMessage = PiRpcPayload & {
  type?: string;
  success?: boolean;
  data?: PiRpcPayload;
  result?: PiRpcPayload;
  message?: PiMessage;
  entry?: JsonRecord;
};

export function makeId() {
  return `tau_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// tau's bundled pi extension (registers the /tau-tree-navigate command used
// by navigate_tree — see src/server/tree.ts). The compiled server runs from
// bin/, while the extension ships as source under src/pi-extension/ because
// pi loads extension .ts files directly.
const TAU_TREE_EXTENSION = path.resolve(import.meta.dirname, '..', 'src', 'pi-extension', 'tau-tree.ts');

/** Bound on retained child stderr; startup diagnostics are short. */
const STDERR_TAIL_LINES = 20;
const INPUT_COMMANDS = new Set(['prompt', 'steer', 'follow_up']);

export function isGenericSessionName(name: unknown) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized === 'chat' || normalized === 'new chat' || normalized === 'untitled' || normalized === 'untitled chat' || normalized === 'session';
}

/** A failed spawn/cleanup reports whether reopening the file is safe. */
export class SessionLifecycleError extends Error {
  readonly sessionId: string;
  readonly childStopped: boolean;
  constructor(message: string, sessionId: string, childStopped: boolean) {
    super(message);
    this.sessionId = sessionId;
    this.childStopped = childStopped;
  }
}

export class PiRpcSession {
  manager: LiveSessionManager;
  id: string;
  cwd: string;
  modelSpec: string;
  child: ChildProcess | null;
  pid: number | null;
  createdAt: string;
  lastActiveAt: string;
  isStreaming: boolean;
  entries: JsonRecord[];
  model: ModelIdentity | null;
  thinkingLevel: string;
  sessionFile: string | null;
  sessionName: string | null;
  contextUsage: JsonRecord | null;
  /** Extra `pi` arguments supplied by a programmatic caller, appended after tau's own. */
  extraArgs: string[];
  /** Extra child environment supplied by a programmatic caller; overrides tau's defaults. */
  extraEnv: Record<string, string>;
  pending: Map<string, PendingCommand>;
  // A slash command can temporarily replace its session and then roll back.
  // Keep its original file associated with this child until post-command state
  // is confirmed, even if the caller times out or observes the temporary file.
  private inputSessionFiles = new Map<string, string>();
  // A handled extension command may replace the entire runtime. Snapshot readers
  // and the actual command response wait for its authoritative state and history.
  private inputSynchronization: Promise<void> = Promise.resolve();
  // Timeouts stop waiting, not execution. Keep mutating commands busy until
  // their actual acknowledgement so refresh cannot cancel an unknown operation.
  private activeCommands = new Set<string>();
  refreshing = false;
  private runActive = false;
  stdoutBuffer: string;
  /** Recent child stderr, so an exit can say why instead of only reporting its code. */
  stderrTail: string[];
  terminating: boolean;
  exitCode: number | null;
  exited = false;
  private termination: Promise<void> | null = null;
  titleSet: boolean;
  userMessages: string[];
  /** Last extension_error event from the child; navigate_tree reads this to explain a failed leaf move. */
  lastExtensionError: string | null;
  /** Whether navigateTree has confirmed this child loaded tau's tree extension (reset per spawn). */
  navigateCommandChecked: boolean;

  constructor(manager: LiveSessionManager, opts: { id?: string; cwd: string; modelSpec?: string; sessionFile?: string | null; entries?: JsonRecord[]; sessionName?: string | null } & SessionSpawnOverrides) {
    this.manager = manager;
    this.id = opts.id || makeId();
    this.cwd = opts.cwd;
    this.modelSpec = opts.modelSpec || '';
    this.child = null;
    this.pid = null;
    this.createdAt = new Date().toISOString();
    this.lastActiveAt = this.createdAt;
    this.isStreaming = false;
    this.entries = [];
    const parsed = parseModelSpecToModel(this.modelSpec);
    this.model = parsed.model;
    this.thinkingLevel = parsed.level || 'off';
    this.sessionFile = opts.sessionFile || null;
    this.sessionName = opts.sessionName || null;
    this.extraArgs = opts.args ? [...opts.args] : [];
    this.extraEnv = opts.env ? { ...opts.env } : {};
    if (opts.entries && opts.entries.length) this.entries = opts.entries;
    this.contextUsage = null;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.stderrTail = [];
    this.terminating = false;
    this.exitCode = null;
    this.titleSet = false;
    this.userMessages = [];
    this.lastExtensionError = null;
    this.navigateCommandChecked = false;
  }

  metadata() {
    return {
      id: this.id,
      pid: this.pid,
      cwd: this.cwd,
      modelSpec: this.modelSpec,
      model: this.model,
      modelLabel: modelLabel(this.model, this.modelSpec),
      thinkingLevel: this.thinkingLevel,
      sessionFile: this.sessionFile,
      sessionName: this.sessionName,
      isStreaming: this.isStreaming,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      contextUsage: this.contextUsage,
    };
  }

  async snapshot() {
    try {
      await this.inputSynchronization;
    } catch {
      // A failed rebuild must not poison every later reader. Ask the child
      // again instead of serving a cache whose conversation is unconfirmed.
      this.inputSynchronization = this.inputSynchronization.catch(() => {}).then(() => this.synchronizeInput(true));
      await this.inputSynchronization;
    }
    return this.currentSnapshot();
  }

  private currentSnapshot() {
    return {
      session: this.metadata(),
      entries: this.entries,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.isStreaming,
      sessionFile: this.sessionFile,
      sessionName: this.sessionName,
      contextUsage: this.contextUsage,
    };
  }

  async start() {
    const expectedFile = this.sessionFile;
    try {
      if (!fs.existsSync(this.cwd) || !fs.statSync(this.cwd).isDirectory()) {
        throw new Error(`Directory not found: ${this.cwd}`);
      }
      const args = ['--mode', 'rpc', '--extension', TAU_TREE_EXTENSION];
      if (expectedFile) args.push('--session', expectedFile);
      if (this.modelSpec) args.push('--model', this.modelSpec);
      args.push(...this.extraArgs);
      this.navigateCommandChecked = false;
      const spawnFn: SpawnFn = _spawnPiForTest || spawn;
      const endpoint = orchestrationEndpoint();
      const env = { ...process.env };
      // The server may have been launched inside a terminal Pi. A new Tau tab
      // is not that pane or its managed worker; explicit spawn overrides below
      // can still provide a new worker identity.
      for (const key of ['PI_NESTED', 'PI_ORCHESTRATION_TARGET', 'PI_ORCHESTRATION_CONTROL',
        'PI_ORCHESTRATION_HOST', 'PI_ORCHESTRATION_ENDPOINT', 'HERDR_ENV',
        'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID', 'TMUX', 'TMUX_PANE']) delete env[key];
      const child = spawnFn('pi', args, {
        cwd: this.cwd,
        env: { ...env, TAU_DISABLED: '1', PI_ORCHESTRATION_HOST: 'web',
          ...(endpoint ? { PI_ORCHESTRATION_ENDPOINT: endpoint } : {}), ...this.extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.pid = child.pid || null;
      child.stdin!.on('error', (error: Error) => this.rejectPending(error));
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => this.handleStdout(chunk));
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
          console.error(`[Pi ${this.id}] ${line}`);
          this.stderrTail.push(line);
          if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
        }
      });
      child.on('error', (err: Error) => {
        // A failed spawn has no child to reap. A later kill/write error does
        // not prove process exit, so keep ownership until an actual exit.
        if (!child.pid) this.handleExit(null, null, err);
        else this.rejectPending(err);
      });
      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => this.handleExit(code, signal));
      const state = await this.send({ type: 'get_state' }, { timeoutMs: 30000 });
      if (state.success !== true) throw new Error(`Pi startup state failed: ${state.error || 'unsuccessful response'}`);
      const data = state.data as PiRpcPayload | undefined;
      if (!data || (expectedFile && (typeof data.sessionFile !== 'string' || path.resolve(data.sessionFile) !== path.resolve(expectedFile)))) {
        throw new Error('Pi did not load the requested session file');
      }
      if (expectedFile) {
        // The file contains every branch; only the child's selected path is
        // the resumed conversation. Retain file-header metadata separately.
        await this.loadActiveHistory(this.entries.find((entry) => entry.type === 'session'));
      }
      if (this.exited || this.terminating) throw new Error('Pi exited or was closed during startup');
      this.send({ type: 'get_session_stats' }, { timeoutMs: 5000 }).catch(() => {});
    } catch (error) {
      if (expectedFile) this.sessionFile = expectedFile;
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.terminate('startup_failed');
      } catch (cleanup) {
        throw new SessionLifecycleError(`${message}; ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`, this.id, false);
      }
      throw new SessionLifecycleError(message, this.id, true);
    }
  }

  async refresh(sessionFile: string) {
    const expectedFile = path.resolve(sessionFile);
    if (this.refreshing || this.isStreaming || this.runActive || this.pending.size || this.activeCommands.size || this.inputSessionFiles.size || isTreeNavigationInProgress(this.id)) {
      throw new Error('Session is busy; finish its active commands before refreshing');
    }
    if (!this.sessionFile || path.resolve(this.sessionFile) !== expectedFile) throw new Error('Session no longer has the requested file open');
    this.refreshing = true;
    try {
      const before = await this.sendCommand({ type: 'get_state' }, { timeoutMs: 30000 });
      const state = before.data as PiRpcPayload | undefined;
      if (before.success !== true || !state || typeof state.sessionFile !== 'string' || path.resolve(state.sessionFile) !== expectedFile) throw new Error('Could not confirm the current session state');
      if (this.runActive || this.isStreaming || state.isStreaming !== false || state.isCompacting !== false || state.pendingMessageCount !== 0) {
        throw new Error('Session is busy or has queued prompts; finish them before refreshing');
      }
      const switched = await this.sendCommand({ type: 'switch_session', sessionPath: expectedFile }, { timeoutMs: 30000 });
      const result = switched.data as { cancelled?: boolean } | undefined;
      if (switched.success !== true || result?.cancelled !== false) throw new Error(`Session refresh failed: ${switched.error || 'switch was cancelled or not confirmed'}`);
      const current = await this.sendCommand({ type: 'get_state' }, { timeoutMs: 30000 });
      const data = current.data as PiRpcPayload | undefined;
      if (current.success !== true || typeof data?.sessionFile !== 'string' || path.resolve(data.sessionFile) !== expectedFile) {
        throw new Error('Pi did not reload the requested session file');
      }
      if (this.runActive || data.isStreaming !== false || data.isCompacting !== false || data.pendingMessageCount !== 0) {
        throw new Error('Session became busy during refresh');
      }
      await this.loadActiveHistory(this.entries.find((entry) => entry.type === 'session'));
      if (this.exited || this.terminating) throw new Error('Pi exited or was closed during refresh');
      this.model = normalizeModel(data.model);
      this.thinkingLevel = typeof data.thinkingLevel === 'string' ? data.thinkingLevel : 'off';
      this.sessionName = typeof data.sessionName === 'string' ? data.sessionName : null;
      this.contextUsage = null;
      this.isStreaming = false;
      this.userMessages = [];
      this.titleSet = !!this.sessionName;
      this.lastExtensionError = null;
      this.navigateCommandChecked = false;
      this.manager.broadcast({ type: 'live_session_snapshot', sessionId: this.id, ...await this.snapshot() });
      this.manager.broadcastUpdated(this.id);
    } catch (error) {
      // A failed state check does not release this tab's file association.
      this.sessionFile = expectedFile;
      throw error;
    } finally {
      this.refreshing = false;
    }
  }

  send(command: RpcCommand, opts: { timeoutMs?: number } = {}) {
    if (this.refreshing && command.type !== 'extension_ui_response') return Promise.reject(new Error('Session refresh is in progress; wait a moment and send again'));
    return this.sendCommand(command, opts);
  }

  private sendCommand(command: RpcCommand, opts: { timeoutMs?: number } = {}) {
    const child = this.child;
    if (!child || !child.stdin!.writable || this.terminating || this.exited) {
      return Promise.reject(new Error('Pi RPC session is not running'));
    }
    const id = command.id || `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const outbound = { ...command, id };
    if (command.type && !command.type.startsWith('get_') && command.type !== 'extension_ui_response') this.activeCommands.add(id);
    if (INPUT_COMMANDS.has(command.type ?? '') && this.sessionFile) {
      this.inputSessionFiles.set(id, path.resolve(this.sessionFile));
    }
    delete outbound.sessionId;
    const timeoutMs = opts.timeoutMs ?? 60000;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command timed out: ${outbound.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: outbound.type });
      try {
        child.stdin!.write(JSON.stringify(outbound) + '\n', (err: Error | null | undefined) => {
          if (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(err);
          }
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  handleStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) this.handleLine(line);
  }

  handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { console.log(`[Pi ${this.id}] ${trimmed}`); return; }
    if (msg.type === 'response') {
      this.handleResponse(msg);
      return;
    }
    this.handleEvent(msg);
  }

  handleResponse(resp: PiRpcMessage) {
    if (INPUT_COMMANDS.has(resp.command ?? '') && !this.terminating && !this.exited) {
      // Observe even late acknowledgements after the HTTP caller timed out. A
      // timeout is not completion and must not release the original file.
      const synchronization = this.inputSynchronization.catch(() => {}).then(() => this.synchronizeInput(resp.data?.disposition === 'handled', resp.id));
      this.inputSynchronization = synchronization;
      void synchronization.then(
        () => this.completeResponse(resp),
        (error: unknown) => this.completeResponse({
          ...resp, success: false,
          error: `Could not synchronize the session: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
      return;
    }
    this.completeResponse(resp);
  }

  private completeResponse(resp: PiRpcMessage) {
    const id = resp.id;
    if (id) this.activeCommands.delete(id);
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(resp);
      }
    }
    this.updateStateFromResponse(resp);
    this.manager.broadcast({ type: 'event', sessionId: this.id, event: resp });
  }

  private async synchronizeInput(rebuildHistory: boolean, responseId?: string) {
    const state = await this.sendCommand({ type: 'get_state' }, { timeoutMs: 5000 });
    const data = state.data as PiRpcPayload | undefined;
    if (state.success !== true || typeof data?.sessionFile !== 'string') throw new Error('Pi did not confirm its current session file');
    const currentFile = path.resolve(data.sessionFile);
    const changedFile = Array.from(this.inputSessionFiles.values()).some(file => file !== currentFile);
    const rebuiltHistory = changedFile || rebuildHistory;
    if (rebuiltHistory) {
      // Unwritten fresh sessions have no on-disk header. Their existing cwd
      // remains authoritative; only an actual file change requires a new one.
      const header = changedFile ? readSessionHeader(currentFile) : this.entries.find(entry => entry.type === 'session');
      await this.loadActiveHistory(header);
      if (typeof header?.cwd === 'string') this.cwd = header.cwd;
      this.sessionName = typeof data.sessionName === 'string' ? data.sessionName : null;
      this.userMessages = [];
      this.titleSet = !!this.sessionName;
      this.contextUsage = null;
      if (changedFile) {
        this.lastExtensionError = null;
        this.navigateCommandChecked = false;
      }
    }
    for (const id of this.inputSessionFiles.keys()) {
      if (id === responseId || !this.activeCommands.has(id)) this.inputSessionFiles.delete(id);
    }
    if (rebuiltHistory) {
      // Publish the authoritative replacement to every view before completing
      // the input. snapshot() would wait on this synchronization itself.
      this.manager.broadcast({ type: 'live_session_snapshot', sessionId: this.id, ...this.currentSnapshot() });
      this.manager.broadcastUpdated(this.id);
    }
  }

  private async loadActiveHistory(header?: JsonRecord) {
    const response = await this.sendCommand({ type: 'get_tree' }, { timeoutMs: 30000 });
    const tree = response.data as { tree?: SessionTreeNodeLike[]; leafId?: string | null } | undefined;
    if (response.success !== true || !Array.isArray(tree?.tree) || !(tree.leafId === null || typeof tree.leafId === 'string')) {
      throw new Error(`Session history refresh failed: ${response.error || 'invalid tree response'}`);
    }
    const flat = flattenTree(tree.tree);
    if (tree.leafId !== null && !flat.has(tree.leafId)) throw new Error('Session history refresh omitted the active leaf');
    this.entries = [...(header ? [header] : []), ...pathFromRoot(flat, tree.leafId)];
  }

  referencesSessionFile(resolvedFile: string) {
    return (this.sessionFile !== null && path.resolve(this.sessionFile) === resolvedFile)
      || Array.from(this.inputSessionFiles.values()).includes(resolvedFile);
  }

  updateStateFromResponse(resp: PiRpcMessage) {
    const data: PiRpcPayload = resp.data || resp.result || resp;
    const command = resp.command || data.command;
    if (data.sessionFile) this.sessionFile = data.sessionFile;
    if (data.sessionName) this.setSessionName(data.sessionName);
    if (data.contextUsage) this.contextUsage = data.contextUsage;
    if (data.model) this.model = normalizeModel(data.model);
    if (data.thinkingLevel) this.thinkingLevel = data.thinkingLevel;
    if (command === 'get_state' && typeof data.isStreaming === 'boolean') this.isStreaming = data.isStreaming;
    if (data.level) this.thinkingLevel = data.level;
    if (data.tokens) this.contextUsage = { ...(this.contextUsage || {}), tokens: data.tokens };
    if (command === 'set_model' || command === 'cycle_model') {
      if (data.model) this.model = normalizeModel(data.model);
      else if (data.provider && data.id) this.model = normalizeModel(data);
    }
    this.touch(true);
  }

  handleEvent(event: PiRpcMessage) {
    this.touch(false);
    const type = event.type;
    if (type === 'agent_start') this.runActive = true;
    if (type === 'agent_settled') this.runActive = false;
    if (type === 'agent_start' || type === 'turn_start') this.isStreaming = true;
    if (type === 'agent_end') this.isStreaming = false;
    // Extension command handlers report their errors as extension_error
    // events while the triggering prompt still acks with success. Keep the
    // last one so navigate_tree can explain WHY a leaf verification failed
    // (stdout is ordered, so the event lands before the prompt's response).
    // Only tau's own command qualifies — pi tags command errors with
    // extensionPath `command:<name>` — so a failure is never blamed on an
    // unrelated extension that happened to error in the same window.
    if (type === 'extension_error' && event.error && event.extensionPath === `command:${NAVIGATE_COMMAND}`) {
      this.lastExtensionError = String(event.error);
    }
    if (event.contextUsage) this.contextUsage = event.contextUsage;
    if (event.sessionFile) this.sessionFile = event.sessionFile;
    if (type === 'session_name' && event.name) {
      if (!this.setSessionName(event.name)) return;
      event.name = this.sessionName || event.name;
    }

    if ((type === 'message_start' || type === 'message_end') && event.message) {
      this.trackMessage(event.message, type);
    }
    if (type === 'entry_appended' && event.entry?.type === 'compaction') {
      this.entries.push(event.entry);
    }
    // NOTE: the assistant `message_end` event carries `event.message.model` as
    // a bare id describing WHICH model produced that message, not a selection
    // change. Overwriting `this.model` with it downgraded the canonical
    // {provider,id} object to a bare string and propagated to all clients via
    // broadcastUpdated. Do NOT touch model identity here — only record usage.
    if (type === 'message_end' && event.message?.role === 'assistant') {
      if (event.message.usage) this.contextUsage = { ...(this.contextUsage || {}), usage: event.message.usage };
    }

    this.manager.broadcast({ type: 'event', sessionId: this.id, event });
    this.manager.broadcastUpdated(this.id);
  }

  trackMessage(message: PiMessage, eventType: string) {
    if (message.role === 'user' && eventType === 'message_start') {
      const text = this.messageText(message);
      if (text) this.userMessages.push(text.slice(0, 300));
      this.entries.push({ type: 'message', message });
      this.maybeTitle();
    } else if (message.role !== 'user' && eventType === 'message_end') {
      this.entries.push({ type: 'message', message });
    }
  }

  messageText(message: PiMessage) {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return '';
  }

  setSessionName(name: unknown) {
    const trimmed = String(name || '').trim();
    if (!trimmed || isGenericSessionName(trimmed)) return false;
    this.sessionName = trimmed;
    return true;
  }

  maybeTitle() {
    if (this.titleSet || (this.sessionName && !isGenericSessionName(this.sessionName)) || this.userMessages.length < 1) return;
    const msg = this.userMessages.find((m) => m.trim().length > 8) || this.userMessages[0];
    if (!msg) return;
    let title = msg.replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, '').replace(/\n.*/s, '').trim();
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < 80) title = title.slice(0, sentenceEnd);
    if (title.length > 60) title = title.slice(0, 57).replace(/\s+\S*$/, '') + '…';
    title = title.charAt(0).toUpperCase() + title.slice(1);
    this.sessionName = title || null;
    this.titleSet = true;
    this.manager.broadcast({ type: 'event', sessionId: this.id, event: { type: 'session_name', name: this.sessionName } });
  }

  touch(broadcast: boolean) {
    this.lastActiveAt = new Date().toISOString();
    if (broadcast) this.manager.broadcastUpdated(this.id);
  }

  private rejectPending(error: Error | { message?: string }) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (!child || this.exited || child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (exited: boolean) => {
        clearTimeout(timer);
        child.off('exit', onExit);
        child.off('error', onError);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const onError = () => { if (!child.pid) finish(true); };
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once('exit', onExit);
      child.on('error', onError);
    });
  }

  terminate(reason = 'closed'): Promise<void> {
    if (this.termination) return this.termination;
    this.terminating = true;
    this.rejectPending(new Error(`Session terminated: ${reason}`));
    this.termination = (async () => {
      if (!this.child || this.exited || this.child.exitCode != null || this.child.signalCode != null) return;
      const gracefulExit = this.waitForExit(1500);
      try { this.child.kill('SIGTERM'); } catch { /* Escalate if exit is not observed. */ }
      if (await gracefulExit) return;
      const forcedExit = this.waitForExit(5000);
      try { this.child.kill('SIGKILL'); } catch { /* The bounded exit wait determines safety. */ }
      if (!await forcedExit) throw new SessionLifecycleError('Pi child exit could not be confirmed; do not reopen its session file', this.id, false);
    })().finally(() => { this.termination = null; });
    return this.termination;
  }

  /**
   * A child that dies during startup — an unknown provider, a failed extension —
   * explains itself on stderr and nowhere else. Without that text the caller only
   * sees an exit code, which is what made a disabled provider look like a
   * transport failure.
   */
  exitError(code: number | null, signal: string | null) {
    const reason = this.stderrTail.join('\n').trim();
    return new Error(`Pi process exited (${signal || code})${reason ? `:\n${reason}` : ''}`);
  }

  handleExit(code: number | null, signal: string | null, err?: { message?: string }) {
    if (this.exited) return;
    this.exited = true;
    this.inputSessionFiles.clear();
    this.activeCommands.clear();
    this.exitCode = code;
    this.rejectPending(err || this.exitError(code, signal));
    this.manager.removeExited(this.id, err?.message || `process_exit:${signal || code}`);
  }
}

export class LiveSessionManager {
  sessions: Map<string, PiRpcSession>;
  clients: Set<LiveClient>;
  pendingResumes: Map<string, Promise<{ session: PiRpcSession; refreshed: boolean }>>;
  terminatingResumes: Map<string, Promise<void>>;
  private startingSessions = new Set<PiRpcSession>();

  constructor() {
    this.sessions = new Map();
    this.clients = new Set();
    this.pendingResumes = new Map();
    this.terminatingResumes = new Map();
  }
  addClient(ws: LiveClient) { this.clients.add(ws); }
  removeClient(ws: LiveClient) { this.clients.delete(ws); }
  broadcast(data: unknown) {
    const payload = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }
  broadcastUpdated(id: string) {
    const s = this.sessions.get(id);
    if (s) this.broadcast({ type: 'live_session_updated', session: s.metadata() });
  }
  list() { return Array.from(this.sessions.values()).map((s) => s.metadata()); }
  get(id: string) { return this.sessions.get(id); }
  findBySessionFile(sessionFile: string) {
    const resolved = path.resolve(sessionFile);
    return Array.from(this.sessions.values()).find((session) => session.referencesSessionFile(resolved));
  }
  hasStartingSession(sessionFile: string) {
    const resolved = path.resolve(sessionFile);
    return Array.from(this.startingSessions).some((session) => session.sessionFile && path.resolve(session.sessionFile) === resolved);
  }
  hasPendingResume(sessionFile: string) { return this.pendingResumes.has(path.resolve(sessionFile)); }
  hasTerminatingResume(sessionFile: string) { return this.terminatingResumes.has(path.resolve(sessionFile)); }
  async create({ cwd, model, sessionFile, args, env }: { cwd?: string; model?: string; sessionFile?: string } & SessionSpawnOverrides) {
    const resolved = path.resolve(expandHome(cwd || process.cwd()));
    const session = new PiRpcSession(this, {
      cwd: resolved, modelSpec: (model || '').trim(),
      ...(sessionFile ? { sessionFile: path.resolve(expandHome(sessionFile)) } : {}), args, env,
    });
    return this.startSession(session);
  }
  private async startSession(session: PiRpcSession) {
    // A create can open an existing file too; it is not in pendingResumes.
    // Keep it visible to pre-spawn rollback checks until readiness/cleanup ends.
    this.startingSessions.add(session);
    try {
      await session.start();
      if (session.exited) throw new SessionLifecycleError('Pi exited during startup', session.id, true);
    } catch (error) {
      // Retain an uncertain child so it cannot be replaced by another resume,
      // and so DELETE can retry cleanup using the error's sessionId.
      if (error instanceof SessionLifecycleError && !error.childStopped) this.sessions.set(session.id, session);
      throw error;
    } finally {
      this.startingSessions.delete(session);
    }
    this.sessions.set(session.id, session);
    this.broadcast({ type: 'live_session_created', session: session.metadata() });
    return session;
  }
  async resume(options: { sessionFile: string; cwd: string; model?: string; entries?: JsonRecord[]; sessionName?: string | null; refresh?: boolean } & SessionSpawnOverrides): Promise<{ session: PiRpcSession; started: boolean; refreshed: boolean }> {
    const { sessionFile, cwd, model, entries, sessionName, args, env, refresh } = options;
    const resolved = path.resolve(sessionFile);
    const pending = this.pendingResumes.get(resolved);
    if (pending) {
      const result = await pending;
      if (refresh && !result.refreshed) return this.resume(options);
      return { ...result, started: false };
    }
    let started = false;
    // Defer execution so even an immediate failure removes the map entry only
    // after it has been installed. Concurrent callers join the same startup.
    const resumePromise = Promise.resolve().then(async () => {
      try {
        const terminating = this.terminatingResumes.get(resolved);
        if (terminating) await terminating;
        const existing = this.findBySessionFile(resolved);
        if (existing) {
          if (existing.terminating) throw new SessionLifecycleError('Previous Pi child exit is unconfirmed; close it before resuming', existing.id, false);
          if (refresh) await existing.refresh(resolved);
          return { session: existing, refreshed: !!refresh };
        }
        const session = new PiRpcSession(this, { cwd, modelSpec: (model || '').trim(), sessionFile: resolved, entries, sessionName, args, env });
        const readySession = await this.startSession(session);
        started = true;
        return { session: readySession, refreshed: false };
      } finally {
        this.pendingResumes.delete(resolved);
      }
    });
    this.pendingResumes.set(resolved, resumePromise);
    return { ...await resumePromise, started };
  }
  async delete(id: string, reason = 'closed_by_user') {
    const session = this.sessions.get(id);
    if (!session) return false;
    const resolvedFile = session.sessionFile ? path.resolve(session.sessionFile) : null;
    const termination = session.terminate(reason).then(() => {
      this.removeExited(id, reason);
    }).finally(() => {
      if (resolvedFile && this.terminatingResumes.get(resolvedFile) === termination) this.terminatingResumes.delete(resolvedFile);
    });
    if (resolvedFile) this.terminatingResumes.set(resolvedFile, termination);
    await termination;
    return true;
  }
  removeExited(id: string, reason: string) {
    if (!this.sessions.has(id)) return;
    this.sessions.delete(id);
    this.broadcast({ type: 'live_session_closed', sessionId: id, reason });
  }
  async shutdown() {
    const results = await Promise.allSettled(Array.from(this.sessions.keys(), (id) => this.delete(id, 'server_shutdown')));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), `${failures.length} Pi child exit(s) unconfirmed`);
  }
}


export const liveManager = new LiveSessionManager();
let _spawnPiForTest: SpawnFn | null = null;
export function _setSpawnPiForTest(fn: SpawnFn | null | undefined) { _spawnPiForTest = fn || null; }
