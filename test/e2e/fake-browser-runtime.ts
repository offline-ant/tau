import { runtimeEnvironment } from './fake-browser-environment.ts';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { FakeRuntimeLauncher } from '../runtime-launcher.ts';
import { server, computeUrls, liveManager, _setExecFileForTest } from '../../bin/tau.js';

export { runtimeEnvironment, projects } from './fake-browser-environment.ts';
export { server, computeUrls, liveManager };
export const launcher = new FakeRuntimeLauncher();
const originalStart = liveManager.runtime.start;

/** Only the launch transaction is injected; all session traffic uses Unix sockets. */
export function installFakeRuntime() {
  liveManager.runtime.start = launcher.start;
  _setExecFileForTest((_file: string, _args: string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => callback(null, '', ''));
}

export function listenFakeServer() {
  return new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      computeUrls(address.port);
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

export function launchBrowser() {
  const executablePath = process.env.CHROMIUM_BINARY || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  return chromium.launch({ executablePath });
}

export async function closeFakeRuntime() {
  await liveManager.shutdown();
  await launcher.close();
  liveManager.runtime.start = originalStart;
  _setExecFileForTest(null);
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true });
}
