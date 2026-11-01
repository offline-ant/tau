/*
 * The pimux side of an attached tab: the snapshot sequence state machine.
 *
 * pimux delivers each snapshot as `pimux_snapshot`, N replay records and
 * `pimux_live`, contiguously, at one exact point of Pi's output (the
 * boundary). Tau publishes the snapshot to browsers only at `pimux_live`,
 * then the replay as ordinary events, so every browser renders the same
 * boundary followed by in-flight work. Open dialogs are tracked here because
 * Pi never says one closed; pimux does, with `pimux_dialog_closed`.
 *
 * A sequence can be cut short: by a gap, which a new snapshot follows, by a
 * replacement snapshot, by a failure or by Pi's exit. Its partial replay is
 * then discarded. Only a sequence that reaches its own `pimux_live` is published.
 */

import type { JsonRecord } from './types.js';
import { DIALOG_METHODS, PROTOCOL_VERSION, type SnapshotData, type SessionIdentity } from '@phimacs/pimux/protocol';
import { canonicalSessionPath } from '@phimacs/pimux/ownership';

const SEQUENCE_INTERRUPTIONS = new Set(['pimux_gap', 'pimux_snapshot', 'pimux_snapshot_failed', 'pimux_exit', 'pimux_session_changed', 'pimux_tree_changed']);

export type PimuxSnapshotRecord = JsonRecord & SnapshotData & {
  generation: number;
  reason?: string;
  run?: { active?: boolean; compacting?: boolean; tailTruncated?: boolean };
  replay: number;
};

export type AppliedSnapshot = { snapshot: PimuxSnapshotRecord; replay: JsonRecord[]; dialogs: JsonRecord[] };
export type PimuxExit = { code: number | null; signal: string | null; stderrTail: string };

