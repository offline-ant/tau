import { runtimeEnvironment, cwd } from './runtime-environment.ts';
import { after, type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DiscoveryRecord } from '@phimacs/pimux/discovery';
import type { JsonRecord } from '../src/server/types.ts';
import { LiveSessionManager } from '../bin/sessions.js';
import type { LiveSessionManager as Manager, PiRpcSession } from '../src/server/sessions.ts';
import { FakePimux, until } from './fake-pimux.ts';
export { runtimeEnvironment, cwd };
after(() => fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }));
export async function runtimeFixture(t: TestContext, configure?: (mux: FakePimux) => void) {
  const id = randomUUID();
  const file = path.join(runtimeEnvironment.sessions, `${id}.jsonl`);
  const mux = new FakePimux(process.env.PIMUX_DIR!, id, { sessionFile: file, cwd });
  configure?.(mux);
  await mux.listen();
  const manager = new LiveSessionManager();
  t.after(async () => { await manager.shutdown(); await mux.close(); });
  const { session } = await manager.attach(mux.entry as unknown as DiscoveryRecord);
  await until(() => session.pending.size === 0, 'initial metadata acknowledged');
  const emit = async (...records: JsonRecord[]) => {
    for (const record of records) mux.broadcast(record);
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  return { mux, manager: manager as unknown as Manager, session: session as PiRpcSession, file, emit };
}
