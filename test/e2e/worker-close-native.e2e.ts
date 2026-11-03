import { runtimeEnvironment } from '../runtime-environment.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { DiscoveryRecord } from '@phimacs/pimux/discovery';
import { readWorkerTask } from 'pi-orchestration/worker-task';
import { server, liveManager } from '../../bin/server-main.js';
import { until } from '../fake-pimux.ts';

type Record_ = Record<string, unknown>;
let base: string;
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await liveManager.shutdown();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true });
});

for (const outcome of ['complete', 'failed'] as const) {
  test(`real managed parent final ${outcome} evidence, not worker exit, settles Tau Close`, { timeout: 60000 }, async t => {
    const child = fork(fileURLToPath(new URL('./fixtures/managed-worker-parent.ts', import.meta.url)), {
      env: { ...process.env, FX_TAU_ENDPOINT: base, FX_TASK_ID: `native-${outcome}`, FX_CLEANUP_FAILURE: outcome === 'failed' ? '1' : '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages: Record_[] = [];
    let diagnostics = '';
    child.stdout!.on('data', data => { diagnostics += String(data); });
    child.stderr!.on('data', data => { diagnostics += String(data); });
    child.on('message', message => { messages.push(message as Record_); });
    const message = async (type: string) => until(() => {
      const failure = messages.find(record => record.type === 'error');
      if (failure) throw new Error(String(failure.message));
      if (child.exitCode !== null || child.signalCode) throw new Error(`Parent exited before ${type}: ${diagnostics}`);
      return messages.find(record => record.type === type);
    }, type, 20000);
    t.after(async () => {
      await liveManager.shutdown();
      if (child.exitCode === null && !child.signalCode) {
        const closed = once(child, 'close');
        child.send('shutdown');
        const [code, signal] = await closed;
        assert.equal(signal, null, diagnostics);
        assert.equal(code, 0, diagnostics);
      }
    });
    const ready = await message('ready');
    const entry = ready.entry as DiscoveryRecord;
    const { session } = await liveManager.attach(entry);
    const broadcasts: Record_[] = [];
    t.mock.method(liveManager, 'broadcast', (record: Record_) => broadcasts.push(record));
    let acknowledged = false;
    const closing = fetch(`${base}/api/live-sessions/${session.id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    void closing.then(() => { acknowledged = true; });
    await message('runtime-exited');
    assert.equal(readWorkerTask(entry.muxId)?.state, 'pending');
    assert.equal(fs.existsSync(String(ready.nameClaim)), true, 'parent cleanup/name release has not run');
    assert.equal(acknowledged, false);
    assert.equal(liveManager.get(session.id), session);
    assert.equal(broadcasts.some(record => record.type === 'live_session_closed'), false);
    child.send('cleanup');
    await message('view-disconnected');
    assert.equal(readWorkerTask(entry.muxId)?.state, 'pending');
    assert.equal(acknowledged, false, 'host DELETE is not final parent cleanup');
    assert.equal(liveManager.get(session.id), session);
    assert.equal(broadcasts.some(record => record.type === 'live_session_closed'), false);
    child.send('finish');
    await message('task-finished');
    const response = await closing;
    const body = await response.json() as Record_;
    assert.equal(fs.existsSync(String(ready.nameClaim)), false);
    assert.equal(readWorkerTask(entry.muxId)?.state, outcome);
    if (outcome === 'complete') {
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal((body.receipt as Record_).muxId, entry.muxId);
      assert.equal(liveManager.get(session.id), undefined);
    } else {
      assert.equal(response.status, 503, JSON.stringify(body));
      assert.match(String(body.error), /native cleanup failed/);
      assert.equal(liveManager.get(session.id), session);
      assert.equal(broadcasts.some(record => record.type === 'live_session_closed'), false);
      await assert.rejects(liveManager.attachById(entry.muxId), /native cleanup failed/);
      assert.equal(liveManager.get(session.id), session);
    }
  });
}
