import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import type { RuntimeReceipt } from '@phimacs/pimux/runtime';
import { validateSocket } from '@phimacs/pimux/runtime';
import { PROTOCOL_VERSION, RUNTIME_CAPABILITIES, type JsonRecord } from '@phimacs/pimux/protocol';

export async function until<T>(check: () => T | undefined | false | null | Promise<T | undefined | false | null>, description: string, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** An equal socket frontend. Disconnecting it never stops its runtime. */
export class DetachedPeer {
  readonly records: JsonRecord[] = [];
  readonly socket: net.Socket;
  private buffer = '';
  private next = 0;
  private failure: Error | undefined;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) break;
        this.records.push(JSON.parse(this.buffer.slice(0, newline)) as JsonRecord);
        this.buffer = this.buffer.slice(newline + 1);
      }
    });
    socket.on('error', error => { this.failure = error; });
  }

  static async connect(receipt: RuntimeReceipt): Promise<DetachedPeer> {
    validateSocket(receipt.socket);
    const peer = new DetachedPeer(net.connect(receipt.socket));
    try {
      const hello = await peer.waitFor(record => record.type === 'pimux_hello', 'socket hello');
      assert.equal(hello.protocol, PROTOCOL_VERSION);
      assert.equal(hello.muxId, receipt.muxId);
      assert.equal(hello.piPid, receipt.piPid);
      for (const capability of RUNTIME_CAPABILITIES) assert.ok((hello.capabilities as string[]).includes(capability));
      const snapshot = await peer.waitFor(record => record.type === 'pimux_snapshot', 'initial snapshot');
      await peer.waitFor(record => record.type === 'pimux_live' && record.generation === snapshot.generation, 'snapshot replay boundary');
      return peer;
    } catch (error) {
      peer.socket.destroy();
      throw error;
    }
  }

  send(record: JsonRecord): void {
    assert.ok(this.socket.writable, 'peer must be connected');
    this.socket.write(JSON.stringify(record) + '\n');
  }
  mark(): number { return this.records.length; }
  find(match: (record: JsonRecord) => boolean, after = 0): JsonRecord | undefined { return this.records.slice(after).find(match); }
  waitFor(match: (record: JsonRecord) => boolean, description: string, after = 0): Promise<JsonRecord> {
    return until(() => {
      const found = this.find(match, after);
      if (found) return found;
      if (this.failure) throw this.failure;
      if (this.socket.destroyed) throw new Error(`Peer disconnected before ${description}`);
      return undefined;
    }, description);
  }
  async request(record: JsonRecord): Promise<JsonRecord> {
    const id = `peer-${++this.next}`;
    const mark = this.mark();
    this.send({ ...record, id });
    return this.waitFor(received => received.type === 'response' && received.id === id, `response to ${String(record.type)}`, mark);
  }
  async run(message: string): Promise<void> {
    const mark = this.mark();
    const response = await this.request({ type: 'prompt', message });
    assert.equal(response.success, true, String(response.error));
    await this.waitFor(record => record.type === 'agent_settled', `settled after ${message}`, mark);
  }
  async disconnect(): Promise<void> {
    if (this.socket.destroyed) return;
    const closed = once(this.socket, 'close');
    this.socket.end();
    await closed;
  }
}
