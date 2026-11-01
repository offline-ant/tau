/** HTML export opens only a private captured copy, never a live writer's file. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lookupClaim } from '@phimacs/pimux/ownership';
import { releaseHost } from './config.js';
import { PiRpcSession, LiveSessionManager } from './sessions.js';
import { pimuxSharing } from './pimux.js';
import { withStoppedSessionLease } from './session-files.js';

export async function exportSession(file: string, output: string, session?: PiRpcSession | null): Promise<string> {
  const host = releaseHost();
  let temporaryView: PiRpcSession | undefined;
  let captured: string;
  try {
    if (!session) {
      const claim = lookupClaim(file);
      const shared = claim && claim.owner.kind !== 'rpc' ? null : await pimuxSharing(file);
      if (shared?.reachability === 'unreachable') throw new Error('Runtime unavailable; export cannot obtain its authoritative conversation');
      if (shared) {
        temporaryView = new PiRpcSession(new LiveSessionManager(), { cwd: shared.entry.cwd, pimux: shared.entry });
        await temporaryView.start();
        session = temporaryView;
      }
    }
    if (session) {
      await session.snapshot();
      const boundary = session.attachment?.snapshot;
      if (!boundary || boundary.historyError || !Array.isArray(boundary.entries)) throw new Error('Runtime could not supply the complete session tree for export');
      captured = [JSON.stringify({ type: 'session', version: 3, id: boundary.session.id,
        timestamp: new Date().toISOString(), cwd: boundary.session.cwd }), ...boundary.entries.map(entry => JSON.stringify(entry))].join('\n') + '\n';
    } else {
      // A native managed writer is readable, but cannot be opened by a second Pi.
      // Copy its completed records without repairing/migrating the source.
      const read = () => fs.readFileSync(file, 'utf8');
      const live = lookupClaim(file);
      const text = live ? read() : await withStoppedSessionLease(file, read);
      const tail = text.slice(text.lastIndexOf('\n') + 1);
      if (!tail.trim()) captured = text;
      else {
        try { JSON.parse(tail); captured = `${text}\n`; }
        catch {
          if (!live) throw new Error('Stopped session has an incomplete final record; export did not alter it');
          captured = text.slice(0, text.lastIndexOf('\n') + 1);
        }
      }
      if (!captured.trim()) throw new Error('No complete session records to export');
    }
  } finally { await temporaryView?.terminate('export_view_closed'); }
  const directory = path.join(path.dirname(file), '.tau-export');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Unsafe export capture directory');
  const copy = path.join(directory, `${randomUUID()}.jsonl`);
  fs.writeFileSync(copy, captured, { flag: 'wx', mode: 0o600 });
  const cli = fileURLToPath(new URL('./bin/pimux', import.meta.resolve('@phimacs/pimux/package.json')));
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [cli, 'tui', '--', host.executable, '--no-extensions', '--no-skills',
        '--no-context-files', '--no-prompt-templates', '--export', copy, output],
      { timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message)); else resolve();
      });
    });
    if (!fs.existsSync(output)) throw new Error('Pi did not produce the requested HTML export');
    return output;
  } finally {
    // An uncertain managed writer retains its capture and claim for reconciliation.
    if (!lookupClaim(copy)) fs.rmSync(copy, { force: true });
  }
}
