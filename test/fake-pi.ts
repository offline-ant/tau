import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { JsonRecord, RpcCommand, RpcResponse } from '../src/server/types.ts';
import type { SessionTreeNodeLike } from '../src/server/tree.ts';

/** Offline RPC child with explicit readiness and process-exit controls. */
export class FakePi extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: RpcCommand[] = [];
  readonly signals: NodeJS.Signals[] = [];
  pid: number | undefined = 12345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  autoRespond: boolean;
  exitOnSignal: NodeJS.Signals | null;
  state: JsonRecord;
  tree: SessionTreeNodeLike[];
  leafId: string | null;

  constructor(options: {
    sessionFile?: string;
    state?: JsonRecord;
    tree?: SessionTreeNodeLike[];
    leafId?: string | null;
    autoRespond?: boolean;
    exitOnSignal?: NodeJS.Signals | null;
  } = {}) {
    super();
    this.state = { sessionFile: options.sessionFile ?? '/tmp/fake-pi.jsonl', ...options.state };
    this.tree = options.tree ?? [];
    this.leafId = options.leafId ?? null;
    this.autoRespond = options.autoRespond ?? true;
    this.exitOnSignal = options.exitOnSignal === undefined ? 'SIGTERM' : options.exitOnSignal;
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const command = JSON.parse(line) as RpcCommand;
        this.commands.push(command);
        if (this.autoRespond) this.respond(command);
      }
    });
  }

  asChild(): ChildProcess { return this as unknown as ChildProcess; }

  respond(command: RpcCommand, response: RpcResponse = {}): void {
    const data = command.type === 'get_state' ? this.state
      : command.type === 'get_tree' ? { tree: this.tree, leafId: this.leafId } : {};
    this.stdout.write(JSON.stringify({ type: 'response', command: command.type, id: command.id, success: true, data, ...response }) + '\n');
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.exitOnSignal === signal) this.exit(null, signal);
    return true;
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

/** Drain promise/stream work without advancing mocked deadlines. */
export const flushIo = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
