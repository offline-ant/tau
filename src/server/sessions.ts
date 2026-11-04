import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startRuntime, stopRuntime, RuntimeOperationError, type ParentTask, type RuntimeReceipt, type StartRuntimeOptions, type TerminalReceipt } from '@phimacs/pimux/runtime';
import { canonicalSessionPath } from '@phimacs/pimux/ownership';
import { readProcessIdentity, type ProcessIdentity } from '@phimacs/pimux/process-identity';
import { isReadOnlyCommand, isRecord, parseInputContext, type InputContext } from '@phimacs/pimux/protocol';
import { WebSocket } from 'ws';
import type { AbortState, JsonRecord, LiveClient, ModelIdentity, PendingCommand, RpcCommand, RpcResponse, SessionSpawnOverrides } from './types.js';
import { expandHome, releaseHost, SESSIONS_DIR } from './config.js';
import { orchestrationEndpoint } from './orchestration.js';
import { modelLabel, normalizeModel, parseModelSpecToModel } from './model-utils.js';
import { NAVIGATE_COMMAND, entriesById, pathFromRoot, type TreeEntry } from './tree.js';
import { PimuxTransport, type PiTransport, type TransportEnd, type TransportHandlers } from './transport.js';
import { PimuxAttachment, type AppliedSnapshot } from './pimux-attachment.js';
import { cancelWorkerObservation, closeWorker, observeWorkerExit } from './close-worker.js';
import { reconcileRuntimeExit, requireSessionFile } from './runtime-recovery.js';
import { exitError, exitNotice, workerExitReport } from './runtime-exit.js';
import { pimuxDisplayName, pimuxEntryById, pimuxSharing, probePimux, receiptFor, type PimuxEntry, type PimuxSharing } from './pimux.js';

type PiMessageContent = string | Array<{ type: string; text?: string }>;
type PiMessage = { role?: string; content?: PiMessageContent; usage?: JsonRecord; model?: string };
/** A compaction Pi is running right now. `startedAt` is a Unix time in milliseconds. */
export type CompactionState = { reason: string; startedAt: number };
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

/** Inherited identities a new Tau tab must not take over from the shell that started the server. */
const INHERITED_IDENTITY = ['PI_NESTED', 'PI_ORCHESTRATION_TARGET', 'PI_ORCHESTRATION_CONTROL',
  'PI_ORCHESTRATION_HOST', 'PI_ORCHESTRATION_ENDPOINT', 'PI_ORCHESTRATION_PLACEMENT', 'PI_ORCHESTRATION_PARENT',
  'PHIMACS_PARENT_TASK', 'HERDR_ENV', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID', 'TMUX', 'TMUX_PANE'];

export type InlineImage = { data: string; mimeType: string };

/** The base64 data of an image content block, in Pi's or Anthropic's shape. */
export function inlineImage(block: unknown): InlineImage | null {
  if (!block || typeof block !== 'object') return null;
  const image = block as { type?: unknown; data?: unknown; mimeType?: unknown; media_type?: unknown; source?: { data?: unknown; media_type?: unknown } };
  if (image.type !== 'image') return null;
  let data = typeof image.data === 'string' ? image.data : typeof image.source?.data === 'string' ? image.source.data : '';
  if (!data) return null;
  let mimeType = [image.mimeType, image.source?.media_type, image.media_type].find((value): value is string => typeof value === 'string');
  const dataUrl = /^data:([^;,]+)[^,]*,/.exec(data);
  if (dataUrl) {
    mimeType ??= dataUrl[1];
    data = data.slice(dataUrl[0].length);
  }
  return { data, mimeType: mimeType || 'image/png' };
}

export function isGenericSessionName(name: unknown) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized === 'chat' || normalized === 'new chat' || normalized === 'untitled' || normalized === 'untitled chat' || normalized === 'session';
}

/** Opening/attachment failed. This never claims that a committed runtime exited. */
export class SessionOpenError extends Error {
  readonly status: number;
  readonly muxId?: string;
  constructor(message: string, status: number, muxId?: string) {
    super(message);
    this.status = status;
    this.muxId = muxId;
  }
}

/** A command refused before transport delivery can safely remain requester-local. */
export class InputContextError extends Error {}

function sameInputContext(left: InputContext, right: InputContext): boolean {
  return left.contextId === right.contextId && left.sessionFile === right.sessionFile && left.leafId === right.leafId;
}

/** Runtime identity and origin placement for display; no frontend owns its lifetime. */
export type AttachedOwner = { muxId: string; host: string | null; placement: string; name: string | null };

export class PiRpcSession {
  manager: LiveSessionManager;
  id: string;
  cwd: string;
  modelSpec: string;
  transport: PiTransport | null;
  /** Internal view disconnection, including Tau shutdown, does not stop Pi. */
  detachReason: 'detached' | 'server_shutdown' = 'detached';
  /** Null only before the launch transaction returns its committed identity. */
  attachment: PimuxAttachment | null;
  attachedOwner: AttachedOwner | null;
  pid: number | null;
  piIdentity: ProcessIdentity | null = null;
  createdAt: string;
  lastActiveAt: string;
  isStreaming: boolean;
  entries: JsonRecord[];
  /** Changes whenever `entries` is replaced instead of added to, so image links from an older history stop resolving. */
  historyEpoch = 0;
  model: ModelIdentity | null;
  thinkingLevel: string;
  sessionFile: string | null;
  sessionName: string | null;
  contextUsage: JsonRecord | null;
  /** Extra `pi` arguments supplied by a programmatic caller, appended after tau's own. */
  extraArgs: string[];
  /** Explicit environment overrides for a newly created runtime. */
  extraEnv: Record<string, string>;
  pending: Map<string, PendingCommand>;
  /** Timeout is not completion: IDs remain reserved until a real response/disconnect. */
  private outstandingIds = new Map<string, InputContext | null>();
  /** Joins browsers selecting an attached tab at once into one pimux snapshot. */
  private bootstrapping: Promise<void> | null = null;
  terminating: boolean;
  exitCode: number | null;
  exited = false;
  private termination: Promise<void> | null = null;
  titleSet: boolean;
  /** Last extension_error event from the child; navigate_tree reads this to explain a failed leaf move. */
  lastExtensionError: string | null;
  /** Whether navigation confirmed the advertised command on this runtime. */
  navigateCommandChecked: boolean;
  runtimeReceipt: RuntimeReceipt | null = null;
  terminalReceipt: TerminalReceipt | null = null;
  capabilities = { stop: true, navigateTree: false };
  startOutcome: 'started' | 'attached' = 'attached';
  /** The compaction Pi is running, from compaction_start until compaction_end. */
  compaction: CompactionState | null = null;
  /** Counts compaction_start events, so a compact command can tell whether Pi began compacting. */
  compactionRevision = 0;
  /** Pi's auto-compaction setting as last reported by this Pi process. */
  autoCompactionEnabled: boolean | null = null;
  interactionRevision = 0;
  abortState: AbortState = 'idle';
  private abortPromise: Promise<RpcResponse> | null = null;
  private abortInputContext: InputContext | null = null;
  private abortCommandId: string | null = null;
  private operationRevision = 0;
  private abortOperationRevision = 0;