type Waiter = { generation: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export function isDialogRequest(record: JsonRecord) {
  return record.type === 'extension_ui_request' && DIALOG_METHODS.has(String(record.method));
}

export class PimuxAttachment {
  readonly muxId: string;
  readonly socket: string;
  clientId: number | null = null;
  /** Pi's pid, for display only: a secondary never signals it. */
  piPid: number | null = null;
  /** Generation of the last snapshot published to browsers; -1 before the first. */
  appliedGeneration = -1;
  readonly dialogs = new Map<string, JsonRecord>();
  exit: PimuxExit | null = null;
  private collecting: { snapshot: PimuxSnapshotRecord; replay: JsonRecord[] } | null = null;
  private waiters: Waiter[] = [];
  private readonly onSnapshot: (applied: AppliedSnapshot) => void;
  private readonly expected: { piPid: number; sessionFile: string | null };
  private hello = false;
  private terminalError: Error | null = null;
  private lastFailure: { generation: number; error: Error } | null = null;
  ready = false;
  leafId: string | null = null;
  session: SessionIdentity | null = null;
  /** Complete flat tree at the authoritative boundary, distinct from UI projection. */
  snapshot: PimuxSnapshotRecord | null = null;
  private replayBytes = 0;

  constructor(muxId: string, socket: string, onSnapshot: (applied: AppliedSnapshot) => void, expected: { piPid: number; sessionFile: string | null }) {
    this.muxId = muxId;
    this.socket = socket;
    this.onSnapshot = onSnapshot;
    this.expected = expected;
  }

  /** Consumes protocol and replay records; returns false for records the session handles itself. */
  handle(record: JsonRecord): boolean {
    if (this.collecting && SEQUENCE_INTERRUPTIONS.has(String(record.type))) this.collecting = null;
    if (SEQUENCE_INTERRUPTIONS.has(String(record.type))) this.ready = false;
    if (this.collecting) {
      if (record.type === 'pimux_live') {
        if (record.generation === this.collecting.snapshot.generation && this.collecting.replay.length === this.collecting.snapshot.replay) this.finishSnapshot();
        else this.collecting = null;
        return true;
      }
      // Sequences are contiguous; a response here would belong to a command, not the replay.
      if (record.type === 'response') return false;
      // More records than announced: this is no longer the sequence, and must not grow without end.
      if (this.collecting.replay.length >= this.collecting.snapshot.replay) throw new Error('Runtime sent more replay records than announced');
      this.replayBytes += Buffer.byteLength(JSON.stringify(record));
      if (this.replayBytes > 64 * 1024 * 1024) throw new Error('Runtime replay exceeds bound');
      this.collecting.replay.push(record);
      return true;
    }
    switch (record.type) {
      case 'pimux_hello': {
        const capabilities = record.capabilities;
        if (record.protocol !== PROTOCOL_VERSION || record.muxId !== this.muxId || record.piPid !== this.expected.piPid
          || !Array.isArray(capabilities) || !['snapshot', 'stop', 'detached'].every(cap => capabilities.includes(cap))) {
          throw new Error('Runtime protocol, identity or capabilities mismatch');
        }
        this.hello = true;
        this.clientId = typeof record.clientId === 'number' ? record.clientId : null;
        this.piPid = typeof record.piPid === 'number' ? record.piPid : null;
        return true;
      }
      case 'pimux_snapshot': {
        if (!this.hello || !Number.isSafeInteger(record.generation) || !Number.isSafeInteger(record.replay)
          || Number(record.replay) < 0 || Number(record.replay) > 1_000_000 || !record.session || typeof record.session !== 'object') {
          throw new Error('Invalid runtime snapshot');
        }
        const snapshot = record as PimuxSnapshotRecord;
        if (this.appliedGeneration < 0 && this.expected.sessionFile && (!snapshot.session.file
          || canonicalSessionPath(snapshot.session.file) !== canonicalSessionPath(this.expected.sessionFile))) {
          throw new Error('Runtime is serving a different conversation');
        }
        if (snapshot.generation <= this.appliedGeneration) throw new Error('Runtime snapshot generation did not advance');
        this.replayBytes = 0;
        this.collecting = { snapshot, replay: [] };
        return true;
      }
      case 'pimux_live':
      case 'pimux_gap':
        return true;
      case 'pimux_snapshot_failed':
        this.fail(Number(record.generation), new Error(`pimux could not take a snapshot: ${String(record.error || 'unknown error')}`));
        return true;
      case 'pimux_dialog_closed':
        this.dialogs.delete(String(record.id));
        return false;
      case 'pimux_exit':
        this.exit = {
          code: typeof record.code === 'number' ? record.code : null,
          signal: typeof record.signal === 'string' ? record.signal : null,
          stderrTail: typeof record.stderrTail === 'string' ? record.stderrTail : '',
        };
        return false;
      default:
        if (isDialogRequest(record) && typeof record.id === 'string') this.dialogs.set(record.id, record);
        return false;
    }
  }

  private finishSnapshot() {
    const { snapshot, replay } = this.collecting!;
    this.collecting = null;
    const dialogs = replay.filter(isDialogRequest);
    this.dialogs.clear();
    for (const dialog of dialogs) this.dialogs.set(String(dialog.id), dialog);
    this.appliedGeneration = snapshot.generation;
    if (this.lastFailure && this.lastFailure.generation <= snapshot.generation) this.lastFailure = null;
    this.leafId = snapshot.leafId;
    this.session = snapshot.session;
    this.snapshot = snapshot;
    this.ready = true;
    this.onSnapshot({ snapshot, replay: replay.filter((record) => !isDialogRequest(record)), dialogs });
    const satisfied = this.waiters.filter((waiter) => waiter.generation <= snapshot.generation);
    this.waiters = this.waiters.filter((waiter) => waiter.generation > snapshot.generation);
    for (const waiter of satisfied) { clearTimeout(waiter.timer); waiter.resolve(); }
  }

  /** Resolves once a snapshot of `generation` or later has been published; generation 0 waits for the first. */
  waitFor(generation: number, timeoutMs = 35000): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.lastFailure && generation <= this.lastFailure.generation && this.appliedGeneration < generation) return Promise.reject(this.lastFailure.error);
    if (this.ready && this.appliedGeneration >= generation && this.appliedGeneration >= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        generation, resolve, reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new Error('pimux did not deliver the requested snapshot in time'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** `pimux_snapshot_failed` for `generation`: only requests it did not supersede fail. */
  private fail(generation: number, error: Error) {
    this.lastFailure = { generation, error };
    if (this.appliedGeneration < 0) this.terminalError = error;
    const failed = this.waiters.filter((waiter) => waiter.generation <= generation);
    this.waiters = this.waiters.filter((waiter) => waiter.generation > generation);
    for (const waiter of failed) { clearTimeout(waiter.timer); waiter.reject(error); }
  }

  /** The connection ended: nothing can satisfy the waiters any more. */
  close(error: Error) {
    this.terminalError = error;
    this.ready = false;
    this.collecting = null;
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters = [];
  }
}
