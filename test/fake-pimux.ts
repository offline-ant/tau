import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { JsonRecord } from '../src/server/types.ts';
import { readProcessIdentity } from '@phimacs/pimux/process-identity';
import { isReadOnlyCommand, parseInputContext, type InputContext } from '@phimacs/pimux/protocol';

/**
 * A pimux wrapper's socket side without Pi: it answers attach with hello and a
 * snapshot sequence, answers `pimux_bootstrap` with another, and records what
 * secondaries send. Protocol: pi-ant orchestration/pimux/README.md.
 */
export class FakePimux {
  readonly muxId: string;
  readonly dir: string;
  readonly socketPath: string;
  readonly jsonPath: string;
  readonly commands: JsonRecord[] = [];
  readonly connections = new Set<net.Socket>();
  ended = 0;
  generation = 0;
  entries: JsonRecord[] | undefined = [];
  /** Extra fields of the next snapshots. */
  extraSnapshot: JsonRecord = {};
  /** When set, every snapshot request fails with this error instead of being answered. */
  failSnapshots: string | null = null;
  leafId: string | null = null;
  inputContext: InputContext | null = null;
  beforeCommand?: (command: JsonRecord) => void;
  /** Records between `pimux_snapshot` and `pimux_live`. */
  replay: JsonRecord[] = [];
  idle = true;
  /** Responses by command type; default success with empty data. */
  responses: Record<string, JsonRecord> = {};
  withheld = new Set<string>();
  entry: JsonRecord;
  private server: net.Server | null = null;

  constructor(dir: string, muxId: string, entry: { sessionFile: string | null; cwd: string } & JsonRecord) {
    this.dir = dir;
    this.muxId = muxId;
    this.socketPath = path.join(dir, `${muxId}.sock`);
    this.jsonPath = path.join(dir, `${muxId}.json`);
    const { sessionFile, cwd, ...rest } = entry;
    this.entry = {
      protocol: 2, phase: 'committed', operationId: `operation-${muxId}`, ownerIdentity: readProcessIdentity(process.pid), piIdentity: readProcessIdentity(process.pid), muxId, socket: this.socketPath, pid: process.pid, piPid: process.pid, cwd,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', blocked: null,
      session: { file: sessionFile, id: `id-${muxId}`, name: null }, model: { provider: 'fx', id: 'one' }, thinkingLevel: 'off',
      placement: 'root', orchestration: { host: 'emacs', endpoint: '/tmp/emacs-test', id: `*pi:${muxId}*` }, parent: null, ...rest,
    };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    this.publish();
  }

  publish(changes: JsonRecord = {}) {
    Object.assign(this.entry, changes, { updatedAt: new Date().toISOString() });
    fs.writeFileSync(this.jsonPath, JSON.stringify(this.entry), { mode: 0o600 });
  }

  listen(): Promise<void> {
    this.server = net.createServer((socket) => this.accept(socket));
    return new Promise((resolve) => this.server!.listen(this.socketPath, () => { fs.chmodSync(this.socketPath, 0o600); resolve(); }));
  }

  private accept(socket: net.Socket) {
    this.connections.add(socket);
    socket.on('close', () => { this.connections.delete(socket); this.ended++; });
    socket.on('error', () => {});
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const command = JSON.parse(buffer.slice(0, newline)) as JsonRecord;
        buffer = buffer.slice(newline + 1);
        this.commands.push(command);
        this.handle(socket, command);
      }
    });
    this.write(socket, { type: 'pimux_hello', protocol: this.entry.protocol, muxId: this.muxId, clientId: this.connections.size, capabilities: ['snapshot', 'stop', 'detached', 'contextual-input'], piPid: process.pid, socket: this.socketPath });
    this.snapshot(socket, 'attach');
  }

  private handle(socket: net.Socket, command: JsonRecord) {
    if (command.type === 'pimux_bootstrap') {
      const generation = ++this.generation;
      this.write(socket, { type: 'response', id: command.id, command: 'pimux_bootstrap', success: true, data: { generation } });
      this.snapshot(socket, 'request', generation);
      return;
    }
    this.beforeCommand?.(command);
    if (!isReadOnlyCommand(String(command.type))) {
      const expected = parseInputContext(command.pimuxContext);
      if (!expected || !this.inputContext || expected.contextId !== this.inputContext.contextId
        || expected.sessionFile !== this.inputContext.sessionFile || expected.leafId !== this.inputContext.leafId) {
        this.write(socket, { type: 'response', id: command.id, command: command.type, success: false, delivery: 'rejected', error: 'Runtime input context changed' });
        return;
      }
    }
    if (this.withheld.has(String(command.type))) return;
    const response = this.responses[String(command.type)] ?? { success: true, data: {} };
    this.write(socket, { type: 'response', id: command.id, command: command.type, ...response });
  }

  snapshot(socket: net.Socket, reason: string, generation = ++this.generation) {
    if (this.failSnapshots) {
      this.write(socket, { type: 'pimux_snapshot_failed', generation, error: this.failSnapshots });
      return;
    }
    const extraSession = this.extraSnapshot.session as JsonRecord | undefined;
    const sessionFile = (extraSession?.file ?? (this.entry.session as JsonRecord | undefined)?.file ?? null) as string | null;
    if (!this.inputContext || this.inputContext.sessionFile !== sessionFile || reason === 'session_changed' || reason === 'tree_changed') {
      this.inputContext = { sessionFile, leafId: this.leafId, contextId: `branch-${this.muxId}-${generation}` };
    }
    this.write(socket, {
      type: 'pimux_snapshot', generation, reason, inputContext: this.inputContext,
      session: { file: this.entry.session && (this.entry.session as JsonRecord).file, id: `id-${this.muxId}`, name: null, cwd: this.entry.cwd },
      model: { provider: 'fx', id: 'one' }, thinkingLevel: 'off', idle: this.idle, leafId: this.leafId, entries: this.entries,
      run: { active: !this.idle, compacting: false, tailTruncated: false }, replay: this.replay.length, ...this.extraSnapshot,
    });
    for (const record of this.replay) this.write(socket, record);
    this.write(socket, { type: 'pimux_live', generation });
  }

  write(socket: net.Socket, record: JsonRecord) { socket.write(JSON.stringify(record) + '\n'); }

  /** Sends one record to every attached secondary. */
  broadcast(record: JsonRecord) { for (const socket of this.connections) this.write(socket, record); }

  /** Drops every connection without `pimux_exit`, as a killed wrapper does. */
  drop() { for (const socket of this.connections) socket.destroy(); }

  async close() {
    for (const socket of this.connections) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    fs.rmSync(this.socketPath, { force: true });
    fs.rmSync(this.jsonPath, { force: true });
  }
}

export async function until<T>(check: () => T | undefined | false | null, description: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
