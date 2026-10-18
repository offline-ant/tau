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
 * The endpoint carries HTTP Basic credentials in its userinfo when auth is
 * configured, because it must be sufficient on its own to call the API. The
 * runtime file is therefore owner-only, like any other credential file.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isIP } from 'node:net';

import { HOST, PI_AGENT_DIR, TAU_SETTINGS } from './config.js';

export const RUNTIME_DIR = path.join(PI_AGENT_DIR, 'tau');
export const RUNTIME_FILE = path.join(RUNTIME_DIR, 'server.json');

type RuntimeFile = { endpoint: string; pid: number; startedAt: string; browserUrls?: string[] };

let endpoint = '';

/** Wildcard listeners use loopback for local orchestration, never a LAN address. */
function endpointHost(address: string): string {
  if (!address || address === '0.0.0.0' || address === 'localhost') return '127.0.0.1';
  if (address === '::') return '[::1]';
  return address.includes(':') ? `[${address}]` : address;
}

/** Only numeric addresses on the listener's family; scoped IPv6 is not a browser URL. */
export function buildBrowserUrls(port: number, address = HOST, interfaces = os.networkInterfaces()): string[] {
  const wildcard = address === '0.0.0.0' || address === '::';
  const family = address === '::' ? 6 : 4;
  const addresses = wildcard
    ? [...Object.values(interfaces).flatMap((entries) => entries ?? []).filter((entry) => !entry.internal).map((entry) => entry.address), family === 6 ? '::1' : '127.0.0.1']
    : [address];
  return [...new Set(addresses)].filter((host) => {
    const version = isIP(host);
    return version !== 0 && (!wildcard || version === family) && host !== '0.0.0.0' && host !== '::'
      && !host.includes('%') && !/^fe[89ab]/i.test(host);
  }).map((host) => `http://${host.includes(':') ? `[${host}]` : host}:${port}`);
}

export function buildEndpoint(port: number, address = HOST): string {
  const credentials = TAU_SETTINGS.user && TAU_SETTINGS.pass
    ? `${encodeURIComponent(TAU_SETTINGS.user)}:${encodeURIComponent(TAU_SETTINGS.pass)}@`
    : '';
  return `http://${credentials}${endpointHost(address)}:${port}`;
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
export function publishEndpoint(port: number, address = HOST): void {
  endpoint = buildEndpoint(port, address);
  const existing = readRuntimeFile();
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    console.log(`[Tau] Another tau server (pid ${existing.pid}) owns ${RUNTIME_FILE}; orchestration discovery keeps pointing at it. Use PI_ORCHESTRATION_ENDPOINT to target this instance.`);
    return;
  }
  const record: RuntimeFile = { endpoint, pid: process.pid, startedAt: new Date().toISOString(), browserUrls: buildBrowserUrls(port, address) };
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
