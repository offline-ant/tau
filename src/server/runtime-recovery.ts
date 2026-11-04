import { lookupTerminalReceipt, type TerminalReceipt } from '@phimacs/pimux/runtime';
import { SessionOpenError, type LiveSessionManager, type PiRpcSession } from './sessions.js';
import { readWorkerTask } from 'pi-orchestration/worker-task';
import { completedWorkerReceipt, runtimeEnvironment } from './worker-task-evidence.js';

/** File requests cannot silently follow an agent into another conversation. */
export function requireSessionFile(session: PiRpcSession, file?: string): PiRpcSession {
  if (file && !session.referencesSessionFile(file)) throw new SessionOpenError('Runtime is serving a different conversation; the requested file was not resumed', 409, session.attachment?.muxId);
  return session;
}

/** Only complete owning evidence authorizes removal of a disconnected view. */
export function reconcileRuntimeExit(manager: LiveSessionManager, muxId: string): TerminalReceipt | null {
  const views = [...manager.sessions.values()].filter(view => view.attachment?.muxId === muxId);
  const env = views.length ? runtimeEnvironment(views[0]) : process.env;
  const task = readWorkerTask(muxId, env);
  if (task?.state === 'failed') throw Object.assign(new Error(`Worker task cleanup failed: ${task.error}`), { status: 503 });
  const receipt = lookupTerminalReceipt(muxId, env);
  if (!receipt) return null;
  if (task?.state === 'pending') throw Object.assign(new Error('Worker runtime exited; its owning task cleanup is still pending'), { status: 503 });
  for (const view of views) {
    if (view.attachedOwner?.placement === 'worker') completedWorkerReceipt(view, env);
  }
  for (const view of views) manager.removeExited(view.id, `pimux_exit:${receipt.signal ?? receipt.code}`, 'This agent was closed.', true, receipt);
  return receipt;
}
