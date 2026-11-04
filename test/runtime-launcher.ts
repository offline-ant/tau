import { runtimeEnvironment } from './runtime-environment.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from '@earendil-works/pi-coding-agent';
import { acquireClaim, releaseClaim, type ClaimHandle } from '@phimacs/pimux/ownership';
import { readProcessIdentity } from '@phimacs/pimux/process-identity';
import type { DiscoveryRecord } from '@phimacs/pimux/discovery';
import type { StartRuntimeOptions, RuntimeReceipt } from '@phimacs/pimux/runtime';
import { receiptFor } from '../bin/pimux.js';
import { FakePimux } from './fake-pimux.ts';
import type { JsonRecord } from '../src/server/types.ts';

/** Fake only the common launch transaction. Every frontend still uses a real socket. */
export class FakeRuntimeLauncher {
  readonly calls: StartRuntimeOptions[] = [];
  readonly muxes: FakePimux[] = [];
  private readonly claims: ClaimHandle[] = [];
  gate: Promise<void> | undefined;
  failure: Error | undefined;
  configure: (mux: FakePimux) => void = () => {};

  start = async (options: StartRuntimeOptions): Promise<RuntimeReceipt> => {
    this.calls.push(options);
    await this.gate;
    if (this.failure) throw this.failure;
    const args = parseArgs(options.args);
    const file = args.session || path.join(runtimeEnvironment.sessions, `${randomUUID()}.jsonl`);
    const id = randomUUID();
    const mux = new FakePimux(process.env.PIMUX_DIR!, id, { sessionFile: file, cwd: options.cwd || process.cwd() });
    const identity = readProcessIdentity(process.pid)!;
    const claim = acquireClaim(file, { id, kind: 'rpc', wrapper: identity, pi: identity, protocol: 2,
      socket: mux.socketPath, operationId: String(mux.entry.operationId) });
    this.claims.push(claim);
    this.muxes.push(mux);
    if (fs.existsSync(file)) {
      const entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as JsonRecord);
      mux.entries = entries.filter(entry => entry.type !== 'session' && typeof entry.id === 'string');
      mux.leafId = mux.entries.at(-1)?.id as string | undefined ?? null;
      const name = [...entries].reverse().find(entry => entry.type === 'session_info' && typeof entry.name === 'string')?.name;
      mux.extraSnapshot.session = { file, id, name: name ?? null, cwd: options.cwd };
    }
    this.configure(mux);
    await mux.listen();
    return { ...receiptFor(mux.entry as unknown as DiscoveryRecord), protocol: 2, state: 'committed', outcome: 'started' };
  };

  async close() {
    for (const mux of this.muxes) await mux.close();
    for (const claim of this.claims) releaseClaim(claim);
  }
}
