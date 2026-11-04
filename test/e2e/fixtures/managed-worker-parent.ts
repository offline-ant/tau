import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProcessIdentity } from '@phimacs/pimux/process-identity';
import { listRuntimes, lookupTerminalReceipt, startRuntime, stopRuntime, type RuntimeReceipt } from '@phimacs/pimux/runtime';
import { publishWorkerTask, finishWorkerTask } from 'pi-orchestration/worker-task';

const root = process.env.PHIMACS_TEST_ROOT!;
const taskId = process.env.FX_TASK_ID!;
const taskDirectory = path.join(root, taskId);
fs.mkdirSync(taskDirectory, { mode: 0o700 });
const leaseFile = path.join(taskDirectory, 'parent-task.json');
const parent = { process: readProcessIdentity(process.pid)!, taskId };
fs.writeFileSync(leaseFile, JSON.stringify({ schema: 1, ...parent, state: 'active' }), { mode: 0o600 });
const nameClaim = path.join(taskDirectory, 'worker-name');
fs.writeFileSync(nameClaim, taskId, { mode: 0o600 });
const pi = fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
let runtime: RuntimeReceipt | undefined;
let watcher: fs.FSWatcher | undefined;
const controller = new AbortController();
const cleanup = new Promise<void>(resolve => process.on('message', message => { if (message === 'cleanup') resolve(); }));
const finish = new Promise<void>(resolve => process.on('message', message => { if (message === 'finish') resolve(); }));
const stopping = new Promise<void>(resolve => {
  process.on('message', message => { if (message === 'shutdown') { controller.abort(); resolve(); } });
  process.once('disconnect', () => { controller.abort(); resolve(); });
});
try {
  runtime = await startRuntime({ command: pi, cwd: root, parent, env: { ...process.env,
    PHIMACS_PARENT_TASK: JSON.stringify(parent), PHIMACS_PARENT_TASK_FILE: leaseFile,
    PI_ORCHESTRATION_HOST: 'web', PI_ORCHESTRATION_PLACEMENT: 'worker' },
    args: ['--mode', 'rpc', '--session', path.join(root, 'sessions', `${taskId}.jsonl`),
      '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates',
      '--extension', fileURLToPath(new URL('./pimux-faux.ts', import.meta.url)),
      '--extension', fileURLToPath(import.meta.resolve('pi-orchestration/worker-frame')),
      '--provider', 'tau-fx', '--model', 'one'] });
  const worker = readProcessIdentity(runtime.piPid)!;
  const endpoint = process.env.FX_TAU_ENDPOINT!;
  const attached = await fetch(`${endpoint}/api/live-sessions/attach`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ muxId: runtime.muxId }) });
  const attachment = await attached.json() as { session: { id: string }; error?: string };
  if (!attached.ok) throw new Error(attachment.error);
  publishWorkerTask({ host: 'web', endpoint, id: attachment.session.id, kind: 'pi', name: taskId, runtime, process: worker }, { parent, file: leaseFile });
  process.send?.({ type: 'ready', entry: listRuntimes().find(entry => entry.muxId === runtime!.muxId), nameClaim });
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!lookupTerminalReceipt(runtime!.muxId)) return;
      watcher?.close(); watcher = undefined;
      resolve();
    };
    const abort = () => { watcher?.close(); reject(new Error('Parent fixture stopped')); };
    controller.signal.addEventListener('abort', abort, { once: true });
    watcher = fs.watch(path.join(process.env.PIMUX_DIR!, 'receipts'), check);
    watcher.once('error', reject);
    check();
  });
  process.send?.({ type: 'runtime-exited' });
  await Promise.race([cleanup, stopping]);
  if (controller.signal.aborted) throw new Error('Parent fixture stopped');
  const detached = await fetch(`${endpoint}/api/live-sessions/${attachment.session.id}`, { method: 'DELETE' });
  if (!detached.ok) throw new Error('Web host view disconnection failed');
  process.send?.({ type: 'view-disconnected' });
  await Promise.race([finish, stopping]);
  if (controller.signal.aborted) throw new Error('Parent fixture stopped');
  fs.unlinkSync(nameClaim);
  const final = finishWorkerTask(runtime.muxId, process.env.FX_CLEANUP_FAILURE ? { error: 'native cleanup failed' } : {});
  process.send?.({ type: 'task-finished', record: final });
  await stopping;
} catch (error) {
  if (!controller.signal.aborted) {
    process.exitCode = 1;
    process.send?.({ type: 'error', message: String(error instanceof Error ? error.message : error) });
  }
} finally {
  watcher?.close();
  if (runtime) await stopRuntime(runtime.muxId).catch(error => {
    process.exitCode = 1;
    process.send?.({ type: 'error', message: `Runtime cleanup uncertain: ${String(error)}` });
  });
  if (process.connected) process.disconnect();
}
