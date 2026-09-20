/*
 * Session files owned by another Pi process.
 *
 * pi-ant's orchestration writes one JSON file per live worker, panel, or
 * interactive fork into a shared registry directory, each recording the host
 * that runs it and the session file it writes. Tau reads that registry so it
 * never attaches a second `pi` process to a session another terminal is
 * already appending to: two writers on one JSONL file interleave entries and
 * fork the conversation tree without anyone noticing.
 *
 * Sessions this server hosts itself are not "owned" in that sense — they are
 * live tabs here — so web targets are ignored.
 *
 * The registry is advisory: an orchestrator that died leaves its file behind,
 * so ownership blocks resume with an explicit override rather than forbidding
 * it outright.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REGISTRY_DIR = path.join(os.tmpdir(), 'pi-orchestration-targets');

export type SessionOwner = { name: string; host: string };

function ownerOf(file: string): { sessionFile: string; owner: SessionOwner } | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, file), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const target = (parsed as { target?: unknown }).target;
    if (typeof target !== 'object' || target === null) return null;
    const { host, name, sessionFile } = target as { host?: unknown; name?: unknown; sessionFile?: unknown };
    if (typeof host !== 'string' || typeof name !== 'string' || typeof sessionFile !== 'string') return null;
    if (host === 'web') return null;
    return { sessionFile: path.resolve(sessionFile), owner: { name, host } };
  } catch { return null; }
}

/** Resolved session file to the orchestration target writing it. */
export function sessionOwners(): Map<string, SessionOwner> {
  const owners = new Map<string, SessionOwner>();
  let files: string[];
  try { files = fs.readdirSync(REGISTRY_DIR); } catch { return owners; }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const entry = ownerOf(file);
    if (entry) owners.set(entry.sessionFile, entry.owner);
  }
  return owners;
}

export function sessionOwner(sessionFile: string): SessionOwner | undefined {
  return sessionOwners().get(path.resolve(sessionFile));
}