  constructor(manager: LiveSessionManager, opts: { id?: string; cwd: string; modelSpec?: string; sessionFile?: string | null; entries?: JsonRecord[]; sessionName?: string | null; pimux?: PimuxEntry } & SessionSpawnOverrides) {
    this.manager = manager;
    this.id = opts.id || makeId();
    this.cwd = opts.cwd;
    this.modelSpec = opts.modelSpec || '';
    this.transport = null;
    this.attachment = opts.pimux
      ? new PimuxAttachment(opts.pimux.muxId, opts.pimux.socket, (applied) => this.applyPimuxSnapshot(applied), { piPid: receiptFor(opts.pimux).piPid, sessionFile: opts.sessionFile ?? opts.pimux.session?.file ?? null })
      : null;
    this.attachedOwner = opts.pimux ? {
      muxId: opts.pimux.muxId, host: opts.pimux.orchestration?.host ?? null, placement: opts.pimux.placement || 'root',
      name: pimuxDisplayName(opts.pimux),
    } : null;
    if (opts.pimux) this.runtimeReceipt = receiptFor(opts.pimux);
    this.pid = null;
    this.piIdentity = opts.pimux?.piIdentity ?? null;
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
    this.terminating = false;
    this.exitCode = null;
    this.titleSet = false;
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
      pendingInteractionCount: this.attachment?.dialogs.size ?? 0,
      capabilities: this.capabilities,
      runtime: this.runtimeReceipt,
      leafId: this.attachment?.leafId ?? null,
      runtimeContext: this.attachment?.inputContext ?? null,
      inputReady: !!this.attachment?.ready && !!this.attachment.inputContext && !this.terminating && !this.exited,
      abortState: this.abortState,
      attached: this.attachedOwner,
      compaction: this.compaction,
    };
  }

  async snapshot(): Promise<ReturnType<PiRpcSession['currentSnapshot']>> {
    if (this.exited && this.attachment) return (await this.manager.attachById(this.attachment.muxId)).session.snapshot();
    await this.bootstrap();
    return this.currentSnapshot();
  }

  private currentSnapshot() {
    return {
      session: this.metadata(),
      pendingDialogs: this.dialogSnapshot(),
      interactionRevision: this.interactionRevision,
      entries: this.linkedEntries(),
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.isStreaming,
      compaction: this.compaction,
      sessionFile: this.sessionFile,
      sessionName: this.sessionName,
      contextUsage: this.contextUsage,
      // Attached tabs: the pimux boundary this state describes, and the dialogs
      // open at it. Browsers skip an HTTP snapshot older than one they applied.
      ...(this.attachment ? { generation: this.attachment.appliedGeneration, dialogs: [...this.attachment.dialogs.values()] } : {}),
    };
  }

  /**
   * History entries for a browser, with each image replaced by a link to it.
   * Images are most of a screenshot-heavy history, and the browser loads
   * them only when they come into view.
   */
  private linkedEntries() {
    return this.entries.map((entry, index) => {
      const message = entry.message as JsonRecord | undefined;
      const content = message?.content;
      if (!Array.isArray(content) || !content.some((block) => inlineImage(block))) return entry;
      const linked = content.map((block, blockIndex) => {
        const image = inlineImage(block);
        if (!image) return block;
        return { type: 'image', mimeType: image.mimeType, url: `/api/live-sessions/${encodeURIComponent(this.id)}/images/${this.historyEpoch}/${index}/${blockIndex}` };
      });
      return { ...entry, message: { ...message, content: linked } };
    });
  }

  /** The image a history link points to, or null when the history changed since the link was made. */
  historyImage(epoch: number, entryIndex: number, blockIndex: number) {
    if (epoch !== this.historyEpoch) return null;
    const content = (this.entries[entryIndex]?.message as JsonRecord | undefined)?.content;
    return Array.isArray(content) ? inlineImage(content[blockIndex]) : null;
  }

  dialogSnapshot() {
    return [...(this.attachment?.dialogs.values() ?? [])];
  }

  private diagnostic(action: string, requestId?: string, reason?: string) {
    if (process.env.TAU_INTERACTION_DIAGNOSTICS !== '1') return;
    console.error(JSON.stringify({ scope: 'tau_interaction', sessionId: this.id, requestId, action, reason, timestamp: new Date().toISOString() }));
  }

  /** Browser selections share one authoritative snapshot/live request. */
  private bootstrap(): Promise<void> {
    if (this.bootstrapping) return this.bootstrapping;
    const attachment = this.attachment!;
    this.bootstrapping = (async () => {
      const response = await this.sendCommand({ type: 'pimux_bootstrap', include: ['entries'] }, { timeoutMs: 30000 });
      const generation = (response.data as { generation?: unknown } | undefined)?.generation;
      if (response.success !== true || typeof generation !== 'number') {
        throw new Error(`pimux refused the snapshot request: ${String(response.error || 'no generation')}`);
      }
      await attachment.waitFor(generation);
    })().finally(() => { this.bootstrapping = null; });
    return this.bootstrapping;
  }

  private transportHandlers(): TransportHandlers {
    return {
      line: (line) => this.handleLine(line),
      error: (error) => {
        this.attachment?.close(error);
        this.rejectPending(error);
        this.transport?.abandon();
      },
      end: (end) => this.handleTransportEnd(end),
    };
  }

  async start(expectedSessionFile?: string) {
    if (!fs.existsSync(this.cwd) || !fs.statSync(this.cwd).isDirectory()) throw new SessionOpenError(`Directory not found: ${this.cwd}`, 400);
    if (!this.attachment) {
      const args = ['--mode', 'rpc', '--extension', TAU_TREE_EXTENSION];
      if (this.sessionFile) args.push('--session', canonicalSessionPath(this.sessionFile));
      else args.push('--session-dir', path.join(SESSIONS_DIR, `project-${createHash('sha256').update(fs.realpathSync(this.cwd)).digest('hex')}`));
      if (this.modelSpec) args.push('--model', this.modelSpec);
      args.push(...this.extraArgs);
      const env = { ...process.env };
      for (const key of INHERITED_IDENTITY) delete env[key];
      const endpoint = orchestrationEndpoint();
      Object.assign(env, { TAU_DISABLED: '1', PI_ORCHESTRATION_HOST: 'web',
        ...(endpoint ? { PI_ORCHESTRATION_ENDPOINT: endpoint } : {}), ...this.extraEnv });
      let parent: ParentTask | undefined;
      if (env.PHIMACS_PARENT_TASK) {
        const parsed: unknown = JSON.parse(env.PHIMACS_PARENT_TASK);
        if (!isRecord(parsed) || !isRecord(parsed.process) || typeof parsed.taskId !== 'string' || !parsed.taskId
          || !Number.isSafeInteger(parsed.process.pid) || Number(parsed.process.pid) <= 0
          || typeof parsed.process.startTime !== 'string' || !/^\d+$/.test(parsed.process.startTime)
          || typeof parsed.process.bootId !== 'string' || !parsed.process.bootId) throw new SessionOpenError('Invalid parent task identity', 400);
        parent = parsed as unknown as ParentTask;
      }
      try {
        const host = releaseHost();
        this.runtimeReceipt = await this.manager.runtime.start({ command: host.executable, expectedHost: host, args, cwd: this.cwd, env, parent });
        this.startOutcome = this.runtimeReceipt.outcome;
      } catch (error) {
        if (error instanceof RuntimeOperationError) throw new SessionOpenError(`${error.message}; operation ${error.operationId}, runtime ${error.muxId}. Reconcile before retrying.`, 503, error.muxId);
        throw new SessionOpenError(error instanceof Error ? error.message : String(error), 409);
      }
      const receipt = this.runtimeReceipt;
      this.sessionFile = receipt.sessionFile;
      const discovery = pimuxEntryById(receipt.muxId, path.dirname(receipt.socket));
      this.piIdentity = discovery?.piIdentity ?? null;
      this.attachedOwner = { muxId: receipt.muxId, host: discovery?.orchestration?.host ?? null,
        placement: discovery?.placement ?? env.PI_ORCHESTRATION_PLACEMENT ?? 'root', name: discovery ? pimuxDisplayName(discovery) : null };
      this.attachment = new PimuxAttachment(receipt.muxId, receipt.socket, applied => this.applyPimuxSnapshot(applied),
        { piPid: receipt.piPid, sessionFile: receipt.sessionFile });
    }
    await this.startAttached(expectedSessionFile);
  }

  private async startAttached(expectedSessionFile?: string) {
    const attachment = this.attachment!;
    try {
      this.transport = await PimuxTransport.connect(attachment.socket, this.transportHandlers());
      await attachment.waitFor(0, 30000);
      if (this.exited) throw new Error('Connection closed during attach');
      this.pid = attachment.piPid;
      this.piIdentity ??= readProcessIdentity(attachment.piPid!) ?? null;
      const commands = await this.send({ type: 'get_commands' }, { timeoutMs: 5000 });
      requireSessionFile(this, expectedSessionFile);
      const data = commands.data as { commands?: Array<{ name?: string; source?: string }> } | undefined;
      this.capabilities.navigateTree = Array.isArray(data?.commands)
        && data.commands.some(command => command.name === NAVIGATE_COMMAND && command.source === 'extension');
      void this.send({ type: 'get_session_stats' }, { timeoutMs: 5000 }).catch(() => {});
    } catch (error) {
      this.terminating = true;
      this.transport?.abandon();
      // Commitment already happened. An unavailable view must never stop/retry
      // the independent root, including one this request originally started.
      throw new SessionOpenError(`Could not attach; the committed runtime was left available: ${error instanceof Error ? error.message : String(error)}`, 503, attachment.muxId);
    }
  }

  async refresh(sessionFile: string) {
    if (!this.sessionFile || canonicalSessionPath(this.sessionFile) !== canonicalSessionPath(sessionFile)) throw new SessionOpenError('Runtime serves another conversation', 409);
    await this.bootstrap();
    requireSessionFile(this, sessionFile);
  }

  async stop(operationId?: string): Promise<TerminalReceipt> {
    if (!this.attachment) throw new SessionOpenError('No runtime identity to stop', 409);
    return this.attachedOwner?.placement === 'worker'
      ? closeWorker(this)
      : this.manager.runtime.stop(this.attachment.muxId, { operationId, env: { ...process.env, PIMUX_DIR: path.dirname(this.attachment.socket) } });
  }

  /** Validate the browser's captured expectation, never replace it with current state. */
  browserInputContext(command: RpcCommand) {
    const input = command.inputContext;
    const current = this.attachment?.inputContext;
    if (!this.attachment?.ready || !current || !isRecord(input)
      || input.agentId !== this.attachment.muxId || input.file !== this.sessionFile) {
      throw new InputContextError('Input belongs to an unavailable or different conversation; review it before reuse');
    }
    const expected = parseInputContext(input.runtimeContext);
    if (!expected || !sameInputContext(expected, current) || expected.sessionFile !== input.file) {
      throw new InputContextError('Input belongs to another branch or an unknown context; review it before reuse');
    }
    return { agentId: this.attachment.muxId, file: this.sessionFile,
      leafId: typeof input.leafId === 'string' ? input.leafId : null, runtimeContext: expected };
  }

  private contextualCommand(command: RpcCommand): RpcCommand {
    const outbound = { ...command };
    delete outbound.inputContext;
    if (isReadOnlyCommand(String(command.type)) || String(command.type).startsWith('pimux_')) {
      delete outbound.pimuxContext;
      return outbound;
    }
    const current = this.attachment?.inputContext;
    const expected = Object.hasOwn(command, 'pimuxContext') ? parseInputContext(command.pimuxContext) : current;
    if (!this.attachment?.ready || !current || !expected || !sameInputContext(expected, current)) {
      throw new InputContextError('Runtime input context changed or is not ready; command was not sent');
    }
    outbound.pimuxContext = { ...expected };
    return outbound;
  }

  send(command: RpcCommand, opts: { timeoutMs?: number } = {}) {
    return this.sendCommand(command, opts);
  }

  private sendCommand(command: RpcCommand, opts: { timeoutMs?: number } = {}) {
    const transport = this.transport;
    if (this.outstandingIds.size >= 256) return Promise.reject(new Error('Too many pending runtime commands; wait for their outcome'));
    if (!transport || !transport.writable || this.terminating || this.exited
      || !this.attachment?.ready && command.type !== 'pimux_bootstrap' && !isReadOnlyCommand(String(command.type))) {
      return Promise.reject(new Error('Pi RPC session is not running'));
    }
    const id = command.id || `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    if (this.outstandingIds.has(id)) return Promise.reject(new Error('Command ID is still in flight; do not retry an uncertain operation'));
    let contextual: RpcCommand;
    try { contextual = this.contextualCommand(command); }
    catch (error) { return Promise.reject(error); }
    this.outstandingIds.set(id, this.attachment?.inputContext ? { ...this.attachment.inputContext } : null);
    const outbound = { ...contextual, id };
    delete outbound.sessionId;
    const timeoutMs = opts.timeoutMs ?? 60000;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command timed out: ${outbound.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: outbound.type });
      try {
        transport.write(JSON.stringify(outbound) + '\n', (err: Error | null | undefined) => {
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

  /** Pi never acknowledges UI replies. Success means stdin delivery only. */
  private writeDialogResponse(command: RpcCommand) {
    const transport = this.transport;
    if (!transport?.writable || this.terminating || !this.attachment?.ready) return Promise.reject(new Error('Pi RPC session is not snapshot-ready'));
    return new Promise<void>((resolve, reject) => {
      try {
        transport.write(JSON.stringify(this.contextualCommand(command)) + '\n', (err) => err ? reject(err) : resolve());
      } catch (error) { reject(error); }
    });
  }

  async respondToDialog(command: RpcCommand): Promise<RpcResponse> {
    const id = command.id;
    const request = id ? this.attachment?.dialogs.get(id) : undefined;
    if (!id || !request) throw new Error('No pending dialog with that ID in this session');
    if (command.sessionId && command.sessionId !== this.id) throw new Error('Dialog belongs to another session');
    if (typeof request.expiresAt === 'number' && request.expiresAt <= Date.now()) {
      throw new Error('Dialog has expired');
    }
    const outbound: RpcCommand = { type: 'extension_ui_response', id,
      ...(Object.hasOwn(command, 'pimuxContext') ? { pimuxContext: command.pimuxContext } : {}) };
    if (command.cancelled === true || this.abortState !== 'idle') outbound.cancelled = true;
    else if (request.method === 'confirm' && typeof command.confirmed === 'boolean') outbound.confirmed = command.confirmed;
    else if (request.method !== 'confirm' && typeof command.value === 'string') {
      if (request.method === 'select' && (!Array.isArray(request.options) || !request.options.includes(command.value))) throw new Error('Invalid dialog selection');
      outbound.value = command.value;
    } else throw new Error('Invalid dialog response');
    try {
      await this.writeDialogResponse(outbound);
      // Membership changes only on the mux's authoritative closure/snapshot.
      return { type: 'response', command: 'extension_ui_response', id, success: true, data: { delivered: true } };
    } catch (error) {
      this.diagnostic('delivery_failed', id);
      throw error;
    }
  }

  private cancelPendingDialogs() {
    const current = this.attachment?.inputContext;
    if (!current || !this.abortInputContext || !sameInputContext(current, this.abortInputContext)) return;
    for (const id of this.attachment?.dialogs.keys() ?? []) {
      void this.respondToDialog({ type: 'extension_ui_response', id, cancelled: true })
        .catch(() => this.diagnostic('cancellation_delivery_failed', id));
    }
  }

  private completeAbort(id: string | undefined) {
    if (!id || id !== this.abortCommandId) return;
    this.abortCommandId = null;
    this.abortState = 'idle';
    // A delayed acknowledgement belongs to the operation it stopped, not a
    // newer turn that may already have started after agent_settled.
    if (this.operationRevision === this.abortOperationRevision) this.isStreaming = false;
    this.diagnostic('abort_acknowledged');
    this.manager.broadcastUpdated(this.id);
  }

  abort(command: RpcCommand = {}, opts: { timeoutMs?: number } = {}): Promise<RpcResponse> {
    let contextual: RpcCommand;
    try { contextual = this.contextualCommand({ ...command, type: 'abort' }); }
    catch (error) { return Promise.reject(error); }
    const context = parseInputContext(contextual.pimuxContext);
    if (!context) return Promise.reject(new InputContextError('Abort requires an authoritative runtime context'));
    if (!this.abortPromise || !this.abortInputContext || !sameInputContext(context, this.abortInputContext)) {
      this.abortState = 'stopping';
      const abortId = command.id || makeId();
      this.abortCommandId = abortId;
      this.abortInputContext = context;
      this.abortOperationRevision = this.operationRevision;
      this.manager.broadcastUpdated(this.id);
      this.diagnostic('abort_sent');
      // Delivery starts before dialog cancellation; neither retries on uncertainty.
      const native = this.send({ ...contextual, id: abortId }, opts);
      this.cancelPendingDialogs();
      const operation: Promise<RpcResponse> = native.then(resp => {
        if (resp.success === true) this.completeAbort(abortId);
        else if (this.abortCommandId === abortId) {
          this.abortState = 'failed';
          this.diagnostic('abort_failed');
          this.manager.broadcastUpdated(this.id);
        }
        return resp;
      }, error => {
        if (this.abortCommandId === abortId) {
          this.abortState = /^RPC command timed out:/.test(String(error instanceof Error ? error.message : error)) ? 'timed_out' : 'failed';
          this.diagnostic(this.abortState === 'timed_out' ? 'abort_timed_out' : 'abort_failed');
          this.manager.broadcastUpdated(this.id);
        }
        throw error;
      }).finally(() => { if (this.abortPromise === operation) this.abortPromise = null; });
      this.abortPromise = operation;
    }
    // Coalesced callers still receive their own command correlation ID.
    return this.abortPromise.then(resp => ({ ...resp, ...(command.id ? { id: command.id } : {}) }));
  }

  handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { console.warn('[Tau] Invalid runtime JSON record'); this.transport?.abandon(); return; }
    if (typeof msg !== 'object' || msg === null) return;
    try {
      const wasReady = this.attachment?.ready;
      const handled = this.attachment?.handle(msg);
      if (wasReady !== this.attachment?.ready) this.manager.broadcastUpdated(this.id);
      if (handled) return;
    } catch (error) {
      this.attachment?.close(error instanceof Error ? error : new Error(String(error)));
      this.manager.broadcastUpdated(this.id);
      this.transport?.abandon();
      return;
    }
    if (msg.type === 'response') {
      this.handleResponse(msg);
      return;
    }
    this.handleEvent(msg);
  }

  handleResponse(resp: PiRpcMessage) {
    this.completeResponse(resp);
  }

  private completeResponse(resp: PiRpcMessage) {
    const id = resp.id;
    const tracked = !!id && this.outstandingIds.has(id);
    const expected = id ? this.outstandingIds.get(id) : undefined;
    if (id) this.outstandingIds.delete(id);
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(resp);
      }
    }
    if (resp.command === 'abort' && resp.success === true) this.completeAbort(resp.id);
    // Answers to Tau's own pimux requests concern this server, not browsers.
    if (String(resp.command ?? '').startsWith('pimux_') || resp.command === 'clear_queue') return;
    const current = this.attachment?.inputContext;
    if (tracked && (!expected || !current || !sameInputContext(expected, current))) return;
    this.updateStateFromResponse(resp);
    this.manager.broadcast({ type: 'event', sessionId: this.id, event: resp });
  }

  /**
   * Publishes one pimux boundary: the state, then the replayed in-flight work
   * as ordinary events, so every browser shows the same conversation.
   */
  private applyPimuxSnapshot({ snapshot, replay }: AppliedSnapshot) {
    const context = parseInputContext(snapshot.inputContext);
    if (context && this.abortInputContext && !sameInputContext(context, this.abortInputContext)) {
      this.abortState = 'idle';
      this.abortCommandId = null;
      this.abortInputContext = null;
    }
    const session = snapshot.session;
    if (session) {
      this.sessionFile = session.file;
      if (this.runtimeReceipt && session.file) this.runtimeReceipt = { ...this.runtimeReceipt, sessionFile: session.file };
      if (session.cwd) this.cwd = session.cwd;
      this.sessionName = session.name && !isGenericSessionName(session.name) ? session.name : null;
    }
    this.model = normalizeModel(snapshot.model);
    this.thinkingLevel = snapshot.thinkingLevel || 'off';
    if (Array.isArray(snapshot.entries) || snapshot.historyError) {
      // Without history, the old conversation must not pass for the one Pi moved to.
      const path = pathFromRoot(entriesById(snapshot.entries as TreeEntry[] | undefined), snapshot.leafId ?? null);
      this.entries = path;
      this.historyEpoch++;
    }
    this.isStreaming = !!snapshot.run?.active || snapshot.idle === false;
    this.titleSet = !!this.sessionName;
    for (const record of replay) this.applyEventState(record);
    if (this.abortState !== 'idle') this.cancelPendingDialogs();
    if (this.manager.get(this.id) !== this) return;
    this.manager.broadcast({ type: 'live_session_snapshot', sessionId: this.id, ...this.currentSnapshot() });
    if (snapshot.historyError) this.manager.broadcast({ type: 'event', sessionId: this.id, event: {
      type: 'extension_ui_request', method: 'notify', notifyType: 'error',
      message: `The shared session changed, but its history could not be loaded: ${snapshot.historyError}`,
    } });
    for (const record of replay) this.manager.broadcast({ type: 'event', sessionId: this.id, event: record });
    this.manager.broadcastUpdated(this.id);
  }

  referencesSessionFile(resolvedFile: string) {
    return this.sessionFile !== null && canonicalSessionPath(this.sessionFile) === canonicalSessionPath(resolvedFile);
  }

  updateStateFromResponse(resp: PiRpcMessage) {
    const data: PiRpcPayload = resp.data || resp.result || resp;
    const command = resp.command || data.command;
    // get_state may race a boundary: it never replaces snapshot identity.
    if (data.sessionName) this.setSessionName(data.sessionName);
    if (data.contextUsage) this.contextUsage = data.contextUsage;
    if (data.model) this.model = normalizeModel(data.model);
    if (data.thinkingLevel) this.thinkingLevel = data.thinkingLevel;
    if (command === 'get_state' && typeof data.isStreaming === 'boolean') this.isStreaming = data.isStreaming;
    if (data.level) this.thinkingLevel = data.level;
    if (data.tokens) this.contextUsage = { ...(this.contextUsage || {}), tokens: data.tokens };
    if (typeof data.autoCompactionEnabled === 'boolean') this.autoCompactionEnabled = data.autoCompactionEnabled;
    if (command === 'set_model' || command === 'cycle_model') {
      if (data.model) this.model = normalizeModel(data.model);
      else if (data.provider && data.id) this.model = normalizeModel(data);
    }
    this.touch(true);
  }

  handleEvent(event: PiRpcMessage) {
    this.touch(false);
    if (!this.applyEventState(event)) return;
    this.manager.broadcast({ type: 'event', sessionId: this.id, event });
    this.manager.broadcastUpdated(this.id);
  }

  /** Updates tab state from one event; false when the event must not reach browsers. */
  private applyEventState(event: PiRpcMessage): boolean {
    const type = event.type;
    if (type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(String(event.method)) && this.abortState !== 'idle') this.cancelPendingDialogs();
    // Only agent_settled confirms completion after retries/compaction and
    // queued continuations; neither turn_end nor agent_end establishes idle.
    if (type === 'agent_settled') {
      if (!this.abortPromise) this.abortState = 'idle';
      this.isStreaming = false;
    }
    if (type === 'agent_start') this.operationRevision++;
    if (type === 'agent_start' || type === 'turn_start') this.isStreaming = true;
    if (type === 'compaction_start') {
      this.compactionRevision++;
      this.compaction = { reason: typeof event.reason === 'string' ? event.reason : 'manual', startedAt: Date.now() };
      // Automatic compaction belongs to a reply, even before agent_start.
      // Only agent_settled confirms that the whole reply has finished.
      if (event.reason === 'threshold' || event.reason === 'overflow') this.isStreaming = true;
    }
    if (type === 'compaction_end') {
      // The compaction entry itself arrives as pimux's entry_appended record.
      this.compaction = null;
    }
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
    // Only an authoritative snapshot replaces conversation identity.
    if (type === 'session_name' && event.name) {
      if (!this.setSessionName(event.name)) return false;
      event.name = this.sessionName || event.name;
    }
    // Native Pi events: another frontend may change these on a shared Pi.
    if (type === 'thinking_level_changed' && typeof event.level === 'string') this.thinkingLevel = event.level;
    if (type === 'session_info_changed') {
      this.sessionName = typeof event.name === 'string' && !isGenericSessionName(event.name) ? event.name.trim() : null;
      this.titleSet = !!this.sessionName;
    }
    if (type === 'pimux_model_changed') this.model = normalizeModel(event.model);
    if (type === 'pimux_session_changed') {
      // The snapshot that follows at once replaces the history.
      if (typeof event.cwd === 'string') this.cwd = event.cwd;
      this.sessionName = typeof event.sessionName === 'string' && !isGenericSessionName(event.sessionName) ? event.sessionName : null;
      this.titleSet = !!this.sessionName;
      this.contextUsage = null;
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
    return true;
  }

  trackMessage(message: PiMessage, eventType: string) {
    if (message.role === 'user' && eventType === 'message_start') {
      this.entries.push({ type: 'message', message });
    } else if (message.role !== 'user' && eventType === 'message_end') {
      this.entries.push({ type: 'message', message });
    }
  }

  setSessionName(name: unknown) {
    const trimmed = String(name || '').trim();
    if (!trimmed || isGenericSessionName(trimmed)) return false;
    this.sessionName = trimmed;
    return true;
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
    this.outstandingIds.clear();
  }

  /** Disconnect this view. The independent Pi/runtime remains owned and running. */
  terminate(reason = 'closed'): Promise<void> {
    if (this.termination) return this.termination;
    this.terminating = true;
    cancelWorkerObservation(this);
    if (reason === 'server_shutdown') this.detachReason = reason;
    this.rejectPending(new Error(`Session terminated: ${reason}`));
    const transport = this.transport;
    this.termination = (async () => {
      if (!transport || this.exited) return;
      try { await transport.close(); }
      catch (error) { throw new SessionOpenError(error instanceof Error ? error.message : String(error), 503, this.attachment?.muxId); }
    })().finally(() => { this.termination = null; });
    return this.termination;
  }

  private handleTransportEnd(end: TransportEnd) {
    if (!this.attachment) return this.handleExit(end.code, end.signal, end.error);
    const exit = this.attachment.exit;
    if (exit) return this.handleExit(exit.code, exit.signal, undefined, exit.stderrTail);
    // A disconnect says nothing about the Pi: it may still be running, and its
    // file stays owned by the detached runtime.
    this.handleExit(null, null, new Error('Lost the connection to the shared Pi session; it may still be running.'));
  }

  handleExit(code: number | null, signal: string | null, err?: { message?: string }, stderrTail?: string) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.compaction = null;
    const error = err ?? exitError(code, signal, stderrTail ?? (this.transport?.stderrTail() ?? []).join('\n'));
    this.attachment?.close(error instanceof Error ? error : new Error(String(error.message)));
    this.rejectPending(error);
    if (this.attachment) {
      if (!this.terminating && this.attachment.exit && this.attachedOwner?.placement === 'worker') {
        this.isStreaming = false;
        this.manager.broadcastUpdated(this.id);
        observeWorkerExit(this);
        return;
      }
      if (!this.terminating && !this.attachment.exit) {
        this.isStreaming = false;
        this.manager.broadcastUpdated(this.id);
        if (!this.attachment.exit) this.manager.broadcast({ type: 'event', sessionId: this.id, event: { type: 'extension_ui_request', method: 'notify', notifyType: 'error', message: error.message } });
        return;
      }
      const reason = this.terminating ? this.detachReason : `pimux_exit:${signal || code}`;
      const notice = this.attachment.exit ? exitNotice(code, signal, this.attachedOwner?.host ?? null) : null;
      this.manager.removeExited(this.id, reason, this.terminating ? undefined : notice ?? error.message, !!notice);
      return;
    }
    this.manager.removeExited(this.id, err?.message || `process_exit:${signal || code}`);
  }
}

/** Session-opening `pi` flags: the file must come from `sessionFile`, so attach-or-spawn resolution sees it. */
const SESSION_OPENING_ARGS = new Set(['--session', '--session-id', '--fork', '--continue', '-c', '--resume', '-r']);
export function assertNoSessionArgs(args: string[] | undefined) {
  for (const arg of args ?? []) {
    const flag = arg.startsWith('--') ? arg.split('=')[0] : arg;
    if (SESSION_OPENING_ARGS.has(flag)) throw new Error(`args must not open a session (${flag}); pass sessionFile instead`);
  }
}

const MAX_CLIENT_BACKLOG_BYTES = 64 * 1024 * 1024;
const PIMUX_RETRY_MS = 50;

export class LiveSessionManager {
  sessions: Map<string, PiRpcSession>;
  clients: Set<LiveClient>;
  pendingResumes: Map<string, Promise<{ session: PiRpcSession; refreshed: boolean }>>;
  terminatingResumes: Map<string, Promise<void>>;
  private startingSessions = new Set<PiRpcSession>();
  private pendingAttaches = new Map<string, Promise<PiRpcSession>>();
  /** Called whenever an attached tab opens or closes, so the agent overview can show it. */
  onAttachmentsChanged: () => void = () => {};
  maxClientBacklogBytes = MAX_CLIENT_BACKLOG_BYTES;
  /** How long opening a shared session waits for a pimux still starting. */
  pimuxStartWaitMs = 5000;

  readonly runtime: { start: (options: StartRuntimeOptions) => Promise<RuntimeReceipt>; stop: typeof stopRuntime };
  constructor(runtime: { start?: (options: StartRuntimeOptions) => Promise<RuntimeReceipt>; stop?: typeof stopRuntime } = {}) {
    this.runtime = { start: runtime.start ?? startRuntime, stop: runtime.stop ?? stopRuntime };
    this.sessions = new Map();
    this.clients = new Set();
    this.pendingResumes = new Map();
    this.terminatingResumes = new Map();
  }
  addClient(ws: LiveClient) { this.clients.add(ws); }
  removeClient(ws: LiveClient) { this.clients.delete(ws); }
  /** Stalled browsers reconnect through a snapshot instead of unbounded buffering. */
  sendTo(client: LiveClient, payload: string) {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > this.maxClientBacklogBytes) {
      client.terminate();
      this.removeClient(client);
      return;
    }
    client.send(payload);
  }
  broadcast(data: unknown) {
    const payload = JSON.stringify(data);
    for (const client of this.clients) this.sendTo(client, payload);
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
  findByMuxId(muxId: string) {
    return Array.from(this.sessions.values()).find((session) => session.attachment?.muxId === muxId && !session.terminating && !session.exited);
  }
  hasStartingSession(sessionFile: string) {
    const resolved = path.resolve(sessionFile);
    return Array.from(this.startingSessions).some((session) => session.sessionFile && path.resolve(session.sessionFile) === resolved);
  }
  hasPendingResume(sessionFile: string) { return this.pendingResumes.has(canonicalSessionPath(sessionFile)); }
  hasTerminatingResume(sessionFile: string) { return this.terminatingResumes.has(path.resolve(sessionFile)); }
  /** Create and resume share resolution; neither may open a second writer. */
  async create({ cwd, model, sessionFile, args, env }: { cwd?: string; model?: string; sessionFile?: string } & SessionSpawnOverrides) {
    assertNoSessionArgs(args);
    const resolved = path.resolve(expandHome(cwd || process.cwd()));
    if (sessionFile) {
      const { session } = await this.resume({ sessionFile: path.resolve(expandHome(sessionFile)), cwd: resolved, model, args, env });
      return session;
    }
    const session = new PiRpcSession(this, { cwd: resolved, modelSpec: (model || '').trim(), args, env });
    return this.startSession(session);
  }
  private async startSession(session: PiRpcSession) {
    // A create can open an existing file too; it is not in pendingResumes.
    // Keep it visible to pre-spawn rollback checks until readiness/cleanup ends.
    this.startingSessions.add(session);
    try {
      await session.start();
      if (session.exited) throw new SessionOpenError('Runtime connection ended during startup; reconcile its identity before retrying', 503, session.attachment?.muxId);
    } finally {
      this.startingSessions.delete(session);
    }
    const existing = session.attachment ? this.findByMuxId(session.attachment.muxId) : undefined;
    if (existing) { await session.terminate('duplicate_view'); return existing; }
    this.sessions.set(session.id, session);
    this.broadcast({ type: 'live_session_created', session: session.metadata() });
    this.onAttachmentsChanged();
    return session;
  }
  /** Attaches a tab to a pimux-shared Pi, or returns the tab already attached to it. */
  async attach(entry: PimuxEntry, expectedSessionFile?: string): Promise<{ session: PiRpcSession; started: boolean }> {
    const existing = this.findByMuxId(entry.muxId);
    if (existing) return { session: requireSessionFile(existing, expectedSessionFile), started: false };
    const pending = this.pendingAttaches.get(entry.muxId);
    if (pending) return { session: requireSessionFile(await pending, expectedSessionFile), started: false };
    const attaching = (async () => {
      const session = new PiRpcSession(this, { cwd: entry.cwd, sessionFile: expectedSessionFile ?? entry.session?.file ?? null, sessionName: entry.session?.name ?? null, pimux: entry });
      await session.start(expectedSessionFile);
      const duplicate = this.findByMuxId(entry.muxId);
      if (duplicate) { await session.terminate('duplicate_view'); return requireSessionFile(duplicate, expectedSessionFile); }
      for (const old of this.sessions.values()) if (old.exited && old.attachment?.muxId === entry.muxId) this.removeExited(old.id, 'reconnected');
      this.sessions.set(session.id, session);
      this.broadcast({ type: 'live_session_created', session: session.metadata() });
      this.onAttachmentsChanged();
      return session;
    })().finally(() => this.pendingAttaches.delete(entry.muxId));
    this.pendingAttaches.set(entry.muxId, attaching);
    return { session: await attaching, started: true };
  }
  /** Reconnect only this identity; a missing runtime never permits relaunch. */
  async attachById(muxId: string, expectedSessionFile?: string) {
    if (reconcileRuntimeExit(this, muxId)) throw new SessionOpenError('This agent was closed', 410, muxId);
    const existing = this.findByMuxId(muxId);
    if (existing) return { session: requireSessionFile(existing, expectedSessionFile), started: false };
    const socket = [...this.sessions.values()].find(view => view.attachment?.muxId === muxId)?.attachment?.socket;
    const entry = await this.whenReachable(async () => {
      const found = pimuxEntryById(muxId, socket ? path.dirname(socket) : undefined);
      if (!found) return null;
      const reachability = await probePimux(found);
      return reachability === 'stale' ? null : { entry: found, reachability };
    }, 'The shared Pi session does not accept connections yet; try again in a moment');
    if (!entry) {
      if (reconcileRuntimeExit(this, muxId)) throw new SessionOpenError('This agent was closed', 410, muxId);
      throw new SessionOpenError('Runtime is unavailable; its termination was not acknowledged', 503, muxId);
    }
    return this.attach(entry, expectedSessionFile);
  }
  /** Unreachable live or uncertain owners still exclude another writer. */
  private pimuxFor(file: string): Promise<PimuxEntry | null> {
    return this.whenReachable(() => pimuxSharing(file), 'This session is shared by another frontend that does not accept connections right now; it was not opened here.');
  }
  /** Follows `look` while its pimux is starting, so a tab opened at that moment attaches instead of failing. */
  private async whenReachable(look: () => Promise<PimuxSharing | null>, refusal: string): Promise<PimuxEntry | null> {
    const deadline = Date.now() + this.pimuxStartWaitMs;
    for (;;) {
      const sharing = await look();
      if (!sharing) return null;
      if (sharing.reachability === 'reachable') return sharing.entry;
      if (sharing.entry.status !== 'starting' || Date.now() >= deadline) throw new SessionOpenError(refusal, 409, sharing.entry.muxId);
      await new Promise((resolve) => setTimeout(resolve, PIMUX_RETRY_MS));
    }
  }
  async resume(options: { sessionFile: string; cwd: string; model?: string; entries?: JsonRecord[]; sessionName?: string | null; refresh?: boolean } & SessionSpawnOverrides): Promise<{ session: PiRpcSession; started: boolean; refreshed: boolean }> {
    const { sessionFile, cwd, model, entries, sessionName, args, env, refresh } = options;
    assertNoSessionArgs(args);
    const resolved = canonicalSessionPath(sessionFile);
    const pending = this.pendingResumes.get(resolved);
    if (pending) {
      const result = await pending;
      if (refresh && !result.refreshed) return this.resume(options);
      return { ...result, session: requireSessionFile(result.session, resolved), started: false };
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
          if (existing.exited && existing.attachment) return { session: (await this.attachById(existing.attachment.muxId, resolved)).session, refreshed: false };
          if (existing.terminating) throw new SessionOpenError('Previous view is disconnecting; wait for that operation to settle', 503, existing.attachment?.muxId);
          if (refresh) await existing.refresh(resolved);
          return { session: existing, refreshed: !!refresh };
        }
        const shared = await this.pimuxFor(resolved);
        if (shared) {
          const attached = await this.attach(shared, resolved);
          if (refresh) await attached.session.refresh(resolved);
          return { session: attached.session, refreshed: !!refresh };
        }
        const session = new PiRpcSession(this, { cwd, modelSpec: (model || '').trim(), sessionFile: resolved, entries, sessionName, args, env });
        const readySession = await this.startSession(session);
        started = readySession.startOutcome === 'started';
        return { session: requireSessionFile(readySession, resolved), refreshed: false };
      } finally {
        this.pendingResumes.delete(resolved);
      }
    });
    this.pendingResumes.set(resolved, resumePromise);
    return { ...await resumePromise, started };
  }
  async delete(id: string, reason = 'closed_by_user', receipt?: TerminalReceipt) {
    const session = this.sessions.get(id);
    if (!session) return false;
    const resolvedFile = session.sessionFile && !session.attachment ? path.resolve(session.sessionFile) : null;
    if (receipt) session.terminalReceipt = receipt;
    const termination = session.terminate(reason).then(() => {
      this.removeExited(id, session.attachment ? session.detachReason : reason, undefined, false, receipt);
    }).finally(() => {
      if (resolvedFile && this.terminatingResumes.get(resolvedFile) === termination) this.terminatingResumes.delete(resolvedFile);
    });
    if (resolvedFile) this.terminatingResumes.set(resolvedFile, termination);
    await termination;
    return true;
  }
  /** `notice` marks `message` as news rather than a failure. */
  removeExited(id: string, reason: string, message?: string, notice = false, receipt?: TerminalReceipt) {
    const session = this.sessions.get(id);
    if (!session) return;
    const report = reason !== 'reconnected' && session.attachedOwner?.placement === 'worker' ? workerExitReport(session.attachment?.exit ?? receipt ?? session.terminalReceipt) : undefined;
    if (report) { message = report.message; notice = report.notice; }
    this.sessions.delete(id);
    this.broadcast({ type: 'live_session_closed', sessionId: id, reason, ...(message ? { message, notice } : {}) });
    if (session.attachment) this.onAttachmentsChanged();
  }
  async shutdown() {
    const results = await Promise.allSettled(Array.from(this.sessions.keys(), (id) => this.delete(id, 'server_shutdown')));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), `${failures.length} view disconnect(s) unconfirmed`);
  }
}

export const liveManager = new LiveSessionManager();
