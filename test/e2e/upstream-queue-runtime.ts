import { liveManager, launcher } from './fake-browser-runtime.ts';
import type { FakePimux } from '../fake-pimux.ts';
import { until } from '../fake-pimux.ts';
import type { JsonRecord } from '../../src/server/types.ts';

/** A socket-side Pi stand-in with authoritative state and dialog closure. */
export class BrowserRuntimePeer {
  readonly mux: FakePimux;
  private readonly dialogs = new Map<string, JsonRecord>();

  constructor(mux: FakePimux) {
    this.mux = mux;
    mux.withheld.add('prompt');
    mux.withheld.add('abort');
    const write = mux.write.bind(mux);
    mux.write = (socket, record) => {
      if (record.type === 'response' && record.command === 'get_state') record = { ...record, data: {
        sessionFile: (mux.entry.session as JsonRecord).file, isStreaming: !mux.idle, isCompacting: false, thinkingLevel: 'off',
      } };
      write(socket, record);
      if (record.type === 'response' && record.command === 'extension_ui_response' && this.dialogs.delete(String(record.id))) {
        mux.replay = [...this.dialogs.values()];
        mux.broadcast({ type: 'pimux_dialog_closed', id: record.id, reason: 'answered' });
      }
    };
  }

  get commands() { return this.mux.commands; }

  emit = (event: JsonRecord) => {
    if (event.type === 'agent_start') this.mux.idle = false;
    if (event.type === 'agent_settled' || event.type === 'response' && event.command === 'abort' && event.success === true) this.mux.idle = true;
    if (event.type === 'response' && event.command === 'get_state' && typeof (event.data as JsonRecord | undefined)?.isStreaming === 'boolean') {
      this.mux.idle = !(event.data as JsonRecord).isStreaming;
    }
    if (event.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(String(event.method))) {
      this.dialogs.set(String(event.id), event);
      this.mux.replay = [...this.dialogs.values()];
    }
    this.mux.broadcast(event);
  };

  nextCommand = (type: string) => {
    const start = this.commands.length;
    return until(() => this.commands.slice(start).find(command => command.type === type), `No ${type} command reached the runtime`);
  };
}

/**
 * Preserve upstream's browser-owned queue/deadline contract as a distinct test
 * view. The backing runtime and ownership are still protocol 2; only the API
 * metadata is projected into the upstream non-shared shape. Production shared
 * steering/queues are exercised separately by the detached-runtime E2E suite.
 */
export function installUpstreamQueueView() {
  const projected = new Set<string>();
  const broadcast = liveManager.broadcast.bind(liveManager);
  liveManager.broadcast = record => {
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
    if (record.type === 'live_session_snapshot' && sessionId && projected.has(sessionId)) record = { ...record, generation: undefined };
    if (record.type === 'event' && sessionId && projected.has(sessionId)) {
      const event = record.event as JsonRecord;
      if (event.type === 'pimux_dialog_closed' || event.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(String(event.method))) {
        const session = liveManager.get(sessionId)!;
        session.interactionRevision++;
        broadcast({ type: 'interaction_state', sessionId, pendingDialogs: session.dialogSnapshot(), interactionRevision: session.interactionRevision });
      }
    }
    broadcast(record);
  };
  return {
    expose(sessionId: string) {
      const session = liveManager.get(sessionId)!;
      projected.add(sessionId);
      session.attachedOwner = null;
      const snapshot = session.snapshot.bind(session);
      session.snapshot = async () => ({ ...await snapshot(), generation: undefined });
    },
    restore() { liveManager.broadcast = broadcast; },
  };
}

export function installBrowserRuntimePeers() {
  const peers: BrowserRuntimePeer[] = [];
  launcher.configure = mux => { peers.push(new BrowserRuntimePeer(mux)); };
  return peers;
}
