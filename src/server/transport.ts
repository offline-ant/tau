/** A Tau tab is an equal Unix-socket client, never the owner of a Pi child. */
import net from 'node:net';
import { validateSocket } from '@phimacs/pimux/runtime';
import { LineSplitter as BoundedLineSplitter } from '@phimacs/pimux/jsonl';

export type TransportEnd = { code: number | null; signal: string | null; error?: Error };
export interface TransportHandlers {
  line(line: string): void;
  error(error: Error): void;
  end(end: TransportEnd): void;
}
export interface PiTransport {
  readonly kind: 'pimux';
  readonly writable: boolean;
  write(line: string, callback: (error?: Error | null) => void): void;
  /** Disconnect this view only. */
  close(): Promise<void>;
  abandon(): void;
  stderrTail(): string[];
}

/** LF only, including split UTF-8 and U+2028/U+2029; bounded by the wire contract. */
export class LineSplitter {
  private splitter: BoundedLineSplitter | undefined;
  push(chunk: string, line: (line: string) => void) {
    this.splitter ??= new BoundedLineSplitter(line, 128 * 1024 * 1024, () => { throw new Error('pimux record exceeds 128 MiB'); });
    this.splitter.push(Buffer.from(chunk));
  }
}

export class PimuxTransport implements PiTransport {
  readonly kind = 'pimux';
  private readonly socket: net.Socket;
  private ended = false;
  private readonly closed: Promise<void>;

  private constructor(socket: net.Socket, handlers: TransportHandlers) {
    this.socket = socket;
    const lines = new BoundedLineSplitter(handlers.line, 128 * 1024 * 1024, () => {
      handlers.error(new Error('pimux record exceeds 128 MiB'));
      socket.destroy();
    });
    socket.on('data', (chunk: Buffer) => lines.push(chunk));
    socket.on('error', (error: Error) => handlers.error(error));
    this.closed = new Promise((resolve) => socket.once('close', () => {
      this.ended = true;
      handlers.end({ code: null, signal: null });
      resolve();
    }));
  }

  static connect(socketPath: string, handlers: TransportHandlers, timeoutMs = 5000): Promise<PimuxTransport> {
    validateSocket(socketPath);
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('pimux connection timed out; runtime was not stopped')); }, timeoutMs);
      socket.once('error', (error) => { clearTimeout(timer); socket.destroy(); reject(error); });
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(new PimuxTransport(socket, handlers));
      });
    });
  }

  get writable() { return !this.ended && this.socket.writable; }
  write(line: string, callback: (error?: Error | null) => void) { this.socket.write(line, callback); }
  stderrTail() { return []; }
  close(): Promise<void> {
    this.socket.end();
    const timer = setTimeout(() => this.socket.destroy(), 1000);
    timer.unref();
    return this.closed.finally(() => clearTimeout(timer));
  }
  abandon() { this.socket.destroy(); }
}
