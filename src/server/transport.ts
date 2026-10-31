/*
 * How a Tau tab talks to its Pi process.
 *
 * A tab either owns a `pi --mode rpc` child it spawned, or is attached to a
 * Pi another frontend started through pimux (see pi-ant's
 * orchestration/pimux/README.md). Both carry Pi's JSONL records; they differ
 * in what closing means. Closing a spawned tab stops its child and confirms
 * the exit. Closing an attached tab only disconnects: that Pi belongs to the
 * frontend that started it and is never signalled from here.
 */

import net from 'node:net';

import type { ChildProcess } from 'node:child_process';

/** Bound on retained child stderr; startup diagnostics are short. */
export const STDERR_TAIL_LINES = 20;

/** How the transport ended: a child's exit status, or an attachment's disconnect. */
export type TransportEnd = { code: number | null; signal: string | null; error?: Error };

export interface TransportHandlers {
  line(line: string): void;
  /** Fails in-flight commands; it does not prove that Pi stopped. */
  error(error: Error): void;
  end(end: TransportEnd): void;
}

export interface PiTransport {
  readonly kind: 'spawned' | 'pimux';
  /** The child this tab owns; null for an attachment, which owns no process. */
  readonly pid: number | null;
  readonly writable: boolean;
  write(line: string, callback: (error?: Error | null) => void): void;
  /** Spawned: stop the child and confirm its exit. Attached: disconnect. */
  close(): Promise<void>;
  /** Synchronous last resort while the server exits. */
  abandon(): void;
  stderrTail(): string[];
}

/** Splits a byte stream into records on LF only (never U+2028/U+2029), dropping a trailing CR. */
export class LineSplitter {
  private buffer = '';
  push(chunk: string, line: (line: string) => void) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const record = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      line(record.endsWith('\r') ? record.slice(0, -1) : record);
    }
  }
}

export class SpawnTransport implements PiTransport {
  readonly kind = 'spawned';
  readonly child: ChildProcess;
  private readonly handlers: TransportHandlers;
  private readonly lines = new LineSplitter();
  private readonly stderr: string[] = [];
  private ended = false;
  private closing: Promise<void> | null = null;

  constructor(child: ChildProcess, handlers: TransportHandlers, label: string) {
    this.child = child;
    this.handlers = handlers;
    child.stdin!.on('error', (error: Error) => handlers.error(error));
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.lines.push(chunk, handlers.line));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        console.error(`[Pi ${label}] ${line}`);
        this.stderr.push(line);
        if (this.stderr.length > STDERR_TAIL_LINES) this.stderr.shift();
      }
    });
    child.on('error', (error: Error) => {
      // A failed spawn has no child to reap. A later kill/write error does
      // not prove process exit, so keep ownership until an actual exit.
      if (!child.pid) this.finish({ code: null, signal: null, error });
      else handlers.error(error);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => this.finish({ code, signal }));
  }

  get pid() { return this.child.pid || null; }
  get writable() { return !this.ended && !!this.child.stdin?.writable; }

  write(line: string, callback: (error?: Error | null) => void) {
    this.child.stdin!.write(line, callback);
  }

  stderrTail() { return [...this.stderr]; }

  private finish(end: TransportEnd) {
    if (this.ended) return;
    this.ended = true;
    this.handlers.end(end);
  }

  private exited() {
    return this.ended || this.child.exitCode != null || this.child.signalCode != null;
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (this.exited()) return Promise.resolve(true);
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

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.exited()) return;
      const gracefulExit = this.waitForExit(1500);
      try { this.child.kill('SIGTERM'); } catch { /* Escalate if exit is not observed. */ }
      if (await gracefulExit) return;
      const forcedExit = this.waitForExit(5000);
      try { this.child.kill('SIGKILL'); } catch { /* The bounded exit wait determines safety. */ }
      if (!await forcedExit) throw new Error('Pi child exit could not be confirmed; do not reopen its session file');
    })().finally(() => { this.closing = null; });
    return this.closing;
  }

  abandon() {
    try { this.child.kill('SIGTERM'); } catch {}
  }
}

/** A secondary pimux client connection. Its end is a disconnect, never proof that Pi exited. */
export class PimuxTransport implements PiTransport {
  readonly kind = 'pimux';
  readonly pid = null;
  private readonly socket: net.Socket;
  private readonly handlers: TransportHandlers;
  private readonly lines = new LineSplitter();
  private ended = false;
  private readonly closed: Promise<void>;

  private constructor(socket: net.Socket, handlers: TransportHandlers) {
    this.socket = socket;
    this.handlers = handlers;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.lines.push(chunk, handlers.line));
    socket.on('error', (error: Error) => handlers.error(error));
    this.closed = new Promise((resolve) => socket.once('close', () => {
      if (!this.ended) {
        this.ended = true;
        handlers.end({ code: null, signal: null });
      }
      resolve();
    }));
  }

  /** Connects to a pimux socket; rejects without a transport when it does not accept. */
  static connect(socketPath: string, handlers: TransportHandlers, timeoutMs = 5000): Promise<PimuxTransport> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error(`pimux socket ${socketPath} did not accept the connection`)); }, timeoutMs);
      socket.once('error', (error) => { clearTimeout(timer); socket.destroy(); reject(error); });
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(new PimuxTransport(socket, handlers));
      });
    });
  }

  get writable() { return !this.ended && this.socket.writable; }

  write(line: string, callback: (error?: Error | null) => void) {
    this.socket.write(line, callback);
  }

  stderrTail() { return []; }

  close(): Promise<void> {
    this.socket.end();
    // A peer that does not finish the close handshake promptly is cut off.
    const timer = setTimeout(() => this.socket.destroy(), 1000);
    timer.unref();
    return this.closed.finally(() => clearTimeout(timer));
  }

  abandon() { this.socket.destroy(); }
}
