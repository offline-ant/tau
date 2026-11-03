import fs from 'node:fs';
import path from 'node:path';
import { readWorkerTask, type WorkerTaskRecord } from 'pi-orchestration/worker-task';
import { sameProcessIdentity } from '@phimacs/pimux/process-identity';
import { lookupTerminalReceipt, type TerminalReceipt } from '@phimacs/pimux/runtime';
import type { PiRpcSession } from './sessions.js';

const bindings = new WeakMap<PiRpcSession, WorkerTaskRecord>();
export function runtimeEnvironment(session: PiRpcSession): NodeJS.ProcessEnv {
  if (!session.attachment) throw new Error('Worker runtime identity is unavailable');
  return { ...process.env, PIMUX_DIR: path.dirname(session.attachment.socket) };
}
function uncertain(message: string): Error { return Object.assign(new Error(message), { status: 503 }); }
function sameBinding(left: WorkerTaskRecord, right: WorkerTaskRecord): boolean {
  return left.muxId === right.muxId && left.leaseFile === right.leaseFile && left.parent.taskId === right.parent.taskId
    && sameProcessIdentity(left.worker, right.worker) && sameProcessIdentity(left.parent.process, right.parent.process);
}

/** Capture the owning task, never a frontend PID or a new task using its name. */
export function captureWorkerTask(session: PiRpcSession, env = runtimeEnvironment(session)): WorkerTaskRecord {
  const muxId = session.attachment!.muxId;
  const record = readWorkerTask(muxId, env);
  if (!record) throw uncertain('Worker task evidence is missing; task cleanup is not acknowledged');
  if (!session.piIdentity || !sameProcessIdentity(record.worker, session.piIdentity)) throw uncertain('Worker task process identity changed');
  const expected = bindings.get(session);
  if (expected && !sameBinding(expected, record)) throw uncertain('Worker parent task binding changed');
  bindings.set(session, record);
  if (record.state === 'failed') throw uncertain(`Worker task cleanup failed: ${record.error}`);
  return record;
}

/** Runtime exit alone is insufficient, including during reconnect and retries. */
export function completedWorkerReceipt(session: PiRpcSession, env = runtimeEnvironment(session)): TerminalReceipt {
  const record = captureWorkerTask(session, env);
  if (record.state !== 'complete') throw uncertain('Worker runtime exited; its owning task cleanup is still pending');
  const receipt = lookupTerminalReceipt(record.muxId, env);
  if (!receipt) throw uncertain('Worker task finished, but its runtime termination receipt is unavailable');
  return receipt;
}

/** Observe final publication without polling, resending input or signalling Pi. */
export function waitForWorkerCleanup(session: PiRpcSession, expected: WorkerTaskRecord, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<TerminalReceipt> {
  return new Promise((resolve, reject) => {
    let watcher: fs.FSWatcher | undefined;
    let settled = false;
    const finish = (error?: Error, receipt?: TerminalReceipt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(receipt!);
    };
    const check = () => {
      try {
        const record = captureWorkerTask(session, env);
        if (!sameBinding(expected, record)) throw uncertain('Worker parent task binding changed');
        if (record.state === 'complete') finish(undefined, completedWorkerReceipt(session, env));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
    const aborted = () => finish(uncertain('Worker task observation was cancelled'));
    const timer = setTimeout(() => finish(uncertain('Worker task cleanup timed out; completion is not acknowledged')), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    try {
      watcher = fs.watch(path.join(env.PIMUX_DIR!, 'task-receipts'), check);
      watcher.on('error', error => finish(error));
      check();
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
