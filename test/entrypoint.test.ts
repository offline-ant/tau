import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const TEST_AGENT_DIR = path.join(os.tmpdir(), 'tau-entrypoint-test-agent');
const CHILD_ENV = {
  ...process.env,
  PI_CODING_AGENT_DIR: TEST_AGENT_DIR,
  PI_CODING_AGENT_SESSION_DIR: path.join(TEST_AGENT_DIR, 'sessions'),
  TAU_HOST: '127.0.0.1',
  TAU_PORT: '0',
  TAU_HTTP_PORT: '0',
  TAU_STATIC_DIR: path.join(PROJECT_ROOT, 'public'),
};

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 5_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('node . starts Tau through the package main entry', async (t) => {
  const child = spawn(process.execPath, ['.'], {
    cwd: PROJECT_ROOT,
    env: CHILD_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  const exitPromise = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  await withTimeout(new Promise<void>((resolve, reject) => {
    child.stdout.on('data', () => {
      if (stdout.includes('[Tau] Server running')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`Tau exited before starting (code ${code}, signal ${signal}).\n${stderr}`));
    });
  }), `Tau did not start within 5 seconds.\n${stderr}`);

  child.kill('SIGTERM');
  const [code, signal] = await withTimeout(
    exitPromise,
    `Tau did not stop after SIGTERM.\n${stdout}\n${stderr}`,
  );
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
});

test('Tau can be imported by an ESM stdin entry point', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    cwd: PROJECT_ROOT,
    env: CHILD_ENV,
    input: [
      "import tau from './bin/tau.js';",
      "if (typeof tau.startCli !== 'function') throw new Error('missing startCli export');",
      "console.log('Tau imported');",
    ].join('\n'),
    encoding: 'utf8',
  });

  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'stdin import failed');
  assert.equal(result.stdout.trim(), 'Tau imported');
});
