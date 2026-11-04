import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readProcessIdentity, type ProcessIdentity } from '@phimacs/pimux/process-identity';
import type { WorkerTaskRecord } from 'pi-orchestration/worker-task';
import type { FakePimux } from './fake-pimux.ts';
import type { PimuxExit } from '../src/server/pimux-attachment.ts';

/** Synthetic owning records; native tests use the real publishing API. */
export function workerTaskFixture(mux: FakePimux) {
  const directory = path.dirname(mux.socketPath);
  const tasks = path.join(directory, 'task-receipts');
  fs.mkdirSync(tasks, { mode: 0o700, recursive: true });
  const file = path.join(tasks, `${mux.muxId}.json`);
  let record: WorkerTaskRecord = { schema: 1, muxId: mux.muxId, worker: mux.entry.piIdentity as ProcessIdentity,
    parent: { process: readProcessIdentity(process.pid)!, taskId: `task-${mux.muxId}` },
    leaseFile: path.join(directory, `${mux.muxId}-lease.json`), state: 'pending' };
  const publish = (changes: Partial<WorkerTaskRecord> = {}) => {
    record = { ...record, ...changes };
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  let terminal: PimuxExit = { code: 0, signal: null, stderrTail: '' };
  const receipt = (status: Partial<PimuxExit> = {}) => {
    terminal = { ...terminal, ...status };
    const receipts = path.join(directory, 'receipts');
    fs.mkdirSync(receipts, { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(receipts, `${mux.muxId}.json`), JSON.stringify({ protocol: 2, muxId: mux.muxId,
      operationId: `operation-${mux.muxId}`, state: 'stopped', code: terminal.code, signal: terminal.signal, stoppedAt: new Date().toISOString() }), { mode: 0o600 });
  };
  publish();
  return { file, record: () => record, publish, receipt,
    finish(error?: string) { receipt(); publish({ state: error ? 'failed' : 'complete', ...(error ? { error } : {}) }); },
    exit(status: Partial<PimuxExit> = {}) {
      terminal = { ...terminal, ...status };
      receipt();
      for (const socket of mux.connections) socket.end(JSON.stringify({ type: 'pimux_exit', ...terminal }) + '\n');
    } };
}
