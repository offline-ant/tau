/*
 * pimux discovery: Pi processes other frontends (Emacs Pilish) share.
 *
 * pimux (pi-ant's orchestration/pimux, whose README is the protocol contract)
 * wraps one `pi --mode rpc` per session and publishes `<muxId>.json` plus a
 * `<muxId>.sock` in a private per-user directory. Tau attaches to those
 * sockets instead of spawning a second Pi on the same session file, and lists
 * the entries as the agent overview.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import type { JsonRecord } from './types.js';
import { LineSplitter } from './transport.js';

export const PIMUX_PROTOCOL = 1;

export type PimuxRef = { host: string; endpoint: string; id: string; name?: string };
export type PimuxStatus = 'starting' | 'blocked' | 'working' | 'idle';
export type PimuxEntry = {
  protocol: number;
  muxId: string;
  socket: string;
  pid: number;
  /** Null until Pi has been spawned. */
  piPid: number | null;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  status: PimuxStatus;
  blocked: { reason: 'dialog'; method?: string; title?: string } | { reason: 'worker-waiting' } | null;
  /** While `starting`, only the intended `file` is known; null without `--session`. */
  session: { file: string | null; id: string | null; name: string | null } | null;
  model: { provider: string; id: string } | null;
  thinkingLevel: string | null;
  placement: 'root' | 'worker' | 'interactive-fork';
  orchestration: PimuxRef | null;
  parent: PimuxRef | null;
};

/** The name people know a shared agent by. */
export function pimuxDisplayName(entry: PimuxEntry) {
  const base = entry.cwd.split('/').filter(Boolean).pop() || entry.cwd;
  if (entry.session?.name) return entry.session.name;
  const id = entry.orchestration?.id;
  if (!id) return base;
  // Emacs targets are chat buffers (`*pilish-chat:/dir/<name>*`) and opaque worker ids.
  if (/^\*pilish-chat:.*\*$/.test(id)) return /<([^<>]+)>\*$/.exec(id)?.[1] ?? base;
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id) ? `worker ${id.slice(0, 8)}` : id;
}

/** `PIMUX_DIR`, else `/tmp/pi-mux-<uid>`, exactly as pimux chooses it. */
export function pimuxDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.PIMUX_DIR || `/tmp/pi-mux-${process.getuid?.() ?? 'user'}`;
}

/** Entries are trusted only in a private directory of this user, which pimux itself requires. */
function privateDirectory(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    const uid = process.getuid?.();
    return stat.isDirectory() && (uid === undefined || stat.uid === uid) && (stat.mode & 0o077) === 0;
  } catch { return false; }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEntry(file: string): PimuxEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(parsed) || parsed.protocol !== PIMUX_PROTOCOL) return undefined;
    if (typeof parsed.muxId !== 'string' || typeof parsed.socket !== 'string' || typeof parsed.cwd !== 'string') return undefined;
    return parsed as unknown as PimuxEntry;
  } catch { return undefined; }
}

export function processAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function listPimuxEntries(dir = pimuxDirectory()): PimuxEntry[] {
  if (!privateDirectory(dir)) return [];
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .map((name) => readEntry(path.join(dir, name)))
    .filter((entry): entry is PimuxEntry => entry !== undefined);
}

function canonical(file: string) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

function pimuxEntriesForFile(sessionFile: string, dir: string): PimuxEntry[] {
  const wanted = canonical(sessionFile);
  return listPimuxEntries(dir).filter((entry) => entry.session?.file && canonical(entry.session.file) === wanted);
}

export function pimuxEntryForFile(sessionFile: string, dir = pimuxDirectory()): PimuxEntry | undefined {
  return pimuxEntriesForFile(sessionFile, dir)[0];
}

/** Shared session files (canonical path) to their mux id, read once for a listing. */
export function pimuxFiles(dir = pimuxDirectory()): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of listPimuxEntries(dir)) if (entry.session?.file) files.set(canonical(entry.session.file), entry.muxId);
  return files;
}

export function pimuxEntryById(muxId: string, dir = pimuxDirectory()): PimuxEntry | undefined {
  return listPimuxEntries(dir).find((entry) => entry.muxId === muxId);
}

/**
 * `reachable`: the socket accepts. `stale`: it refuses (or is missing) and
 * neither the wrapper nor its Pi is alive. `unreachable`: anything else — a
 * wrapper still starting, or a Pi that may still be writing — so opening its
 * file here must fail closed. A wrapper publishes the file it is about to open
 * before it spawns Pi, so `starting` entries take part in this too.
 */
export type PimuxReachability = 'reachable' | 'unreachable' | 'stale';

export function probePimux(entry: PimuxEntry, timeoutMs = 2000): Promise<PimuxReachability> {
  return new Promise((resolve) => {
    const decide = () => resolve(processAlive(entry.pid) || processAlive(entry.piPid) ? 'unreachable' : 'stale');
    const socket = net.connect(entry.socket);
    const timer = setTimeout(() => { socket.destroy(); resolve('unreachable'); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('reachable'); });
    socket.once('error', () => { clearTimeout(timer); socket.destroy(); decide(); });
  });
}

export type PimuxSharing = { entry: PimuxEntry; reachability: Exclude<PimuxReachability, 'stale'> };

/**
 * Who shares `sessionFile`, or null when only stale entries name it. A stale
 * entry never hides a live one: a crashed wrapper's file can lie beside the
 * entry of the Pi that reopened the session.
 */
export async function pimuxSharing(sessionFile: string, dir = pimuxDirectory()): Promise<PimuxSharing | null> {
  const probed = await Promise.all(pimuxEntriesForFile(sessionFile, dir).map(async (entry) => ({ entry, reachability: await probePimux(entry) })));
  const reachable = probed.find((item) => item.reachability === 'reachable');
  const live = reachable ?? probed.find((item) => item.reachability === 'unreachable');
  return live ? { entry: live.entry, reachability: live.reachability as PimuxSharing['reachability'] } : null;
}

/** One command over a short-lived secondary connection; resolves with Pi's response. */
export function pimuxCommand(entry: PimuxEntry, command: JsonRecord, timeoutMs = 30000): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    const id = `tau-once-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const socket = net.connect(entry.socket);
    const lines = new LineSplitter();
    const done = (error: Error | null, response?: JsonRecord) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(response!);
    };
    const timer = setTimeout(() => done(new Error(`pimux ${entry.muxId} did not answer ${String(command.type)}`)), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ ...command, id }) + '\n'));
    socket.on('data', (chunk: string) => lines.push(chunk, (line) => {
      let record: unknown;
      try { record = JSON.parse(line); } catch { return; }
      if (isRecord(record) && record.type === 'response' && record.id === id) done(null, record);
    }));
    socket.once('error', (error) => done(error));
    socket.once('close', () => done(new Error(`pimux ${entry.muxId} closed before answering ${String(command.type)}`)));
  });
}
