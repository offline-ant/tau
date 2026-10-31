/*
 * Agent overview: every pimux-shared Pi on this machine, from its discovery
 * files, watched so browsers see status changes as they happen.
 *
 * Discovery status is `starting`, `blocked`, `working` or `idle`. The
 * overview adds `done`, as pi-deck does: an agent that finished work (working
 * or blocked, then idle) is done until someone opens it here or it works
 * again. Opening is selecting its tab, which runs a pimux snapshot; an agent
 * attached in a Tau tab is never done, because its tab already shows it.
 */

import fs from 'node:fs';

import { listPimuxEntries, pimuxDirectory, pimuxDisplayName, processAlive, type PimuxEntry, type PimuxRef } from './pimux.js';

export type AgentStatus = 'starting' | 'blocked' | 'working' | 'done' | 'idle';
export type Agent = {
  muxId: string;
  name: string;
  cwd: string;
  status: AgentStatus;
  detail: string | null;
  placement: PimuxEntry['placement'];
  host: string | null;
  sessionFile: string | null;
  model: string | null;
  updatedAt: string;
  /** Mux id of the agent this one is nested under (a worker's parent), or null. */
  parentId: string | null;
  /** The Tau tab attached to it, if any. */
  tabId: string | null;
};

const sameRef = (a: PimuxRef | null, b: PimuxRef | null) =>
  !!a && !!b && a.host === b.host && a.endpoint === b.endpoint && a.id === b.id;

function detail(entry: PimuxEntry): string | null {
  if (entry.blocked?.reason === 'worker-waiting') return 'waiting for you';
  if (entry.blocked?.reason === 'dialog') return entry.blocked.title || `asks (${entry.blocked.method || 'dialog'})`;
  return entry.model ? `${entry.model.provider}/${entry.model.id}` : null;
}

export class AgentOverview {
  private readonly dir: string;
  private readonly tabFor: (muxId: string) => string | null;
  private readonly onChange: (agents: Agent[]) => void;
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private agents: Agent[] = [];
  private signature = '';
  /** Last discovery status and done flag per mux id. */
  private memory = new Map<string, { status: string; done: boolean }>();

  constructor(options: { dir?: string; tabFor: (muxId: string) => string | null; onChange: (agents: Agent[]) => void }) {
    this.dir = options.dir ?? pimuxDirectory();
    this.tabFor = options.tabFor;
    this.onChange = options.onChange;
  }

  /** Watches the directory; until it exists, and as a backstop for missed events, rereads periodically. */
  start(intervalMs = 5000) {
    this.refresh();
    this.timer = setInterval(() => { this.ensureWatcher(); this.refresh(); }, intervalMs);
    this.timer.unref();
    this.ensureWatcher();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.timer = this.debounce = this.watcher = null;
  }

  private ensureWatcher() {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.dir, () => this.schedule());
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch { /* Not created yet: the periodic reread retries. */ }
  }

  /** Rereads soon; a burst of renames becomes one update. */
  schedule() {
    if (this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = null; this.refresh(); }, 100);
    this.debounce.unref();
  }

  list() { return this.agents; }

  /** Someone opened this agent here: it is no longer done. */
  markSeen(muxId: string) {
    const memory = this.memory.get(muxId);
    if (!memory?.done) return;
    memory.done = false;
    this.refresh();
  }

  refresh() {
    const entries = listPimuxEntries(this.dir).filter((entry) => processAlive(entry.pid));
    const live = new Set(entries.map((entry) => entry.muxId));
    for (const id of this.memory.keys()) if (!live.has(id)) this.memory.delete(id);
    this.agents = entries.map((entry) => {
      const before = this.memory.get(entry.muxId);
      const tabId = this.tabFor(entry.muxId);
      // An agent open in a Tau tab is followed there; its tab is the signal.
      const finished = entry.status === 'idle' && (before?.status === 'working' || before?.status === 'blocked');
      const done = !tabId && entry.status === 'idle' && (finished || !!before?.done);
      this.memory.set(entry.muxId, { status: entry.status, done });
      const parent = entry.parent ? entries.find((other) => other !== entry && sameRef(other.orchestration, entry.parent)) : undefined;
      return {
        muxId: entry.muxId, name: pimuxDisplayName(entry), cwd: entry.cwd,
        status: done ? 'done' : entry.status, detail: detail(entry), placement: entry.placement,
        host: entry.orchestration?.host ?? null, sessionFile: entry.session?.file ?? null,
        model: entry.model ? `${entry.model.provider}/${entry.model.id}` : null, updatedAt: entry.updatedAt,
        parentId: parent?.muxId ?? null, tabId,
      };
    });
    const signature = JSON.stringify(this.agents.map(({ updatedAt: _updatedAt, ...agent }) => agent));
    if (signature === this.signature) return;
    this.signature = signature;
    this.onChange(this.agents);
  }
}
