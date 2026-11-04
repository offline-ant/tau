import { lookupTerminalReceipt, type TerminalReceipt } from '@phimacs/pimux/runtime';
import { isRecord } from '@phimacs/pimux/protocol';
import type { PiRpcSession } from './sessions.js';
import { captureWorkerTask, completedWorkerReceipt, runtimeEnvironment, waitForWorkerCleanup } from './worker-task-evidence.js';

const closing = new WeakMap<PiRpcSession, Promise<TerminalReceipt>>();
const observing = new WeakMap<PiRpcSession, AbortController>();
export function cancelWorkerObservation(session: PiRpcSession): void { observing.get(session)?.abort(); }

function requireWorkerExit(session: PiRpcSession, env: NodeJS.ProcessEnv): void {
  if (session.attachment?.exit || lookupTerminalReceipt(session.attachment!.muxId, env)) return;
  throw Object.assign(new Error('Worker connection was lost; cancellation delivery is uncertain. Reconnect this agent before closing it again; no prompt was replayed.'), { status: 503 });
}

/** Remote closure waits for the same parent cleanup as a local Close request. */
export function observeWorkerExit(session: PiRpcSession): void {
  if (closing.has(session) || observing.has(session)) return;
  const controller = new AbortController();
  observing.set(session, controller);
  void (async () => {
    const env = runtimeEnvironment(session);
    const binding = captureWorkerTask(session, env);
    const receipt = await waitForWorkerCleanup(session, binding, env, 15000, controller.signal);
    session.manager.removeExited(session.id, 'worker_task_complete', 'This worker was closed.', true, receipt);
  })().catch(error => {
    if (session.manager.get(session.id) !== session || controller.signal.aborted) return;
    session.manager.broadcastUpdated(session.id);
    session.manager.broadcast({ type: 'event', sessionId: session.id, event: {
      type: 'extension_ui_request', method: 'notify', notifyType: 'error', message: String(error instanceof Error ? error.message : error),
    } });
  }).finally(() => observing.delete(session));
}

export function closeWorker(session: PiRpcSession, timeoutMs = 15000): Promise<TerminalReceipt> {
  const pending = closing.get(session);
  if (pending) return pending;
  const operation = (async () => {
    const env = runtimeEnvironment(session);
    const binding = captureWorkerTask(session, env);
    if (binding.state === 'complete') return completedWorkerReceipt(session, env);
    const deadline = performance.now() + timeoutMs;
    const remaining = () => Math.max(1, deadline - performance.now());
    if (session.exited) requireWorkerExit(session, env);
    else {
      try {
        const commands = await session.send({ type: 'get_commands' }, { timeoutMs: remaining() });
        const data = commands.data;
        if (commands.success !== true || !isRecord(data) || !Array.isArray(data.commands)
          || !data.commands.some(command => isRecord(command) && command.name === 'worker-cancel' && command.source === 'extension')) {
          throw new Error('This worker does not advertise worker-cancel; no cancellation prompt was sent');
        }
        // Recheck the exact pending binding after the asynchronous capability read.
        if (captureWorkerTask(session, env).state === 'complete') return completedWorkerReceipt(session, env);
        const response = await session.send({ type: 'prompt', message: '/worker-cancel' }, { timeoutMs: remaining() });
        if (response.success !== true) throw new Error(String(response.error || 'Worker cancellation was refused'));
      } catch (error) {
        if (!session.exited) throw error;
        requireWorkerExit(session, env);
      }
    }
    return await waitForWorkerCleanup(session, binding, env, remaining());
  })().finally(() => closing.delete(session));
  closing.set(session, operation);
  return operation;
}
