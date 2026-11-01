/** Presentation helpers over pimux's owning discovery, identity and claim APIs. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { listDiscovery, muxDirectory, readDiscovery, ensurePrivateDirectory, type DiscoveryRecord, type OrchestrationRef } from '@phimacs/pimux/discovery';
import { canonicalSessionPath, lookupClaim } from '@phimacs/pimux/ownership';
import { processExists } from '@phimacs/pimux/process-identity';
import { isRecord, PROTOCOL_VERSION } from '@phimacs/pimux/protocol';
import { validateSocket, type RuntimeReceipt } from '@phimacs/pimux/runtime';
import { LineSplitter } from '@phimacs/pimux/jsonl';
import type { JsonRecord } from './types.js';

export const PIMUX_PROTOCOL = PROTOCOL_VERSION;
export type PimuxEntry = DiscoveryRecord;
export type PimuxRef = OrchestrationRef;
export const pimuxDirectory = muxDirectory;
export function processAlive(pid: unknown): boolean { return typeof pid === 'number' && processExists(pid); }
export function pimuxOwnerAlive(entry: PimuxEntry): boolean {
  return processExists(entry.ownerIdentity ?? entry.pid)
    || !!(entry.piIdentity ?? entry.piPid) && processExists(entry.piIdentity ?? entry.piPid!);
}
export function pimuxDisplayName(entry: PimuxEntry) {
  const base = path.basename(entry.cwd) || entry.cwd;
  if (entry.session?.name) return entry.session.name;
  const id = entry.orchestration?.id;
  if (!id) return base;
  if (/^\*pilish-chat:.*\*$/.test(id)) return /<([^<>]+)>\*$/.exec(id)?.[1] ?? base;
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id) ? `worker ${id.slice(0, 8)}` : id;
}
export function listPimuxEntries(dir = muxDirectory()): PimuxEntry[] {
  if (!fs.existsSync(dir)) return [];
  ensurePrivateDirectory(dir);
  return listDiscovery(dir);
}
export function pimuxEntryById(id: string, dir = muxDirectory()): PimuxEntry | undefined {
  return listPimuxEntries(dir).find(entry => entry.muxId === id);
}
export function pimuxEntryForFile(file: string, dir = muxDirectory()): PimuxEntry | undefined {
  const claim = lookupClaim(file);
  if (claim) {
    if (claim.owner.kind !== 'rpc' || !claim.owner.socket) return undefined;
    const entry = readDiscovery(path.join(path.dirname(claim.owner.socket), `${claim.owner.id}.json`));
    if (entry?.muxId === claim.owner.id && entry.session?.file
      && canonicalSessionPath(entry.session.file) !== canonicalSessionPath(claim.file)) {
      throw Object.assign(new Error('This old file is retained by a runtime serving another conversation; no operation was sent to that conversation'), { status: 409 });
    }
    return entry?.muxId === claim.owner.id ? entry : undefined;
  }
  const matches = listPimuxEntries(dir).filter(entry => entry.session?.file && canonicalSessionPath(entry.session.file) === canonicalSessionPath(file));
  return matches.find(pimuxOwnerAlive) ?? matches[0];
}
export function pimuxFiles(dir = muxDirectory()): Map<string, string> {
  return new Map(listPimuxEntries(dir).filter(entry => !!entry.session?.file && pimuxOwnerAlive(entry))
    .map(entry => [canonicalSessionPath(entry.session!.file!), entry.muxId]));
}
export function receiptFor(entry: PimuxEntry): RuntimeReceipt {
  if (entry.protocol !== PROTOCOL_VERSION || entry.phase !== 'committed' || !entry.operationId || !entry.piPid || !entry.session?.file) {
    throw new Error('Runtime is unsupported or not committed; no replacement writer was started');
  }
  return { protocol: PROTOCOL_VERSION, muxId: entry.muxId, operationId: entry.operationId, socket: entry.socket,
    pid: entry.pid, piPid: entry.piPid, sessionFile: entry.session.file, state: 'committed', outcome: 'attached' };
}
export type PimuxReachability = 'reachable' | 'unreachable' | 'stale';
export async function probePimux(entry: PimuxEntry, timeoutMs = 2000): Promise<PimuxReachability> {
  let receipt: RuntimeReceipt;
  try { receipt = receiptFor(entry); validateSocket(receipt.socket); }
  catch { return pimuxOwnerAlive(entry) ? 'unreachable' : 'stale'; }
  // Reachability proves this protected peer's hello, not application readiness.
  // The actual client still requires its complete snapshot/live boundary and
  // reports that boundary's failure rather than disguising it as owner absence.
  return new Promise(resolve => {
    const socket = net.connect(receipt.socket);
    let settled = false;
    const finish = (result: PimuxReachability) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy(); resolve(result);
    };
    const timer = setTimeout(() => finish('unreachable'), timeoutMs);
    const lines = new LineSplitter(line => {
      let record: unknown;
      try { record = JSON.parse(line); } catch { finish('unreachable'); return; }
      if (!isRecord(record) || record.type !== 'pimux_hello') return finish('unreachable');
      const capabilities = record.capabilities;
      finish(record.protocol === PROTOCOL_VERSION && record.muxId === receipt.muxId && record.piPid === receipt.piPid
        && Array.isArray(capabilities) && ['snapshot', 'stop', 'detached'].every(cap => capabilities.includes(cap)) ? 'reachable' : 'unreachable');
    }, 64 * 1024, () => finish('unreachable'));
    socket.on('data', (chunk: Buffer) => lines.push(chunk));
    socket.once('error', () => finish(pimuxOwnerAlive(entry) ? 'unreachable' : 'stale'));
    socket.once('close', () => finish(pimuxOwnerAlive(entry) ? 'unreachable' : 'stale'));
  });
}
export type PimuxSharing = { entry: PimuxEntry; reachability: Exclude<PimuxReachability, 'stale'> };
export async function pimuxSharing(file: string, dir = muxDirectory()): Promise<PimuxSharing | null> {
  const claim = lookupClaim(file);
  if (claim && (claim.owner.kind !== 'rpc' || claim.owner.protocol !== PROTOCOL_VERSION)) {
    throw Object.assign(new Error(`Session has a live or uncertain ${claim.owner.kind} owner; force cannot bypass ownership`), { status: 409 });
  }
  const entry = pimuxEntryForFile(file, dir);
  if (!entry) {
    if (claim) throw Object.assign(new Error('Session owner is unavailable; no replacement writer was started'), { status: 409 });
    return null;
  }
  const reachability = await probePimux(entry);
  if (reachability === 'stale' && !claim) return null;
  return { entry, reachability: reachability === 'stale' ? 'unreachable' : reachability };
}

/** One correlated operation, only after this connection validates its full boundary. */
export function pimuxCommand(entry: PimuxEntry, command: JsonRecord, timeoutMs = 30000): Promise<JsonRecord> {
  const receipt = receiptFor(entry);
  validateSocket(receipt.socket);
  return new Promise((resolve, reject) => {
    const id = `tau-once-${randomUUID()}`;
    const socket = net.connect(receipt.socket);
    let settled = false, hello = false, sent = false;
    let generation: number | undefined;
    const done = (error?: Error, response?: JsonRecord) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(response!);
    };
    const timer = setTimeout(() => done(new Error('Runtime command timed out; delivery may be uncertain')), timeoutMs);
    const lines = new LineSplitter(line => {
      let record: unknown;
      try { record = JSON.parse(line); } catch { done(new Error('Invalid runtime record')); return; }
      if (!isRecord(record)) return;
      if (record.type === 'pimux_hello') {
        const capabilities = record.capabilities;
        if (record.protocol !== PROTOCOL_VERSION || record.muxId !== receipt.muxId || record.piPid !== receipt.piPid
          || !Array.isArray(capabilities) || !['snapshot', 'stop', 'detached'].every(cap => capabilities.includes(cap))) {
          done(new Error('Runtime identity/protocol/capabilities mismatch')); return;
        }
        hello = true;
      } else if (record.type === 'pimux_snapshot' && hello && isRecord(record.session) && typeof record.session.file === 'string') {
        if (canonicalSessionPath(record.session.file) !== canonicalSessionPath(receipt.sessionFile)) return done(new Error('Runtime moved to another conversation'));
        generation = Number(record.generation);
      } else if (record.type === 'pimux_live' && hello && record.generation === generation && !sent) {
        sent = true; socket.write(JSON.stringify({ ...command, id }) + '\n');
      } else if (sent && record.type === 'response' && record.id === id) done(undefined, record);
      else if (record.type === 'pimux_exit' || record.type === 'pimux_snapshot_failed') done(new Error('Runtime unavailable'));
    }, 128 * 1024 * 1024, () => done(new Error('Runtime record exceeds bound')));
    socket.on('data', (chunk: Buffer) => lines.push(chunk));
    socket.once('error', done);
    socket.once('close', () => done(new Error('Runtime disconnected; command delivery may be uncertain')));
  });
}
