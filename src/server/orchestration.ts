/*
 * Orchestration endpoint publishing.
 *
 * pi-ant's orchestration package can drive tau as a "web" host: it starts Pi
 * worker sessions through the HTTP API instead of a terminal pane. A Pi process
 * finds this server in two ways:
 *
 *  - Children tau spawns inherit PI_ORCHESTRATION_HOST/PI_ORCHESTRATION_ENDPOINT,
 *    the same ambient-marker pattern tmux and Herdr use.
 *  - Pi sessions started elsewhere (a tmux pane, an Emacs buffer) read the
 *    runtime file this module writes, so `/orchestration-host web` works there
 *    too.
 *
 * The endpoint is the loopback-only plain HTTP listener; browsers use the HTTPS
 * origins published alongside it. The endpoint carries HTTP Basic credentials
 * in its userinfo when auth is configured, because it must be sufficient on its
 * own to call the API. The runtime file is therefore owner-only, like any other
 * credential file.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isIP } from 'node:net';

import { HOST, PI_AGENT_DIR, TAU_SETTINGS } from './config.js';
import { reachableAddresses } from './tls.js';

export const RUNTIME_DIR = path.join(PI_AGENT_DIR, 'tau');
export const RUNTIME_FILE = path.join(RUNTIME_DIR, 'server.json');

type RuntimeFile = { endpoint: string; pid: number; startedAt: string; browserUrls?: string[] };

let endpoint = '';

/**
 * HTTPS origins for people opening Tau in a browser. Wildcard listeners list
 * configured host names and every reachable address on the listener's family.
 */
export function buildBrowserUrls(port: number, address = HOST, hostnames = TAU_SETTINGS.hostnames, interfaces = os.networkInterfaces()): string[] {
  const wildcard = address === '0.0.0.0' || address === '::';
  const family = address === '::' ? 6 : 4;
  const hosts = wildcard
    ? [...hostnames, ...reachableAddresses(interfaces).filter((host) => isIP(host) === family), family === 6 ? '::1' : '127.0.0.1']
    : isIP(address) && !address.includes('%') && !/^fe[89ab]/i.test(address) ? [address] : [];
  return [...new Set(hosts)].map((host) => `https://${host.includes(':') ? `[${host}]` : host}:${port}`);
}

/** Local orchestration always uses the loopback-only plain HTTP listener. */
export function buildEndpoint(port: number): string {
  const credentials = TAU_SETTINGS.user && TAU_SETTINGS.pass
    ? `${encodeURIComponent(TAU_SETTINGS.user)}:${encodeURIComponent(TAU_SETTINGS.pass)}@`
    : '';
  return `http://${credentials}127.0.0.1:${port}`;
}

/** Empty until the server is listening. */
export function orchestrationEndpoint(): string {
  return endpoint;
}

function readRuntimeFile(): RuntimeFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as RuntimeFile;
    return typeof parsed?.endpoint === 'string' && typeof parsed?.pid === 'number' ? parsed : null;
  } catch { return null; }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Publishes this server for discovery. A second concurrent instance leaves the
 * first one's file alone: two servers cannot both be "the" discoverable one,
 * and silently stealing the name would send workers to the wrong instance.
 */
export function publishEndpoint(httpPort: number, httpsPort: number, httpsAddress = HOST): void {
  endpoint = buildEndpoint(httpPort);
  const existing = readRuntimeFile();
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    console.log(`[Tau] Another tau server (pid ${existing.pid}) owns ${RUNTIME_FILE}; orchestration discovery keeps pointing at it. Use PI_ORCHESTRATION_ENDPOINT to target this instance.`);
    return;
  }
  const record: RuntimeFile = { endpoint, pid: process.pid, startedAt: new Date().toISOString(), browserUrls: buildBrowserUrls(httpsPort, httpsAddress) };
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
    const temp = `${RUNTIME_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(temp, RUNTIME_FILE);
  } catch (e) {
    console.warn(`[Tau] Could not publish the orchestration endpoint to ${RUNTIME_FILE}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function unpublishEndpoint(): void {
  const existing = readRuntimeFile();
  if (!existing || existing.pid !== process.pid) return;
  try { fs.rmSync(RUNTIME_FILE, { force: true }); } catch {}
}
