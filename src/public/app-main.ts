/**
 * Main App - Ties everything together
 */

import { WebSocketClient } from './websocket-client.js';
import { StateManager } from './state.js';
import { clearSessionLinkHash, SessionLink } from './session-link.js';
import { MessageRenderer } from './message-renderer.js';
import { ToolCardRenderer, type ToolResult } from './tool-card.js';
import { attachCompletionList } from './completion-list.js';
import { modelMeta, modelRef, normalizeModelList, searchModels } from './model-match.js';
import { AssistantBlocks } from './assistant-blocks.js';
import { DialogHandler, type DialogRequest } from './dialogs.js';
import { SessionSidebar, type SidebarSession } from './session-sidebar.js';
import { themes, applyTheme, chooseTheme, getCurrentTheme, type ThemeId } from './themes.js';
import { FileBrowser, getFileIcon } from './file-browser.js';
import { setupLauncherPanel } from './launcher-panel.js';
import { setupModelPicker } from './model-picker.js';
import { setupTreeView } from './tree-view.js';
import { setupVoiceInput, type VoiceInput } from './voice-input.js';
import { setupCommandPalette } from './command-palette.js';
import { setupSessionStatsCard, type SessionStats } from './session-stats-card.js';
import { isImeComposition } from './keyboard.js';
import { buildHistoryItems, messageImages, type HistoryItem, type SessionHistoryEntry } from './history-render.js';
import { setupAgentsPanel, type OverviewAgent } from './agents-panel.js';
import { UnsentInputStore, type UnsentInput } from './unsent-input.js';

import type { AppEvent, AppMessage, AssistantStep, ExtensionUIRequest, InteractionState, LiveInstance, LiveSession, MessageContentBlock, ModelRecord, PendingDialog, PendingFilePath, PendingImage, QueuedCommand, RpcCommand, UsageRecord } from './app-types.js';

type LiveSessionSnapshotData = {
  sessionId?: string;
  sessionFile?: string | null;
  session?: LiveSession;
  isStreaming?: boolean;
  model?: ModelRecord | null;
  thinkingLevel?: string;
  entries?: SessionHistoryEntry[];
  pendingDialogs?: PendingDialog[];
  interactionRevision?: number;
  /** Attached tabs: the pimux boundary this snapshot describes, and its open dialogs. */
  generation?: number;
  dialogs?: AppEvent[];
};

type RpcEventDetail = { sessionId?: string; event?: AppEvent };

// Initialize components
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const wsClient = new WebSocketClient(wsUrl);
const state = new StateManager();
// All element lookups below query the app's static index.html shell, which is
// present before this module runs (the script is a deferred module at the end
// of <body>). A missing element means the page is structurally broken, so we
// assert non-null at the query site rather than guarding every usage.
const messageRenderer = new MessageRenderer(document.getElementById('messages')!);
const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages')!, true);
const dialogHandler = new DialogHandler(document.getElementById('dialog-container')!, {
  async send(command) {
    const response = await fetch('/api/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Could not send response. Please retry.');
  },
}, () => activeLiveSessionId);
const assistantBlocks = new AssistantBlocks(document.getElementById('messages')!);
const assistantBlockControllers = new Set([assistantBlocks]);
let expandedAssistantBlocks = false;

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById('session-list')!,
  handleSessionSelect,
  (cwd) => openNewLiveSessionModal(cwd),
  (message) => flashStatusError(message, 6000),
);
sidebar.onRendered = () => updateLiveSessionIndicators();

// UI elements
const messageInput = document.getElementById('message-input')!;
const chatForm = document.getElementById('chat-form')!;
const sendBtn = document.getElementById('send-btn')!;
const abortBtn = document.getElementById('abort-btn')!;
const statusIndicator = document.getElementById('status-indicator')!;
const statusText = document.getElementById('status-text')!;
// Tracks the pending timer that restores statusText after a transient
// status message (rpcCommand success/error). Any new status message must
// clear this so a stale restore cannot overwrite a later, longer-lived
// message (e.g. the red-dot error flash).
let statusRestoreTimer: ReturnType<typeof setTimeout> | null = null;
// Tracks the pending timer that restores the status indicator (dot) and
// text after a red-dot error flash. Kept SEPARATE from statusRestoreTimer
// so a normal setStatusMessage call cannot cancel the only callback that
// would clear the `error` class — otherwise an unrelated status update
// during the 3s flash would strand the dot red with no timer to reset it.
let statusFlashTimer: ReturnType<typeof setTimeout> | null = null;
// Restore the status indicator dot to its real connection/streaming state.
// Only touches the indicator class (not statusText), so callers can set the
// accompanying text themselves.
function restoreStatusIndicator() {
  const open = wsClient.ws?.readyState === WebSocket.OPEN;
  statusIndicator.className = `status-indicator ${
    open && state.isStreaming ? 'streaming' : (open ? 'connected' : 'disconnected')
  }`;
}
// Set a transient statusText message and, with `restoreMs`, schedule the
// return to the real connection state. Cancels any
// previously scheduled restore so overlapping messages cannot race. A new
// status message also supersedes any active error flash: it cancels the
// flash's restore and returns the dot to its real state so the `error`
// class cannot linger with no timer to clear it.
function setStatusMessage(text: string, restoreMs: number | null = null) {
  if (statusFlashTimer !== null) {
    clearTimeout(statusFlashTimer);
    statusFlashTimer = null;
    restoreStatusIndicator();
  }
  clearTimeout(statusRestoreTimer ?? undefined);
  statusText.textContent = text;
  if (restoreMs !== null) {
    statusRestoreTimer = setTimeout(() => {
      statusRestoreTimer = null;
      statusText.textContent = currentStatusText();
    }, restoreMs);
  }
}
// Turn the status indicator red and show an error message; after `ms`,
// restore the indicator to the real connection state and reset the text.
function flashStatusError(msg: string, ms = 3000) {
  // Reset the class atomically so no stale connected/disconnected/streaming
  // class lingers alongside `error` (matches updateConnectionStatus' style).
  statusIndicator.className = 'status-indicator error';
  // Cancel any pending status-text restore (e.g. rpcCommand's 'Done' ->
  // 'Connected' timer from an earlier successful step in the same flow) so it
  // cannot overwrite this error message while the red dot persists.
  clearTimeout(statusRestoreTimer ?? undefined);
  // Cancel any prior flash restore so overlapping flashes (a second
  // model-save failure within 3s) cannot leak a stray restore that
  // would reset the dot before this flash's own restore fires.
  clearTimeout(statusFlashTimer ?? undefined);
  statusText.textContent = msg;
  // Schedule the dot+text restore on the dedicated statusFlashTimer so a
  // later setStatusMessage (e.g. the user clicking the thinking-level cycle
  // button right after a thinking-level failure) cannot cancel the only
  // callback that clears the `error` class. If a new status message does
  // arrive, setStatusMessage itself retires the flash via restoreStatusIndicator.
  statusFlashTimer = setTimeout(() => {
    statusFlashTimer = null;
    restoreStatusIndicator();
    statusText.textContent = currentStatusText();
  }, ms);
}

const sidebarEl = document.getElementById('sidebar')!;
const sidebarToggle = document.getElementById('sidebar-toggle')!;
const sidebarOverlay = document.getElementById('sidebar-overlay')!;

const refreshSessionsBtn = document.getElementById('refresh-sessions-btn')!;
const typingIndicator = document.getElementById('typing-indicator')!;

const contextPillEl = document.getElementById('context-pill')!;
const scrollBottomBtn = document.getElementById('scroll-bottom-btn')!;
const scrollBottomBadge = document.getElementById('scroll-bottom-badge')!;
const messagesContainer = document.getElementById('messages')!;
const launcherPanel = setupLauncherPanel({
  launcherEl: document.getElementById('launcher')!,
  messagesContainer,
  async createSession(projectPath) {
    try {
      const res = await fetch('/api/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: projectPath, model: '' }),
      });
      const data = await res.json();
      if (data.session) {
        upsertLiveSession(data.session);
        await selectLiveSession(data.session.id);
      }
    } catch (e) {
      console.error('[Launcher] Failed to create Tau tab:', e);
    }
  },
});

// State tracking
const currentMessageSteps = new Map<number, HTMLElement>();
// A failed reply may still be replaced by Pi's retries before agent_settled.
let pendingAssistantError: { errorMessage: string } | null = null;
let retryStatusElement: HTMLElement | null = null;
let sessionTotalCost = 0;
let lastInputTokens = 0;
let contextWindowSize = 0;  // fetched from model info
let originalTitle = document.title;
let hasFocus = true;
let unreadCount = 0;
let isScrolledUp = false;
let hasNewWhileScrolled = false;
let lastSentMessage: string | null = null; // Track to avoid duplicate rendering from backend echo events
let lastUsage: UsageRecord | null = null; // Full usage object for context visualiser
let activeLiveSessionFile: string | null = null; // The active live session file path
let viewingActiveSession = false; // Whether we're viewing a live backend Tau tab or historical read-only session
let hasReceivedInitialServerState = false;
let liveInstances: LiveInstance[] = []; // Sidebar live indicators derived from backend live sessions
let liveSessions: LiveSession[] = [];
let activeLiveSessionId = localStorage.getItem('tau-active-live-session-id') || null;
let voiceInput: VoiceInput | null = null;
let takeRequest: { id: string; sessionId: string } | null = null;
let hasRestoredInitialLiveSession = false;
const sessionLink = new SessionLink(location.hash);
// A URL selects a view, not permission to submit that tab's queued input.
let resumeQueuedInput = true;
let pendingExtensionUIRequests: ExtensionUIRequest[] = []; // background notifications only
const interactionStates = new Map<string, InteractionState>();
// Native Pi dialogs use Tau's revisioned registry. Attached Pi dialogs use
// mux membership instead: only a newer snapshot or dialog_closed removes one.
const sharedDialogs = new Map<string, Map<string, AppEvent>>();
const sharedDialogGenerations = new Map<string, number>();
const operationRevisions = new Map<string, number>();
const sessionStateRevisions = new Map<string, number>();
const abortRequests = new Map<string, Promise<void>>();
const localAbortStates = new Map<string, NonNullable<LiveSession['abortState']>>();
const settledWhileStopping = new Set<string>();
type QueuedDispatch = {
  id: string;
  command: QueuedCommand;
  started: boolean;
  accepted: boolean;
  uncertain?: boolean;
  reconcileAfterReconnect?: boolean;
  reconciling?: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
};
const queuedPrompts = new Map<string, QueuedDispatch>();
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);
/** Extension UI for a terminal's chrome; Tau has no place for it, and it asks nothing of the user. */
const DISPLAY_UI_METHODS = new Set(['setStatus', 'setWidget', 'setTitle', 'set_editor_text']);
let reattachMuxId: string | null = null; // The shared agent on screen when Tau went away
const piQueues = new Map<string, { steering: string[]; followUp: string[] }>(); // Prompts Pi holds, by Tau tab
const sidebarFiles = new Set<string>(); // Session files whose first turn the sidebar has been refreshed for
let sidebarRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let agentSessionFiles = '';
dialogHandler.onIdle = () => {
  processQueuedExtensionUIRequest();
  focusComposer();
};

// File browser
const fileSidebar = document.getElementById('file-sidebar')!;
const fileSidebarToggle = document.getElementById('file-sidebar-toggle')!;
const fileSidebarClose = document.getElementById('file-sidebar-close')!;
const fileSidebarUp = document.getElementById('file-sidebar-up')!;
const fileList = document.getElementById('file-list')!;
const fileSidebarPath = document.getElementById('file-sidebar-path')!;
const fileBrowser = new FileBrowser(fileList, fileSidebarPath, messageInput, (filePath) => {
  const name = filePath.split(/[/\\]/).pop() || filePath;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  pendingFilePaths.push({ path: filePath, name, ext, sessionId: activeLiveSessionId });
  renderAttachmentPreviews();
}, () => (viewingActiveSession && liveSessions.some(s => s.id === activeLiveSessionId) ? activeLiveSessionId : null));

fileSidebarToggle.addEventListener('click', () => {
  const isCollapsed = fileSidebar.classList.toggle('collapsed');
  if (!isCollapsed && !fileBrowser.currentPath) {
    fileBrowser.load(); // Load session cwd
  }
  localStorage.setItem('tau-file-sidebar', isCollapsed ? 'closed' : 'open');
});

fileSidebarClose.addEventListener('click', () => {
  fileSidebar.classList.add('collapsed');
  localStorage.setItem('tau-file-sidebar', 'closed');
});

fileSidebarUp.addEventListener('click', () => {
  const parent = fileBrowser.getParentPath();
  if (parent) fileBrowser.load(parent);
});

fetch('/api/health').then(r => r.json()).then(data => {
  const names: Record<string, string> = { win32: 'Explorer', darwin: 'Finder', linux: 'file manager' };
  const name = names[data.platform] || 'file manager';
  document.getElementById('file-sidebar-finder')!.title = `Open in ${name}`;
}).catch(() => {});

document.getElementById('file-sidebar-finder')!.addEventListener('click', () => {
  const sessionId = viewingActiveSession && activeLiveSessionId ? activeLiveSessionId : null;
  if (fileBrowser.currentPath && sessionId) {
    fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: fileBrowser.currentPath, sessionId }),
    });
  }
});

// Restore file sidebar state
if (localStorage.getItem('tau-file-sidebar') === 'open') {
  fileSidebar.classList.remove('collapsed');
  fileBrowser.load();
}


// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener('focus', () => {
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});





window.addEventListener('blur', () => {
  hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wsClient.ws?.readyState !== WebSocket.OPEN) {
    console.log('[App] Returning to app, reconnecting...');
    wsClient.forceReconnect();
  }
});

// ═══════════════════════════════════════
// Scroll-to-bottom button + new message indicator
// ═══════════════════════════════════════

messagesContainer.addEventListener('scroll', () => {
  const threshold = 150;
  const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  isScrolledUp = !atBottom;
  
  if (atBottom) {
    scrollBottomBtn.classList.add('hidden');
    scrollBottomBadge.classList.add('hidden');
    hasNewWhileScrolled = false;
  } else {
    scrollBottomBtn.classList.remove('hidden');
  }
});

scrollBottomBtn.addEventListener('click', () => {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
  scrollBottomBtn.classList.add('hidden');
  scrollBottomBadge.classList.add('hidden');
  hasNewWhileScrolled = false;
});

function scrollToBottom() {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
}

// An on-screen keyboard shrinks only the visual viewport where the browser
// does not resize the layout (Chrome in fullscreen, iOS Safari). Fit the app to
// the visible area so the composer stays above the keyboard, keeping the latest
// message in view. Pinch zoom also shrinks the visual viewport; ignore it.
const visibleViewport = window.visualViewport;
if (visibleViewport) {
  const rootStyle = document.documentElement.style;
  const fitVisibleViewport = () => {
    const keepBottom = !isScrolledUp;
    if (Math.abs(visibleViewport.scale - 1) < 0.01) {
      rootStyle.setProperty('--visible-height', `${visibleViewport.height}px`);
      rootStyle.setProperty('--visible-top', `${visibleViewport.offsetTop}px`);
    } else {
      rootStyle.removeProperty('--visible-height');
      rootStyle.removeProperty('--visible-top');
    }
    if (keepBottom) messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'instant' });
  };
  visibleViewport.addEventListener('resize', fitVisibleViewport);
  visibleViewport.addEventListener('scroll', fitVisibleViewport);
  fitVisibleViewport();
}

function showNewMessageBadge() {
  if (isScrolledUp) {
    hasNewWhileScrolled = true;
    scrollBottomBadge.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

wsClient.addEventListener('connected', () => {
  updateConnectionStatus('connected');
  // Fetch model context window size for token % display
  setTimeout(fetchContextWindow, 1000);
  // A dispatch that settled while the socket was down never saw its
  // agent_settled. Ask Pi for fresh state so the lock cannot outlive the
  // operation it guarded; a still-running operation keeps it locked.
  for (const [sessionId, queued] of queuedPrompts) void reconcileAcceptedPrompt(sessionId, queued, true);
});

wsClient.addEventListener('disconnected', () => {
  updateConnectionStatus('disconnected');
  // Their acknowledgements went to this socket and can never arrive.
  unsentInput.keepInFlight();
  if (takeRequest) {
    takeRequest = null;
    updateLiveSessionInputState();
    flashStatusError('Connection lost during takeover. Reconnect and check the tab before trying again.', 8000);
  }
});

wsClient.addEventListener('reconnectFailed', () => {
  updateConnectionStatus('disconnected');
  messageRenderer.renderError('Connection lost. Please refresh the page.');
});

wsClient.addEventListener('rpcEvent', (e: Event) => {
  const detail = (e as CustomEvent<RpcEventDetail>).detail || {};
  const event = (detail.event || detail) as AppEvent;
  const sessionId = detail.sessionId;
  // pimux closes a shared dialog however it ended, in every browser.
  if (sessionId && event.type === 'pimux_dialog_closed') {
    closeSharedDialog(sessionId, String(event.id));
    return;
  }
  if (sessionId && event.type === 'pimux_session_changed' && sessionId === activeLiveSessionId && viewingActiveSession) {
    setStatusMessage('The shared session moved to another conversation', 4000);
  }
  if (takeRequest?.sessionId === sessionId && sessionId === activeLiveSessionId && viewingActiveSession) {
    // A handled command can still report failure through the extension UI.
    // Keep that structured error in the status bar through snapshot redraws.
    if (event.type === 'extension_error') flashStatusError(String(event.error), 8000);
    if (event.type === 'extension_ui_request' && event.method === 'notify' && event.notifyType === 'error') {
      flashStatusError(String(event.message), 8000);
    }
  }
  if (takeRequest && takeRequest.sessionId === sessionId && event.type === 'response' && event.id === takeRequest.id) {
    // The server publishes its authoritative snapshot before this actual
    // completion, even when HTTP already acknowledged a prompt timeout.
    takeRequest = null;
    updateLiveSessionInputState();
    if (event.success !== true) flashStatusError(String(event.error || 'Session takeover failed.'));
  }
  if (event.type === 'response' && typeof event.id === 'string') settlePrompt(event.id, event.success !== false, event.error);
  if (sessionId) {
    sessionStateRevisions.set(sessionId, (sessionStateRevisions.get(sessionId) || 0) + 1);
    const session = liveSessions.find(s => s.id === sessionId);
    if (event.type === 'agent_start') {
      operationRevisions.set(sessionId, (operationRevisions.get(sessionId) || 0) + 1);
      const queued = queuedPrompts.get(sessionId);
      if (queued) {
        queued.started = true;
        if (queued.uncertain) void reconcileAcceptedPrompt(sessionId, queued);
      }
    }
    if (event.type === 'agent_settled') {
      queuedPrompts.delete(sessionId);
      renderQueuedMessages();
      if (abortState(sessionId) === 'stopping') settledWhileStopping.add(sessionId);
      localAbortStates.delete(sessionId);
    }
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      if (event.type === 'agent_start' || event.type === 'turn_start') session.isStreaming = true;
      if (event.type === 'agent_settled') session.isStreaming = false;
      if (event.type === 'agent_start' || event.type === 'turn_start' || event.type === 'agent_settled') {
        // Keep an open tree modal honest: disable its rows while the turn
        // runs, and refetch the tree (re-enabling the rows) when it ends.
        treeViewController.notifyStreamingChanged(sessionId, !!session.isStreaming);
      }
      if (event.type === 'session_name' && event.name) session.sessionName = event.name;
      if (event.type === 'queue_update') {
        piQueues.set(sessionId, { steering: (event.steering as string[]) ?? [], followUp: (event.followUp as string[]) ?? [] });
        if (sessionId === activeLiveSessionId) renderQueuedMessages();
      }
      // A first prompt is what writes a new session's file.
      if (event.type === 'agent_end' && session.sessionFile && !sidebarFiles.has(session.sessionFile)) {
        sidebarFiles.add(session.sessionFile);
        scheduleSidebarRefresh();
      }
      if ((event.message as AppMessage)?.role === 'assistant' && (event.message as AppMessage)?.usage) session.contextUsage = { ...(session.contextUsage || {}), usage: (event.message as AppMessage).usage };
      renderLiveTabs();
    }
    if (sessionId !== activeLiveSessionId || !viewingActiveSession) {
      if (event.type === 'extension_ui_request' && !DISPLAY_UI_METHODS.has(String(event.method))) queueExtensionUIRequest(event, sessionId);
      return;
    }
  }
  handleRPCEvent(event, sessionId);
});

// Tau answers the sender on its socket even when no Pi ever saw the command.
wsClient.addEventListener('rpcResponse', (e: Event) => {
  const { id, success, error } = (e as CustomEvent<{ id?: unknown; success?: boolean; error?: string }>).detail;
  if (typeof id === 'string') settlePrompt(id, success !== false, error);
});

wsClient.addEventListener('serverError', (e: Event) => {
  messageRenderer.renderError((e as CustomEvent<{ message: string }>).detail.message);
});

wsClient.addEventListener('stateUpdate', (e: Event) => {
  const detail = (e as CustomEvent<{ liveSessions?: LiveSession[]; agents?: OverviewAgent[] }>).detail;
  const wasViewingLive = viewingActiveSession;
  const launcherVisible = launcherPanel.isVisible();
  const firstState = !hasReceivedInitialServerState;
  hasReceivedInitialServerState = true;
  // A restarted Tau has no tabs: the shared agents behind them may well run on.
  const remaining = new Set((detail.liveSessions || []).map(session => session.id));
  for (const session of liveSessions.filter(item => !remaining.has(item.id))) {
    if (session.id === activeLiveSessionId && session.attached) reattachMuxId ??= session.attached.muxId;
    keepUnsentInput(session);
  }
  setLiveSessions(detail.liveSessions || []);
  agentsPanel.update(detail.agents || []);
  if (!firstState) scheduleSidebarRefresh();
  // With nothing open yet, the shared agents are what a phone comes to see.
  if (firstState && !liveSessions.length && agentsPanel.count() && !/[#&]session=/.test(location.hash)) agentsPanel.show();
  if (applyPendingSessionLink()) {
    hasRestoredInitialLiveSession = true;
    return;
  }
  if (!hasRestoredInitialLiveSession || (wasViewingLive && !launcherVisible)) {
    hasRestoredInitialLiveSession = true;
    restoreActiveLiveSession();
  } else {
    if (activeLiveSessionId && !liveSessions.some(s => s.id === activeLiveSessionId)) {
      voiceInput?.cancel();
      activeLiveSessionId = null;
      activeLiveSessionFile = null;
      sidebar.clearActive();
      localStorage.removeItem('tau-active-live-session-id');
      renderQueuedMessages();
      renderLiveTabs();
    }
    updateLiveSessionInputState();
    updateLiveSessionIndicators();
    restoreUnsentInput();
  }
  // Tau came back: the agent on screen when it stopped is the one to return to.
  if (!firstState && reattachMuxId) {
    const muxId = reattachMuxId;
    reattachMuxId = null;
    if (detail.agents?.some(agent => agent.muxId === muxId)) void agentsPanel.open(muxId);
    else agentsPanel.show();
  }
});

wsClient.addEventListener('liveSessionCreated', (e: Event) => {
  upsertLiveSession((e as CustomEvent<LiveSession>).detail);
  scheduleSidebarRefresh();
});

wsClient.addEventListener('liveSessionUpdated', (e: Event) => {
  const detail = (e as CustomEvent<LiveSession>).detail;
  const previousAbortState = liveSessions.find(session => session.id === detail.id)?.abortState;
  upsertLiveSession(detail);
  // Native Abort acknowledgement can establish idle without agent_settled.
  // Never let an acknowledgement for an older operation stop a newer one:
  // the server's isStreaming metadata already accounts for that race.
  const acknowledgedStop = (previousAbortState && previousAbortState !== 'idle' && detail.abortState === 'idle') ||
    (!!detail.attached && localAbortStates.has(detail.id) && detail.isStreaming === false);
  if (acknowledgedStop) {
    localAbortStates.delete(detail.id);
    settledWhileStopping.delete(detail.id);
    if (detail.id === activeLiveSessionId && viewingActiveSession && detail.isStreaming === false) {
      state.setStreaming(false);
      assistantBlocks.setWorking(false);
      toolCardRenderer.settleNestedCalls();
      showTypingIndicator(false);
    }
  }
  if (viewingActiveSession && detail?.id === activeLiveSessionId) {
    applyActiveSessionMetadata(detail);
    updateUI();
  }
});

wsClient.addEventListener('liveSessionClosed', (e: Event) => {
  const detail = (e as CustomEvent<{ sessionId: string; reason?: string; message?: string; notice?: boolean }>).detail;
  const session = liveSessions.find(s => s.id === detail.sessionId);
  const muxId = session?.attached?.muxId;
  if (session && muxId) {
    // Closing tabs selects the next one, so only the first of a shutdown is the one on screen.
    if (detail.reason === 'server_shutdown' && session.id === activeLiveSessionId) reattachMuxId ??= muxId;
    if (detail.reason === 'pimux_disconnected' || detail.reason === 'server_shutdown') keepUnsentInput(session);
    else if (detail.reason?.startsWith('pimux_exit')) {
      // That agent is gone: what was on its way stays readable in the composer.
      keepUnsentInput(session);
      putInComposer(unsentInput.take(muxId));
    } else unsentInput.forget(muxId);
  }
  handleLiveSessionClosed(detail.sessionId, detail.message, detail.notice);
  scheduleSidebarRefresh();
});

wsClient.addEventListener('agentsUpdate', (e: Event) => {
  const agents = (e as CustomEvent<OverviewAgent[]>).detail || [];
  agentsPanel.update(agents);
  // Agents start and change sessions elsewhere too.
  const files = agents.map(agent => agent.sessionFile).sort().join('\n');
  if (files !== agentSessionFiles) scheduleSidebarRefresh();
  agentSessionFiles = files;
});

wsClient.addEventListener('interactionState', (e: Event) => {
  reconcileInteractionState((e as CustomEvent<InteractionState>).detail);
});

// Receive a full live-session state snapshot.
// Passive fanout updates only the live conversation currently being viewed.
// Explicit selection loads its own snapshot after setting viewingActiveSession.
// A shared tab's snapshots also carry its open dialogs, which apply to any tab.
wsClient.addEventListener('liveSessionSnapshot', (e: Event) => {
  const snapshot = (e as CustomEvent<LiveSessionSnapshotData>).detail;
  if (snapshot.sessionId && Array.isArray(snapshot.dialogs)) reconcileSharedDialogs(snapshot.sessionId, snapshot.dialogs, snapshot.generation);
  if (!viewingActiveSession || snapshot.sessionId !== activeLiveSessionId) return;
  const rendered = appliedGenerations.get(snapshot.sessionId);
  if (typeof snapshot.generation === 'number' && rendered !== undefined && rendered >= snapshot.generation) return;
  applyLiveSessionSnapshot(snapshot);
  if (typeof snapshot.generation === 'number') appliedGenerations.set(snapshot.sessionId, snapshot.generation);
  processQueuedExtensionUIRequest(snapshot.sessionId);
});

/**
 * pimux generation of the last shared-tab snapshot this view rendered. The
 * server publishes a snapshot and then its replayed in-flight work over the
 * WebSocket before it answers the HTTP snapshot request, so an HTTP answer
 * that is not newer would erase that replay.
 */
const appliedGenerations = new Map<string, number>();

/** A shared tab's open dialogs at a pimux boundary replace those this browser holds for it. */
function reconcileSharedDialogs(sessionId: string, dialogs: AppEvent[], generation?: number) {
  if (!liveSessions.find(session => session.id === sessionId)?.attached) return;
  const previous = sharedDialogGenerations.get(sessionId);
  // An HTTP answer for a boundary already received over the socket cannot
  // reopen a dialog closed (or erase one opened) by the subsequent replay.
  if (generation !== undefined && previous !== undefined && generation <= previous) return;
  if (generation !== undefined) sharedDialogGenerations.set(sessionId, generation);
  const open = new Map(dialogs.filter(dialog => DIALOG_METHODS.has(String(dialog.method)) && typeof dialog.id === 'string')
    .map(dialog => [String(dialog.id), dialog]));
  sharedDialogs.set(sessionId, open);
  const current = dialogHandler.currentRequest;
  if (current?.sessionId === sessionId && !open.has(String(current.id))) dialogHandler.clearCurrentDialog();
  renderLiveTabs();
  processQueuedExtensionUIRequest();
  // The snapshot caller applies metadata before updating input/dispatch. A
  // boundary that closes a dialog may simultaneously establish a busy run.
}

/** Another frontend answered it, or Pi stopped waiting: no browser may still offer it. */
function closeSharedDialog(sessionId: string, id: string) {
  if (!liveSessions.find(session => session.id === sessionId)?.attached) return;
  sharedDialogs.get(sessionId)?.delete(id);
  const current = dialogHandler.currentRequest;
  if (current?.sessionId === sessionId && String(current.id) === id) {
    dialogHandler.clearCurrentDialog();
    processQueuedExtensionUIRequest();
  }
  renderLiveTabs();
  if (viewingActiveSession && activeLiveSessionId === sessionId) updateUI();
}

// A link is one navigation request, not a preference reapplied on reconnect.
// Missing targets are rejected after the current server state, never kept as
// promises to select an unrelated future tab with that id.
function applyPendingSessionLink(): boolean {
  const intent = sessionLink.take(liveSessions.map(session => session.id));
  if (!intent) return false;
  clearSessionLinkHash(location, history);
  if (intent.kind === 'select') {
    void selectLiveSession(intent.id, false);
  } else {
    if (!hasRestoredInitialLiveSession) {
      activeLiveSessionId = null;
      viewingActiveSession = false;
      renderLiveTabs();
      updateLiveSessionInputState();
    }
    flashStatusError(intent.kind === 'missing'
      ? 'Linked Tau tab is no longer live. Select a tab to continue.'
      : 'Invalid Tau session link. Select a tab to continue.', 8000);
  }
  return true;
}

window.addEventListener('hashchange', () => {
  sessionLink.set(location.hash);
  if (hasReceivedInitialServerState && wsClient.ws?.readyState === WebSocket.OPEN) {
    applyPendingSessionLink();
  }
});

// ═══════════════════════════════════════
// Live-session tabs
// ═══════════════════════════════════════

const liveTabsList = document.getElementById('live-tabs-list');
const liveTabAddBtn = document.getElementById('live-tab-add');
const takeHerdrBtn = document.getElementById('take-herdr-btn')!;
takeHerdrBtn.addEventListener('click', () => { void takeFromHerdr(); });
const newLiveSessionOverlay = document.getElementById('new-live-session-overlay');
const newLiveSessionModal = document.getElementById('new-live-session-modal');
const newLiveSessionForm = document.getElementById('new-live-session-form');
const newLiveSessionCwd = document.getElementById('new-live-session-cwd') as HTMLInputElement;
const newLiveSessionModel = document.getElementById('new-live-session-model') as HTMLInputElement;
const newLiveSessionProjects = document.getElementById('new-live-session-projects');
const newLiveSessionSubmit = document.getElementById('new-live-session-submit')!;

function setLiveSessions(sessions: LiveSession[]) {
  liveSessions = sessions || [];
  liveInstances = liveSessions.map(s => ({ sessionFile: s.sessionFile, cwd: s.cwd, port: location.port }));
  renderLiveTabs();
  updateLiveSessionIndicators();
}

/** No tab is shown any more: the header must not keep describing the last one. */
function clearActiveSessionHeader() {
  modelPickerController.setModelState('', 'off');
  sessionTotalCost = 0;
  lastInputTokens = 0;
  lastUsage = null;
  updateContextPill();
}

function handleLiveSessionClosed(closedId: string, message?: string, notice = false) {
  if (!closedId) return;
  appliedGenerations.delete(closedId);
  sharedDialogs.delete(closedId);
  sharedDialogGenerations.delete(closedId);
  piQueues.delete(closedId);
  liveSessions = liveSessions.filter(s => s.id !== closedId);
  messageQueue = messageQueue.filter(cmd => cmd.sessionId !== closedId);
  pendingExtensionUIRequests = pendingExtensionUIRequests.filter(req => req.sessionId !== closedId);
  interactionStates.delete(closedId);
  operationRevisions.delete(closedId);
  sessionStateRevisions.delete(closedId);
  localAbortStates.delete(closedId);
  settledWhileStopping.delete(closedId);
  queuedPrompts.delete(closedId);
  if (dialogHandler.currentRequest?.sessionId === closedId) {
    dialogHandler.clearCurrentDialog();
    processQueuedExtensionUIRequest();
  }
  renderQueuedMessages();
  if (activeLiveSessionId === closedId) {
    const wasViewingActive = viewingActiveSession;
    voiceInput?.cancel();
    activeLiveSessionId = null;
    localStorage.removeItem('tau-active-live-session-id');
    activeLiveSessionFile = null;
    sidebar.clearActive();
    currentMessageSteps.clear();
    pendingAssistantError = null;
    retryStatusElement = null;
    state.reset();
    showTypingIndicator(false);
    if (wasViewingActive) {
      if (!message) clearConversation();
      const next = message ? null : getMostRecentLiveSession();
      if (message) {
        // A shared Pi exited or its connection was lost: say why, below the
        // conversation, which stays readable.
        viewingActiveSession = false;
        assistantBlocks.setWorking(false);
        if (notice) messageRenderer.renderNotice(message);
        else messageRenderer.renderError(message);
        clearActiveSessionHeader();
        updateLiveSessionInputState();
        updateUI();
      } else if (next) selectLiveSession(next.id);
      else {
        viewingActiveSession = false;
        messageRenderer.renderWelcome();
        clearActiveSessionHeader();
        updateLiveSessionInputState();
        updateUI();
      }
    } else {
      updateLiveSessionInputState();
      updateUI();
    }
  }
  liveInstances = liveSessions.map(s => ({ sessionFile: s.sessionFile, cwd: s.cwd, port: location.port }));
  renderLiveTabs();
  updateLiveSessionIndicators();
}

function upsertLiveSession(session: LiveSession) {
  if (!session) return;
  sessionStateRevisions.set(session.id, (sessionStateRevisions.get(session.id) || 0) + 1);
  const idx = liveSessions.findIndex(s => s.id === session.id);
  let shouldRenderTabs = false;
  if (idx >= 0) {
    const before = liveTabSignature(liveSessions[idx]);
    const movedFile = liveSessions[idx].sessionFile !== session.sessionFile;
    liveSessions[idx] = { ...liveSessions[idx], ...session };
    shouldRenderTabs = before !== liveTabSignature(liveSessions[idx]);
    if (movedFile) {
      if (session.id === activeLiveSessionId && viewingActiveSession) sidebar.setActive(session.sessionFile);
      scheduleSidebarRefresh();
    }
  } else {
    liveSessions.push(session);
    shouldRenderTabs = true;
  }
  liveInstances = liveSessions.map(s => ({ sessionFile: s.sessionFile, cwd: s.cwd, port: location.port }));
  if (shouldRenderTabs) renderLiveTabs();
  updateLiveSessionIndicators();
}

function getMostRecentLiveSession() {
  return [...liveSessions].sort((a, b) =>
    new Date(b.lastActiveAt || b.createdAt || 0).getTime() - new Date(a.lastActiveAt || a.createdAt || 0).getTime()
  )[0] || null;
}

function basename(p: string) {
  return (p || '').split(/[/\\]/).filter(Boolean).pop() || p || 'session';
}

function compactModelLabel(session: LiveSession) {
  const raw = session.modelLabel || session.modelSpec || (session.model as ModelRecord)?.id || (session.model as ModelRecord)?.name || 'default';
  return String(raw).replace(/^.*\//, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function liveTabTitle(session: LiveSession) {
  return session.sessionName || session.attached?.name || basename(session.cwd || '');
}

function liveTabSignature(session: LiveSession) {
  return [
    liveTabTitle(session),
    compactModelLabel(session),
    session.cwd || '',
    session.modelSpec || '',
    session.isStreaming ? 'streaming' : 'idle',
    pendingInteractionCount(session.id),
    session.attached ? 'shared' : '',
  ].join('\u001f');
}

function renderLiveTabs() {
  if (!liveTabsList) return;
  const existing = new Map<string, HTMLButtonElement>();
  liveTabsList.querySelectorAll<HTMLButtonElement>('.live-tab').forEach((tab) => {
    if (tab.dataset.sessionId) existing.set(tab.dataset.sessionId, tab);
  });
  const seen = new Set<string>();
  liveSessions.forEach((session, index) => {
    let tab = existing.get(session.id);
    if (!tab) {
      tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'live-tab';
      tab.dataset.sessionId = session.id;
      tab.addEventListener('click', () => selectLiveSession(session.id));
    }
    seen.add(session.id);
    tab.classList.toggle('active', session.id === activeLiveSessionId);
    tab.classList.toggle('shared', !!session.attached);
    tab.title = `${session.cwd || ''}${session.modelSpec ? ` • ${session.modelSpec}` : ''}${session.attached ? ` • shared with ${session.attached.host || 'another frontend'}` : ''}`;
    const signature = liveTabSignature(session);
    if (tab.dataset.signature !== signature) {
      tab.dataset.signature = signature;
      tab.innerHTML = `
        ${session.isStreaming ? '<span class="live-tab-streaming-dot"></span>' : ''}
        ${pendingInteractionCount(session.id) ? `<span class="live-tab-ui-dot" title="Waiting for approval" aria-label="${pendingInteractionCount(session.id)} pending approvals">${pendingInteractionCount(session.id)}</span>` : ''}
        <span class="live-tab-title">${escapeHtml(liveTabTitle(session))}</span>
        <span class="live-tab-model">${escapeHtml(compactModelLabel(session))}</span>
        <span class="live-tab-close" title="${session.attached ? 'Detach (the agent keeps running)' : 'Close Tau tab'}">×</span>
      `;
      tab.querySelector('.live-tab-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeLiveSession(session.id);
      });
    }
    const currentAtIndex = liveTabsList.children[index];
    if (currentAtIndex !== tab) liveTabsList.insertBefore(tab, currentAtIndex || null);
  });
  for (const [id, tab] of existing) {
    if (!seen.has(id)) tab.remove();
  }
}

function restoreActiveLiveSession() {
  const saved = activeLiveSessionId && liveSessions.find(s => s.id === activeLiveSessionId);
  const next = saved || getMostRecentLiveSession();
  if (next) {
    selectLiveSession(next.id, resumeQueuedInput);
  } else {
    activeLiveSessionId = null;
    viewingActiveSession = false;
    activeLiveSessionFile = null;
    sidebar.clearActive();
    localStorage.removeItem('tau-active-live-session-id');
    state.reset();
    renderQueuedMessages();
    renderLiveTabs();
    updateLiveSessionInputState();
  }
}

/** Sidebar lists come from disk: picks up sessions that appeared or moved, once a burst of changes settles. */
function scheduleSidebarRefresh() {
  if (sidebarRefreshTimer !== null) clearTimeout(sidebarRefreshTimer);
  sidebarRefreshTimer = setTimeout(() => {
    sidebarRefreshTimer = null;
    // A reconnect refreshes it anyway.
    if (wsClient.ws?.readyState === WebSocket.OPEN) void sidebar.refresh().then(updateLiveSessionIndicators);
  }, 400);
}

async function selectLiveSession(id: string, resumeQueue = true) {
  sessionLink.cancel();
  voiceInput?.cancel();
  const session = liveSessions.find(s => s.id === id);
  if (!session) return;
  resumeQueuedInput = resumeQueue;
  suspendCurrentDialogForTabSwitch(id);
  stopFollowing();
  launcherPanel.hide();
  activeLiveSessionId = id;
  localStorage.setItem('tau-active-live-session-id', id);
  viewingActiveSession = true;
  renderLiveTabs();
  renderQueuedMessages();
  applyActiveSessionMetadata(session);
  restoreUnsentInput();
  currentMessageSteps.clear();
  pendingAssistantError = null;
  retryStatusElement = null;
  state.reset();
  state.setStreaming(!!session.isStreaming);
  clearConversation();
  const requestedAtRevision = sessionStateRevisions.get(id) || 0;
  // A shared tab's snapshot request makes the server publish a fresh pimux
  // boundary over the WebSocket; only a WebSocket snapshot rendered in this
  // view can make the HTTP answer redundant.
  appliedGenerations.delete(id);
  try {
    const res = await fetch(`/api/live-sessions/${encodeURIComponent(id)}/snapshot`);
    const data = await res.json();
    if (id !== activeLiveSessionId || !viewingActiveSession) return;
    if (!res.ok || data.error) {
      // A shared tab whose snapshot failed is still attached; only a missing tab is gone.
      if (res.status === 404) handleLiveSessionClosed(id);
      throw new Error(data.error || 'Live session not found');
    }
    const rendered = appliedGenerations.get(id);
    if (typeof data.generation !== 'number' || rendered === undefined || rendered < data.generation) {
      applyLiveSessionSnapshot({ ...data, sessionId: id }, requestedAtRevision);
      if (typeof data.generation === 'number') appliedGenerations.set(id, data.generation);
    }
  } catch (e) {
    if (id !== activeLiveSessionId || !viewingActiveSession) return;
    messageRenderer.renderError((e instanceof Error ? e.message : '') || 'Failed to load live session snapshot');
    return;
  }
  if (!fileSidebar.classList.contains('collapsed')) fileBrowser.load();
  updateLiveSessionInputState();
  processQueuedExtensionUIRequest(id);
  flushQueue();
}

function applyActiveSessionMetadata(session: LiveSession) {
  if (!session) return;
  activeLiveSessionFile = session.sessionFile || null;
  sidebar.setActive(activeLiveSessionFile);
  // Server is canonical: session.model is always null or a full {provider,id}
  // object, so assign directly. No modelLabel/modelSpec string fallbacks.
  modelPickerController.setModelState(session.model || '', session.thinkingLevel || 'off');
}

async function closeLiveSession(id: string) {
  const session = liveSessions.find(s => s.id === id);
  if (!session) return;
  const hasQueuedMessages = messageQueue.some(cmd => cmd.sessionId === id);
  if (session.attached) {
    // Detaching stops nothing: the agent keeps running where it was started.
    if (hasQueuedMessages && !confirm('This shared tab has queued unsent messages. Detach and discard them?')) return;
  } else if (session.isStreaming || hasQueuedMessages) {
    const reason = session.isStreaming && hasQueuedMessages
      ? 'This Tau tab is streaming and has queued unsent messages. Close it, terminate the Pi session, and discard the queue?'
      : session.isStreaming
        ? 'This Tau tab is streaming. Close it and terminate the Pi session?'
        : 'This Tau tab has queued unsent messages. Close it and discard them?';
    if (!confirm(reason)) return;
  }
  try {
    await fetch(`/api/live-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (e) {
    messageRenderer.renderError('Failed to close Tau tab');
  }
}

async function loadProjectChips() {
  if (!newLiveSessionProjects) return;
  newLiveSessionProjects.innerHTML = '';
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    for (const project of data.projects || []) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'project-chip';
      chip.textContent = project.name;
      chip.title = project.path;
      chip.addEventListener('click', () => { newLiveSessionCwd.value = project.path; });
      newLiveSessionProjects.appendChild(chip);
    }
  } catch {}
}

// Model suggestions use the same list and matching as the status-bar model picker.
let newLiveSessionModels: Array<ModelRecord | string> = [];

async function loadNewLiveSessionModels() {
  try {
    const res = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_available_models', sessionId: null }) });
    const data = await res.json();
    if (data.success && data.data?.models) newLiveSessionModels = data.data.models;
  } catch {}
}

const cwdCompletion = attachCompletionList({
  input: newLiveSessionCwd,
  debounceMs: 100,
  continueAfterAccept: true,
  async getItems(text, signal) {
    const res = await fetch(`/api/complete/directories?prefix=${encodeURIComponent(text)}`, { signal });
    const data = await res.json();
    return (data.items || []).map((item: { name: string; path: string }) => ({ primary: item.name, value: `${item.path}/` }));
  },
});

const modelCompletion = attachCompletionList({
  input: newLiveSessionModel,
  highlightFirst: true,
  getItems(text) {
    if (text.includes(':')) return [];
    return searchModels(normalizeModelList(newLiveSessionModels), text).map((model) => ({
      primary: model.id,
      badge: model.provider,
      meta: modelMeta(model),
      value: modelRef(model),
    }));
  },
});

function openNewLiveSessionModal(cwd?: string) {
  newLiveSessionOverlay?.classList.remove('hidden');
  newLiveSessionModal?.classList.remove('hidden');
  newLiveSessionSubmit.disabled = false;
  if (cwd) newLiveSessionCwd.value = cwd;
  else if (!newLiveSessionCwd.value) newLiveSessionCwd.value = liveSessions.find(s => s.id === activeLiveSessionId)?.cwd || '';
  loadProjectChips();
  loadNewLiveSessionModels();
  requestAnimationFrame(() => newLiveSessionCwd?.focus());
}

function closeNewLiveSessionModal() {
  cwdCompletion.close();
  modelCompletion.close();
  newLiveSessionOverlay?.classList.add('hidden');
  newLiveSessionModal?.classList.add('hidden');
}

liveTabAddBtn?.addEventListener('click', () => openNewLiveSessionModal());
document.getElementById('new-live-session-close')?.addEventListener('click', closeNewLiveSessionModal);
document.getElementById('new-live-session-cancel')?.addEventListener('click', closeNewLiveSessionModal);
newLiveSessionOverlay?.addEventListener('click', closeNewLiveSessionModal);
newLiveSessionForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cwd = newLiveSessionCwd.value.trim();
  if (!cwd) return;
  newLiveSessionSubmit.disabled = true;
  newLiveSessionSubmit.textContent = 'Starting…';
  try {
    const res = await fetch('/api/live-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, model: newLiveSessionModel.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Failed to create Tau tab');
    upsertLiveSession(data.session);
    closeNewLiveSessionModal();
    newLiveSessionModel.value = '';
    await selectLiveSession(data.session.id);
    focusComposer();
  } catch (err) {
    messageRenderer.renderError((err instanceof Error ? err.message : '') || 'Failed to create Tau tab');
  } finally {
    newLiveSessionSubmit.disabled = false;
    newLiveSessionSubmit.textContent = 'Create tab';
  }
});

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

function clearRetryStatus() {
  retryStatusElement?.remove();
  retryStatusElement = null;
}

function showRetryStatus(event: AppEvent) {
  clearRetryStatus();
  const attempt = event.attempt ?? 1;
  const maxAttempts = event.maxAttempts ?? attempt;
  const delaySeconds = Math.max(1, Math.ceil((event.delayMs ?? 0) / 1000));
  const detail = event.errorMessage ? `\n${event.errorMessage}` : '';
  const element = document.createElement('div');
  element.className = 'system-message retry-message';
  element.textContent = `⚠️ Request failed. Retrying in ${delaySeconds}s (attempt ${attempt}/${maxAttempts})…${detail}`;
  messagesContainer.appendChild(element);
  retryStatusElement = element;
  messageRenderer.scrollToBottom();
}

function flushPendingAssistantError() {
  const pending = pendingAssistantError;
  pendingAssistantError = null;
  if (!pending) return;
  // A snapshot might already have rendered this error from session history.
  const lastBlock = messagesContainer.lastElementChild;
  const alreadyShown = lastBlock?.classList.contains('assistant-block') &&
    Array.from(lastBlock.querySelectorAll('.message-error-detail'))
      .some(element => element.textContent === pending.errorMessage);
  if (!alreadyShown) {
    appendLiveActivity(messageRenderer.renderAssistantError(pending.errorMessage), 'error');
    messageRenderer.scrollToBottom();
  }
}

function handleAutoRetryStart(event: AppEvent) {
  // Keep partial steps, but never materialize a provisional provider error
  // (or an empty assistant bubble) while Pi is still retrying.
  pendingAssistantError = null;
  showRetryStatus(event);
}

function handleAutoRetryEnd(event: AppEvent) {
  clearRetryStatus();
  // "Retry cancelled" is the user stopping the retry, not a provider failure.
  const finalError = event.success === false && event.finalError !== 'Retry cancelled'
    ? event.finalError
    : undefined;
  if (finalError && !pendingAssistantError) {
    pendingAssistantError = { errorMessage: finalError };
  }
}

function handleRPCEvent(event: AppEvent, sessionId: string | null = null) {
  if (event.parentToolCallId !== undefined && (
    event.type === 'tool_execution_start' ||
    event.type === 'tool_execution_update' ||
    event.type === 'tool_execution_end'
  )) {
    toolCardRenderer.observeNestedCall(event);
    return;
  }

  switch (event.type) {
    case 'agent_start':
      pendingAssistantError = null;
      clearRetryStatus();
      handleAgentStart();
      break;
    case 'turn_start':
      handleAgentStart();
      break;
    case 'agent_end':
      // Reply rendering can finish before Pi's end hooks release input.
      assistantBlocks.setWorking(false);
      messageRenderer.scrollToBottom();
      break;
    case 'agent_settled':
      handleAgentSettled();
      break;
    case 'message_start':
      handleMessageStart(event.message as AppMessage);
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event.message as AppMessage);
      break;
    case 'auto_retry_start':
      handleAutoRetryStart(event);
      break;
    case 'auto_retry_end':
      handleAutoRetryEnd(event);
      break;
    case 'tool_execution_start':
      handleToolExecutionStart(event);
      break;
    case 'tool_execution_update':
      handleToolExecutionUpdate(event);
      break;
    case 'tool_execution_end':
      handleToolExecutionEnd(event);
      break;
    case 'compaction_start':
      handleCompactionStart();
      break;
    case 'compaction_end':
      handleCompactionEnd(event);
      break;
    case 'extension_ui_request':
      if (sessionId && DIALOG_METHODS.has(String(event.method))) {
        queueExtensionUIRequest(event, sessionId);
        processQueuedExtensionUIRequest(sessionId);
      } else handleExtensionUIRequest(event, sessionId);
      break;
    case 'extension_error':
      messageRenderer.renderError(`Extension error: ${event.error}`);
      break;
    case 'session_name':
      // Auto-title: update sidebar with new session name
      if (event.name) {
        sidebar.setActiveSessionName(event.name);
      }
      break;
  }
}

function handleCompactionStart() {
  assistantBlocks.boundary();
  currentMessageSteps.clear();
  const el = document.createElement('div');
  el.className = 'system-message compaction-message';
  el.id = 'compaction-indicator';
  el.innerHTML = '<span class="compaction-spinner">⟳</span> Compacting context…';
  messagesContainer.appendChild(el);
  scrollToBottom();
  return el;
}

function handleCompactionEnd(event: AppEvent) {
  // A browser attaching during compaction has no start indicator or boundary.
  const indicator = document.getElementById('compaction-indicator') || handleCompactionStart();
  const result = event.result as { summary?: string } | undefined;
  const summary = result?.summary ? ` — ${result.summary}` : '';
  indicator.textContent = result ? `Context compacted${summary}` : event.aborted ? 'Compaction cancelled' : event.error || 'Compaction failed';
  indicator.classList.add('compaction-done');
  indicator.removeAttribute('id');
  // Reset token tracking — the stats refresh below and the next message
  // bring in fresh post-compaction numbers.
  lastInputTokens = 0;
  updateContextPill();
  hideCompactButton();
  void sessionStatsCard.refresh();
}

function handleAgentStart() {
  assistantBlocks.setWorking(true);
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
}

function handleAgentSettled() {
  toolCardRenderer.settleNestedCalls();
  const wasStreaming = state.isStreaming;
  clearRetryStatus();
  flushPendingAssistantError();
  state.setStreaming(false);
  showTypingIndicator(false);
  currentMessageSteps.clear();
  assistantBlocks.setWorking(false);
  messageRenderer.scrollToBottom();
  updateUI();

  // Pi has finished its end hooks, compaction and queued continuations.
  // Neither turn_end nor agent_end establishes idle. Fetch post-operation
  // stats only after agent_settled.
  if (wasStreaming) void sessionStatsCard.refresh();

  // Notify via tab title if unfocused, once per completed operation.
  if (wasStreaming && !hasFocus) {
    unreadCount++;
    document.title = `(${unreadCount}) ● ${originalTitle}`;

  }
}

function rememberToolDefinitions(message: AppMessage) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (block.type === 'toolCall' && block.id) {
      toolCardRenderer.rememberRoot({ toolCallId: block.id, toolName: block.name, args: block.arguments });
    }
  }
}

function handleMessageStart(message: AppMessage) {
  rememberToolDefinitions(message);
  if (message.role === 'assistant') {
    pendingAssistantError = null;
    clearRetryStatus();
    currentMessageSteps.clear();
  } else if (message.role === 'user') {
    assistantBlocks.boundary();
    // The prompt is already drawn locally when sent.
    if (!lastSentMessage || getMessageText(message) !== lastSentMessage) {
      const content = getMessageText(message);
      const images = messageImages(message);
      if (content || images.length) messageRenderer.renderUserMessage({ content, images });
    }
    lastSentMessage = null;
  }
}

function getMessageText(message: AppMessage) {
  if (typeof message.content === 'string') return message.content;
  return (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function nextMessageStep(index: number) {
  let next: HTMLElement | null = null;
  let position = Infinity;
  for (const [candidate, element] of currentMessageSteps) {
    if (candidate > index && candidate < position) {
      next = element;
      position = candidate;
    }
  }
  return next;
}

function updateMessageStep(index: number, step: AssistantStep, streaming: boolean) {
  let element = currentMessageSteps.get(index);
  if (!element) {
    element = messageRenderer.renderAssistantStep(step, streaming);
    // message_end supplies blocks missed when this browser joined mid-message.
    appendLiveActivity(element, step.type, nextMessageStep(index));
    currentMessageSteps.set(index, element);
    if (streaming) messageRenderer.scrollToBottom();
  } else if (streaming) {
    messageRenderer.queueAssistantStep(element, step.text);
  } else {
    messageRenderer.updateAssistantStep(element, step.text);
  }
}

function handleMessageUpdate(event: AppEvent) {
  if (typeof event.message === 'object') rememberToolDefinitions(event.message);
  const update = event.assistantMessageEvent;
  if (!update) return;
  const index = update.contentIndex;
  if (index === undefined) return;
  const type = update.type;
  if (type !== 'thinking_start' && type !== 'thinking_delta' && type !== 'text_start' && type !== 'text_delta') return;
  const kind = type.startsWith('thinking') ? 'thinking' : 'text';
  const block = update.partial?.content?.[index];
  const element = currentMessageSteps.get(index);
  const previous = element ? messageRenderer.assistantStepText(element) : '';
  const text = block && typeof block !== 'string'
    ? (kind === 'thinking' ? block.thinking : block.text) || ''
    : previous + (update.delta || '');
  updateMessageStep(index, { type: kind, text }, true);
}

function appendLiveActivity(element: HTMLElement, label: string, before: HTMLElement | null = null) {
  assistantBlocks.append(element, label, before);
  // Once a history block receives live content its height must not be deferred.
  element.closest('.assistant-block')?.classList.remove('history');
}

function ensureToolCard(toolCallId: string, toolName: string, args: Record<string, unknown> = {}, before: HTMLElement | null = null) {
  let card = toolCardRenderer.toolCards.get(toolCallId);
  if (!card) {
    card = toolCardRenderer.createToolCard({ toolCallId, toolName, args, status: 'pending' }, document.createDocumentFragment());
    appendLiveActivity(card, toolName, before);
  }
  card.classList.remove('history');
  card.closest('.assistant-block')?.classList.remove('history');
  return card;
}

function handleMessageEnd(message: AppMessage) {
  if (message?.role === 'toolResult') {
    if (message.toolCallId) {
      const card = toolCardRenderer.reconcileToolResult(message.toolCallId, {
        content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [],
        nestedCalls: message.nestedCalls,
      }, message.isError ?? false);
      if (card?.parentElement === messagesContainer) {
        appendLiveActivity(card, card.querySelector('.tool-name')?.textContent || 'tool');
      }
    }
    return;
  }
  if (message?.role !== 'assistant') return;
  rememberToolDefinitions(message);
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
  blocks.forEach((block, index) => {
    if (block.type === 'text' || block.type === 'thinking') {
      updateMessageStep(index, {
        type: block.type, text: block.type === 'thinking' ? block.thinking || '' : block.text || '',
      }, false);
    } else if (block.type === 'toolCall') {
      const card = ensureToolCard(block.id || '', block.name || '', block.arguments, nextMessageStep(index));
      currentMessageSteps.set(index, card);
    }
  });
  currentMessageSteps.clear();

  const usage = message.usage;
  if (usage?.cost?.total) sessionTotalCost += usage.cost.total;
  if (usage?.input) {
    lastInputTokens = usage.input + (usage.cacheRead || 0);
    lastUsage = usage;
  }
  updateContextPill();
  showNewMessageBadge();
  // Keep failures provisional until Pi's authoritative operation settles.
  pendingAssistantError = message.stopReason === 'error'
    ? { errorMessage: message.errorMessage || 'Request failed' } : null;
}

function handleToolExecutionStart(event: AppEvent) {
  const { toolCallId, toolName, args } = event;
  if (!toolCallId) return;
  ensureToolCard(toolCallId, toolName || '', args);
  toolCardRenderer.updateToolCard({ toolCallId, status: 'pending' });
  messageRenderer.scrollToBottom();
}

function handleToolExecutionUpdate(event: AppEvent) {
  if (!event.toolCallId) return;
  ensureToolCard(event.toolCallId, event.toolName || '', event.args);
  toolCardRenderer.updateToolCard({
    toolCallId: event.toolCallId, status: 'streaming', output: formatToolOutput(event.partialResult),
  });
  messageRenderer.scrollToBottom();
}

function handleToolExecutionEnd(event: AppEvent) {
  if (!event.toolCallId) return;
  ensureToolCard(event.toolCallId, event.toolName || '', event.args);
  toolCardRenderer.finalizeToolCard(event.toolCallId, event.result as ToolResult, event.isError ?? false);
}

function pendingInteractionCount(sessionId: string) {
  const session = liveSessions.find(session => session.id === sessionId);
  return session?.attached ? sharedDialogs.get(sessionId)?.size || 0 : session?.pendingInteractionCount || 0;
}

function reconcileInteractionState(next: InteractionState) {
  const session = liveSessions.find(session => session.id === next.sessionId);
  if (!session || session.attached) return;
  const current = interactionStates.get(next.sessionId);
  // HTTP snapshots and WebSocket updates can cross in flight. In particular,
  // an older snapshot must never recreate a request another client answered.
  if (current && next.interactionRevision <= current.interactionRevision) return;
  interactionStates.set(next.sessionId, next);
  const visible = dialogHandler.currentRequest;
  if (visible?.sessionId === next.sessionId && !next.pendingDialogs.some(request => request.id === visible.id)) {
    // Server resolution is not a user cancellation; never send another reply.
    dialogHandler.clearCurrentDialog();
  }
  processQueuedExtensionUIRequest(next.sessionId);
  renderLiveTabs();
}

function queueExtensionUIRequest(event: AppEvent, sessionId: string) {
  if (liveSessions.find(session => session.id === sessionId)?.attached && DIALOG_METHODS.has(String(event.method))) {
    if (typeof event.id !== 'string') return;
    let dialogs = sharedDialogs.get(sessionId);
    if (!dialogs) sharedDialogs.set(sessionId, dialogs = new Map());
    dialogs.set(event.id, event);
    renderLiveTabs();
    if (viewingActiveSession && activeLiveSessionId === sessionId) updateUI();
    return;
  }
  // Native response-bearing requests arrive only through Tau's full registry.
  // Preserve background-tab transient notifications for both transports.
  if (event.method !== 'notify') return;
  if (!pendingExtensionUIRequests.some(req => req.sessionId === sessionId && req.event.id === event.id)) {
    pendingExtensionUIRequests.push({ sessionId, event });
  }
}

function processQueuedExtensionUIRequest(sessionId = activeLiveSessionId) {
  if (!sessionId || !viewingActiveSession || sessionId !== activeLiveSessionId) return;
  const notifications = pendingExtensionUIRequests.filter(request => request.sessionId === sessionId);
  pendingExtensionUIRequests = pendingExtensionUIRequests.filter(request => request.sessionId !== sessionId);
  for (const { event } of notifications) handleExtensionUIRequest(event, sessionId);
  if (dialogHandler.currentRequest) return;
  const shared = liveSessions.find(session => session.id === sessionId)?.attached;
  const request = shared ? sharedDialogs.get(sessionId)?.values().next().value
    : interactionStates.get(sessionId)?.pendingDialogs.find(request => request.expiresAt === undefined || request.expiresAt > Date.now());
  if (request) handleExtensionUIRequest(request, sessionId);
}

function suspendCurrentDialogForTabSwitch(nextSessionId: string) {
  const current = dialogHandler.currentRequest;
  if (!current?.sessionId || current.sessionId === nextSessionId) return;
  // The request remains in its session's registry, including its deadline.
  dialogHandler.clearCurrentDialog();
}

function handleExtensionUIRequest(event: AppEvent, sessionId: string | null = null) {
  // One dialog shows at a time. Its membership stays with its authoritative
  // registry even while visible, or while the transport accepts an answer.
  const current = dialogHandler.currentRequest;
  if (sessionId && current && DIALOG_METHODS.has(String(event.method))) {
    if (current.sessionId !== sessionId || current.id !== event.id) queueExtensionUIRequest(event, sessionId);
    return;
  }
  const request = (sessionId ? { ...event, sessionId } : event) as DialogRequest;
  // A shared request stays a member until mux closes it or replaces its
  // snapshot. Native requests still use Tau's original absolute expiry.
  if (sessionId && liveSessions.find(session => session.id === sessionId)?.attached) delete request.expiresAt;
  switch (event.method) {
    case 'select':
      dialogHandler.showSelect(request);
      break;
    case 'confirm':
      dialogHandler.showConfirm(request);
      break;
    case 'input':
      dialogHandler.showInput(request);
      break;
    case 'editor':
      dialogHandler.showEditor(request);
      break;
    case 'notify':
      dialogHandler.showNotification(request);
      break;
    default:
      if (!DISPLAY_UI_METHODS.has(String(event.method))) console.warn('[App] Unknown extension UI method:', event.method);
  }
}

function formatToolOutput(result: unknown) {
  if (!result) return '';

  const r = result as { content?: MessageContentBlock[] };
  if (r.content && Array.isArray(r.content)) {
    return r.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener('keydown', (e) => {
  if (isImeComposition(e)) return;
  // Enter sends, Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
});

// ═══════════════════════════════════════
// Attachments (images + file browser paths)
// ═══════════════════════════════════════

const attachBtn = document.getElementById('attach-btn')!;
const imageInput = document.getElementById('image-input')!;
const imagePreviews = document.getElementById('image-previews')!;

let pendingImages: PendingImage[] = [];     // { data: base64, mimeType }
let pendingFilePaths: PendingFilePath[] = [];  // { path, name, ext } — from file browser (populated by callback above)

const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

function getFileChipIcon(name: string) {
  return getFileIcon(name || 'file', false);
}

function processImageFile(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const mimeType = VALID_MIME_TYPES.includes(file.type) ? file.type : 'image/png';

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);

        const outputMime = (mimeType === 'image/jpeg') ? 'image/jpeg' : 'image/png';
        const quality = (outputMime === 'image/jpeg') ? 0.85 : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];
        if (!base64) { reject(new Error('Failed to encode image')); return; }
        resolve({ data: base64, mimeType: outputMime });
      };
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

async function addAttachments(files: FileList | File[]) {
  const list = Array.from(files);            // snapshot before any await
  for (const file of list) {
    if (!file.type.startsWith('image/')) continue;
    try {
      pendingImages.push(await processImageFile(file));
    } catch (e) {
      console.error('[Tau] Image processing failed:', e);
    }
  }
  renderAttachmentPreviews();
}

attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  addAttachments(imageInput.files ?? []);
  imageInput.value = '';
});

// Drag & drop on input
messageInput.addEventListener('dragover', (e) => { e.preventDefault(); });
messageInput.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length > 0) addAttachments(e.dataTransfer.files);
});

// Paste images
messageInput.addEventListener('paste', (e) => {
  if (!e.clipboardData) return;
  const files: File[] = [];
  for (const item of e.clipboardData.items) {
    if (!item.type.startsWith('image/')) continue;
    files.push(item.getAsFile() as File);
  }
  if (files.length) addAttachments(files);
});

function makeRemoveBtn(onClick: () => void) {
  const btn = document.createElement('button');
  btn.className = 'image-preview-remove';
  btn.setAttribute('aria-label', 'Remove');
  btn.textContent = '✕';
  btn.addEventListener('click', onClick);
  return btn;
}

function renderAttachmentPreviews() {
  imagePreviews.innerHTML = '';
  const hasAny = pendingImages.length > 0 || pendingFilePaths.length > 0;
  if (!hasAny) { imagePreviews.classList.add('hidden'); return; }
  imagePreviews.classList.remove('hidden');

  // Binary image chips
  pendingImages.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'image-preview';
    const thumb = document.createElement('img');
    thumb.src = `data:${img.mimeType};base64,${img.data}`;
    el.appendChild(thumb);
    el.appendChild(makeRemoveBtn(() => { pendingImages.splice(i, 1); renderAttachmentPreviews(); }));
    imagePreviews.appendChild(el);
  });

  // File browser path chips
  pendingFilePaths.forEach((fp, i) => {
    const el = document.createElement('div');
    const removeBtn = makeRemoveBtn(() => {
      const withSpace = fp.path + ' ';
      messageInput.value = messageInput.value.includes(withSpace)
        ? messageInput.value.replace(withSpace, '')
        : messageInput.value.replace(fp.path, '');
      messageInput.dispatchEvent(new Event('input'));
      pendingFilePaths.splice(i, 1);
      renderAttachmentPreviews();
    });

    if (IMAGE_EXTS.has(fp.ext)) {
      el.className = 'image-preview';
      el.title = fp.path;
      const thumb = document.createElement('img');
      thumb.style.cssText = 'width:100%;height:100%;object-fit:cover';
      const previewParams = new URLSearchParams({ path: fp.path });
      if (fp.sessionId) previewParams.set('sessionId', fp.sessionId);
      thumb.src = `/api/file/preview?${previewParams.toString()}`;
      thumb.onerror = () => {
        el.classList.add('file-chip');
        thumb.remove();
        const icon = document.createElement('span');
        icon.className = 'file-chip-icon';
        icon.textContent = getFileChipIcon(fp.name);
        const label = document.createElement('span');
        label.className = 'file-chip-name';
        label.textContent = fp.name;
        el.insertBefore(label, removeBtn);
        el.insertBefore(icon, label);
      };
      el.appendChild(thumb);
    } else {
      el.className = 'image-preview file-chip';
      el.title = fp.path;
      const icon = document.createElement('span');
      icon.className = 'file-chip-icon';
      icon.textContent = getFileChipIcon(fp.ext);
      const label = document.createElement('span');
      label.className = 'file-chip-name';
      label.textContent = fp.name;
      el.appendChild(icon);
      el.appendChild(label);
    }

    el.appendChild(removeBtn);
    imagePreviews.appendChild(el);
  });
}

// ═══════════════════════════════════════
// Send message (with images)
// ═══════════════════════════════════════

let messageQueue: QueuedCommand[] = [];
const unsentInput = new UnsentInputStore();

function putInComposer(input: UnsentInput | null) {
  if (!input) return;
  messageInput.value = [input.text, messageInput.value].filter(Boolean).join('\n\n');
  pendingImages.push(...input.images);
  renderAttachmentPreviews();
  setStatusMessage('Your unsent message is back in the input', 4000);
}

/** The active shared tab's agent may have input waiting from a connection that ended. */
function restoreUnsentInput() {
  if (!viewingActiveSession) return;
  const muxId = liveSessions.find(s => s.id === activeLiveSessionId)?.attached?.muxId;
  if (muxId) putInComposer(unsentInput.take(muxId));
}

/** A shared tab ended while its agent may run on: its draft belongs to that agent, not to the next tab shown. */
function keepUnsentInput(session: LiveSession) {
  const muxId = session.attached?.muxId;
  if (!muxId) return;
  unsentInput.keepInFlight(muxId);
  // Instructions still held locally were never handed to Pi. Keep those too,
  // under this agent rather than the next tab selected after disconnect.
  for (const command of messageQueue.filter(command => command.sessionId === session.id)) {
    unsentInput.keep(muxId, { text: command.message || '', images: command.images || [] });
  }
  messageQueue = messageQueue.filter(command => command.sessionId !== session.id);
  const dispatch = queuedPrompts.get(session.id);
  if (dispatch && !dispatch.accepted && !dispatch.started) {
    // The HTTP acknowledgement may have been lost: restore for review only,
    // just like socket input whose receipt disappeared. Never replay it.
    unsentInput.keep(muxId, { text: dispatch.command.message || '', images: dispatch.command.images || [] });
  }
  if (session.id !== activeLiveSessionId) return;
  const text = messageInput.value.trim();
  if (!text && !pendingImages.length) return;
  unsentInput.keep(muxId, { text, images: pendingImages });
  messageInput.value = '';
  pendingImages = [];
  renderAttachmentPreviews();
}

function settlePrompt(id: string, delivered: boolean, error?: unknown) {
  if (!unsentInput.settle(id, delivered)) return;
  flashStatusError(String(error || 'Pi did not get your message.'), 5000);
  restoreUnsentInput();
}

function activeTabIsShared() {
  return !!liveSessions.find(s => s.id === activeLiveSessionId)?.attached;
}

function sendMessage() {
  if (takeRequest?.sessionId === activeLiveSessionId) {
    flashStatusError('Finish taking the session before sending a message.');
    return;
  }
  const message = messageInput.value.trim();
  if (!message && pendingImages.length === 0) return;
  if (wsClient.ws?.readyState !== WebSocket.OPEN) {
    // Keep the draft: a send now would be dropped, for instance while a phone
    // reconnects after the server restarted.
    flashStatusError('Reconnecting; your message is still here, send it again in a moment.');
    if (wsClient.ws?.readyState !== WebSocket.CONNECTING) wsClient.forceReconnect();
    return;
  }

  messageInput.value = '';
  messageInput.style.height = 'auto';

  // Another frontend sharing this Pi can start a run at any moment; Pi then
  // needs to know how to queue the prompt. It ignores this when idle.
  const cmd: QueuedCommand = { type: 'prompt', message: message || '(see attached image)', streamingBehavior: 'followUp' };
  const images = pendingImages;

  if (pendingImages.length > 0) {
    cmd.images = pendingImages.map(img => {
      console.log(`[Tau] Sending image: mimeType=${img.mimeType}, dataLen=${img.data?.length}`);
      return { type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' };
    });
    pendingImages = [];
  }

  pendingFilePaths = [];
  renderAttachmentPreviews();

  if (!activeLiveSessionId) {
    messageRenderer.renderError('Create or select a Tau tab first.');
    updateLiveSessionInputState();
    return;
  }

  cmd.sessionId = activeLiveSessionId;
  resumeQueuedInput = true;

  if (state.isStreaming && activeTabIsShared() && !sessionHasPendingWork(activeLiveSessionId)) {
    // The run may belong to another frontend: Pi takes this now and every
    // frontend, this one included, draws it when Pi delivers it.
    cmd.streamingBehavior = 'steer';
    setStatusMessage('Sent; Pi reads it at its next step', 3000);
    sendPrompt(cmd, { text: message, images });
    return;
  }

  if (state.isStreaming || sessionHasPendingWork(activeLiveSessionId)) {
    // Queue it for the current Tau tab only; do not let tab switches retarget it.
    messageQueue.push(cmd);
    lastSentMessage = message;
    renderQueuedMessages();
    return;
  }

  lastSentMessage = message;
  assistantBlocks.boundary();
  messageRenderer.renderUserMessage({ content: message, images: cmd.images });
  sendPrompt(cmd, { text: message, images });
}

/** Track only input actually handed to Tau, not a still-local queued draft. */
function sendPrompt(command: QueuedCommand, input: UnsentInput) {
  const muxId = liveSessions.find(session => session.id === command.sessionId)?.attached?.muxId;
  if (muxId) {
    command.id = `tau_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    unsentInput.track(command.id, muxId, input);
  }
  wsClient.send(command);
}

const queuedMessagesEl = document.getElementById('queued-messages')!;

function renderQueuedMessages() {
  queuedMessagesEl.innerHTML = '';
  const uncertain = activeLiveSessionId ? queuedPrompts.get(activeLiveSessionId) : undefined;
  if (uncertain?.uncertain) {
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `<span class="queued-msg-label">Delivery uncertain</span><span class="queued-msg-text">${escapeHtml(uncertain.command.message || '')}</span>`;
    el.title = 'The acknowledgement was lost. This instruction may have run. Waiting for confirmed execution or completion before sending more.';
    queuedMessagesEl.appendChild(el);
  }
  // What Pi itself is holding, from whichever frontend it came.
  const piQueue = (activeLiveSessionId && piQueues.get(activeLiveSessionId)) || { steering: [], followUp: [] };
  for (const [label, messages] of [['Steering', piQueue.steering], ['Follow-up', piQueue.followUp]] as const) {
    for (const message of messages) {
      const el = document.createElement('div');
      el.className = 'queued-msg';
      el.innerHTML = `
      <span class="queued-msg-label">${label}</span>
      <span class="queued-msg-text">${escapeHtml(message)}</span>
    `;
      queuedMessagesEl.appendChild(el);
    }
  }
  messageQueue.forEach((cmd, i) => {
    if (cmd.sessionId !== activeLiveSessionId) return;
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `
      <span class="queued-msg-label">${cmd.error ? 'Not sent' : 'Queued'}</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message || '')}</span>
      ${cmd.error ? '<button class="queued-msg-retry" type="button">Retry</button>' : ''}
      <button class="queued-msg-cancel" title="Cancel">×</button>
    `;
    el.title = cmd.error || '';
    el.querySelector('.queued-msg-retry')?.addEventListener('click', () => {
      delete cmd.error;
      renderQueuedMessages();
      flushQueue();
    });
    el.querySelector('.queued-msg-cancel')?.addEventListener('click', () => {
      messageQueue.splice(i, 1);
      renderQueuedMessages();
    });
    queuedMessagesEl.appendChild(el);
  });
  queuedMessagesEl.classList.toggle('hidden', queuedMessagesEl.children.length === 0);
  // The panel takes room from the conversation: its latest line stays in view.
  if (!isScrolledUp) messageRenderer.scrollToBottom();
}

function escapeHtml(text: string) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function flushQueue() {
  if (!activeLiveSessionId || state.isStreaming || !resumeQueuedInput || sessionHasPendingWork(activeLiveSessionId) || takeRequest?.sessionId === activeLiveSessionId) return;
  const idx = messageQueue.findIndex(cmd => cmd.sessionId === activeLiveSessionId);
  if (idx >= 0) {
    if (messageQueue[idx].error) return; // A failed instruction needs an explicit retry or cancellation.
    const [cmd] = messageQueue.splice(idx, 1);
    lastSentMessage = cmd.message ?? null;
    assistantBlocks.boundary();
    messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
    renderQueuedMessages();
    // Paired settled/metadata updates may arrive before Pi starts this
    // prompt. Keep only one queued dispatch in flight for each session.
    const id = `queued_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const queued: QueuedDispatch = { id, command: cmd, started: false, accepted: false };
    queuedPrompts.set(activeLiveSessionId, queued);
    void dispatchQueuedPrompt(activeLiveSessionId, queued);
  }
}

// Dispatch over HTTP rather than the WebSocket: a closed socket drops a send
// silently, which would leave this session's queue locked with no error and
// no Retry. Only explicit rejection permits replay; a lost HTTP response can
// hide successful delivery and must preserve the dispatch lock.
async function dispatchQueuedPrompt(sessionId: string, queued: QueuedDispatch) {
  let rejected = false;
  try {
    const response = await fetch('/api/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...queued.command, id: queued.id }),
    });
    const data = await response.json();
    rejected = response.ok && data.success === false && data.delivery === 'rejected';
    if (!response.ok || !data.success) throw new Error(data.error || 'Queued instruction failed');
    if (queuedPrompts.get(sessionId) !== queued) return; // Already settled or the tab closed.
    queued.accepted = true;
    // Pi acknowledges prompt acceptance before agent_start, not completion.
    // Keep the dispatch locked until settled. Slash commands may never start
    // an agent operation, so ask Pi for fresh state after acceptance instead.
    void reconcileAcceptedPrompt(sessionId, queued);
  } catch (error) {
    if (queuedPrompts.get(sessionId) !== queued) return;
    if (!rejected || queued.started) {
      queued.uncertain = true;
      renderQueuedMessages();
      // Observed execution is enough to reconcile, even without the HTTP ack.
      // Without it, idle alone cannot prove that a delayed POST will not run.
      if (queued.started) void reconcileAcceptedPrompt(sessionId, queued);
      return;
    }
    queuedPrompts.delete(sessionId);
    queued.command.error = error instanceof Error && error.message ? error.message : 'Queued instruction failed';
    messageQueue.unshift(queued.command);
    renderQueuedMessages();
    if (viewingActiveSession && activeLiveSessionId === sessionId) {
      messageRenderer.renderError(queued.command.error);
      updateUI();
    }
  }
}

// `afterReconnect` releases the lock even when agent_start was observed: the
// matching agent_settled may have been lost with the socket, and Pi's fresh
// idle answer is then the only completion signal this browser will get.
async function reconcileAcceptedPrompt(sessionId: string, queued: QueuedDispatch, afterReconnect = false) {
  if (queuedPrompts.get(sessionId) !== queued) return;
  // Remember reconnects during delivery, but never treat idle as completion
  // until Pi has acknowledged the prompt or execution has been observed.
  if (afterReconnect) queued.reconcileAfterReconnect = true;
  if ((!queued.accepted && !queued.started) || queued.reconciling) return;
  clearTimeout(queued.retryTimer);
  queued.retryTimer = undefined;
  queued.reconciling = true;
  try {
    const response = await fetch('/api/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state', sessionId, refresh: true }),
    });
    const data = await response.json();
    const idle = response.ok && data.success && data.data?.isStreaming === false && data.data?.isCompacting === false;
    if (idle && (queued.reconcileAfterReconnect || queued.uncertain || !queued.started) && queuedPrompts.get(sessionId) === queued) {
      queuedPrompts.delete(sessionId);
      renderQueuedMessages();
      if (viewingActiveSession && activeLiveSessionId === sessionId) {
        toolCardRenderer.settleNestedCalls();
        updateUI();
      }
    }
  } catch {
    // Without an idle acknowledgement, leave the next instruction queued.
  } finally {
    queued.reconciling = false;
    // Slash commands need not emit agent_settled, and interrupted delivery or
    // reconnects may have missed it. Retry only the read, never the prompt. The identity
    // check also makes a pending retry harmless after settlement or tab close.
    if (queuedPrompts.get(sessionId) === queued && (queued.reconcileAfterReconnect || queued.uncertain || !queued.started)) {
      queued.retryTimer = setTimeout(() => void reconcileAcceptedPrompt(sessionId, queued), 1000);
    }
  }
}

function abortState(sessionId: string) {
  return localAbortStates.get(sessionId) || liveSessions.find(session => session.id === sessionId)?.abortState || 'idle';
}

function sessionHasPendingWork(sessionId: string) {
  return queuedPrompts.has(sessionId) || pendingInteractionCount(sessionId) > 0 || (abortState(sessionId) === 'stopping' && !settledWhileStopping.has(sessionId));
}

function abortActiveSession() {
  if (!viewingActiveSession || !activeLiveSessionId) return;
  const sessionId = activeLiveSessionId;
  if (abortRequests.has(sessionId)) return;
  const revision = operationRevisions.get(sessionId) || 0;
  localAbortStates.set(sessionId, 'stopping');
  settledWhileStopping.delete(sessionId);
  updateUI();
  const request = (async () => {
    try {
      const response = await fetch('/api/rpc', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'abort', sessionId }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Pi did not acknowledge the stop');
      const session = liveSessions.find(session => session.id === sessionId);
      // An attached Pi acknowledges the command through mux, not through the
      // native stop-state registry. Acceptance cannot establish operation idle
      // or discard its dialogs; wait for settled/authoritative idle metadata.
      if (session?.attached) {
        if ((operationRevisions.get(sessionId) || 0) !== revision || session.isStreaming === false) {
          localAbortStates.delete(sessionId);
        }
        return;
      }
      localAbortStates.delete(sessionId);
      // A queued instruction may already have started after agent_settled.
      // This HTTP response belongs to the operation we originally stopped.
      if (session && (operationRevisions.get(sessionId) || 0) === revision) {
        session.abortState = 'idle';
        session.isStreaming = false;
        if (viewingActiveSession && activeLiveSessionId === sessionId) {
          state.setStreaming(false);
          assistantBlocks.setWorking(false);
          toolCardRenderer.settleNestedCalls();
          showTypingIndicator(false);
        }
      }
    } catch (error) {
      if (liveSessions.some(session => session.id === sessionId) && (operationRevisions.get(sessionId) || 0) === revision) {
        const message = error instanceof Error ? error.message : 'Could not request a stop';
        localAbortStates.set(sessionId, /timed?\s*out|timeout/i.test(message) ? 'timed_out' : 'failed');
        if (viewingActiveSession && activeLiveSessionId === sessionId) messageRenderer.renderError(`Stop was not confirmed: ${message}`);
      }
    } finally {
      abortRequests.delete(sessionId);
      if (viewingActiveSession && activeLiveSessionId === sessionId) updateUI();
    }
  })();
  abortRequests.set(sessionId, request);
}

abortBtn.addEventListener('click', abortActiveSession);

async function takeFromHerdr() {
  const session = liveSessions.find(item => item.id === activeLiveSessionId);
  if (!viewingActiveSession || !session) {
    flashStatusError('Select a live Tau tab first. The Herdr conversation will replace it here.');
    return;
  }
  if (session.attached) {
    flashStatusError('This tab is shared with the frontend that started it; take the Herdr conversation into a Tau tab of its own.', 8000);
    return;
  }
  if (takeRequest || state.isStreaming || session.isStreaming || messageQueue.some(cmd => cmd.sessionId === session.id)
    || sessionHasPendingWork(session.id) || dialogHandler.currentRequest?.sessionId === session.id) {
    flashStatusError('Finish the current work, queued messages and dialogs before taking a session.');
    return;
  }
  if (wsClient.ws?.readyState !== WebSocket.OPEN) {
    flashStatusError('Reconnect to Tau before taking a session.');
    return;
  }
  const request = { id: crypto.randomUUID(), sessionId: session.id };
  takeRequest = request;
  updateLiveSessionInputState();
  try {
    const response = await fetch('/api/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: request.id, sessionId: request.sessionId, type: 'prompt', message: '/take herdr' }),
    });
    const result = await response.json();
    if (!response.ok || result.success !== true) throw new Error(result.error || 'Session takeover failed.');
    // Pi's RPC select dialog supplies the picker. Its real prompt response is
    // forwarded over the socket even if Tau stopped waiting after ten seconds.
  } catch (error) {
    if (takeRequest === request) {
      takeRequest = null;
      updateLiveSessionInputState();
      flashStatusError(error instanceof Error ? error.message : 'Session takeover failed.');
    }
  }
}

// Command Palette
const commandPaletteController = setupCommandPalette([
  { icon: '↙', label: 'Take from Herdr…', desc: 'Take an idle Herdr conversation into this Tau tab', available: () => !activeTabIsShared(), action: () => { void takeFromHerdr(); } },
  { icon: '✨', label: 'New session', desc: 'Start over in this shared agent; every frontend moves with it', available: activeTabCanStartOver, action: () => { void newSharedSession(); } },
  { icon: '🌳', label: 'Session tree', desc: 'Jump to any earlier point in the session tree', available: () => !activeTabIsShared(), action: () => { void treeViewController.open(); } },
  { icon: '🗜️', label: 'Compact', desc: 'Compact context to save tokens', action: () => rpcCommand({ type: 'compact' }, 'Compacting...') },
  { icon: '📋', label: 'Export HTML', desc: 'Export session as HTML file', action: () => rpcExportHtml() },
  { icon: '📊', label: 'Session Stats', desc: 'Show session statistics', action: () => showSessionStats() },
  { icon: '⬇️', label: 'Expand All Steps', desc: 'Show all assistant activity', action: () => setAssistantBlocksExpanded(true) },
  { icon: '⬆️', label: 'Collapse All Steps', desc: 'Show only results', action: () => setAssistantBlocksExpanded(false) },
  { icon: '⬇️', label: 'Expand All Tools', desc: 'Show tool details and calls', action: () => toolCardRenderer.expandAll() },
  { icon: '⬆️', label: 'Collapse All Tools', desc: 'Hide tool details and calls', action: () => toolCardRenderer.collapseAll() },
]);

async function rpcCommand(cmd: RpcCommand, statusMsg = '') {
  try {
    const backendLocalCommands = new Set(['get_auth', 'set_auth', 'get_available_models']);
    const needsLiveSession = !cmd.sessionId && !cmd.filePath && !backendLocalCommands.has(cmd.type);
    if (needsLiveSession && (!viewingActiveSession || !activeLiveSessionId)) {
      const error = 'Select a live Tau tab first.';
      setStatusMessage(error, 3000);
      return { type: 'response', command: cmd.type, success: false, error };
    }
    if (!cmd.sessionId && viewingActiveSession && activeLiveSessionId) cmd = { ...cmd, sessionId: activeLiveSessionId };
    if (statusMsg) setStatusMessage(statusMsg);
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const data = await resp.json();
    if (data.success) {
      setStatusMessage('Done', 2000);
    } else {
      setStatusMessage(data.error || 'Failed', 3000);
    }
    return data;
  } catch (e) {
    setStatusMessage('Error', 3000);
  }
}

/** Only a shared root agent starts over in place: a Tau tab opens new sessions as new tabs, and workers stay on their file. */
function activeTabCanStartOver() {
  const session = liveSessions.find(s => s.id === activeLiveSessionId);
  return !!session?.attached && session.attached.placement !== 'worker';
}

async function newSharedSession() {
  const session = liveSessions.find(s => s.id === activeLiveSessionId);
  if (session?.isStreaming && !confirm('This agent is working. A new session stops that work, in every frontend. Start over?')) return;
  const data = await rpcCommand({ type: 'new_session' }, 'Starting a new session...');
  if (data?.success && data.data?.cancelled) flashStatusError('This agent refused a new session; workers stay on their session file.', 8000);
}

async function rpcExportHtml() {
  const data = await rpcCommand({ type: 'export_html' }, 'Exporting...');
  if (data?.success && data.data?.path) {
    setStatusMessage(`Exported: ${data.data.path}`, 4000);
  }
}

async function showSessionStats() {
  const data = await rpcCommand({ type: 'get_session_stats' }, 'Loading stats...');
  if (data?.success && data.data) {
    const s = data.data;
    const lines = [
      `📊 Session Stats`,
      `Messages: ${s.totalMessages} (${s.userMessages} user, ${s.assistantMessages} assistant)`,
      `Tool calls: ${s.toolCalls}`,
    ];
    if (s.tokens) {
      lines.push(`Context: ~${(s.tokens.input / 1000).toFixed(1)}k tokens`);
    }
    messageRenderer.renderSystemMessage(lines.join('\n'));
  }
}

/** After opening something on purpose. A phone keeps its keyboard down, and an open dialog keeps the focus. */
function focusComposer() {
  if (!isMobile() && !dialogHandler.currentRequest) messageInput.focus();
}

/** What the conversation area shows now, to notice that the user moved on. */
function currentView() {
  return JSON.stringify([activeLiveSessionId, viewingActiveSession, sidebar.activeSessionFile, launcherPanel.isVisible()]);
}

// Agent overview: tapping a shared agent attaches a Tau tab to it, or selects
// the tab already attached.
const agentsPanel = setupAgentsPanel({
  button: document.getElementById('agents-btn')!,
  focusComposer,
  async open(agent) {
    if (agent.tabId && liveSessions.some(s => s.id === agent.tabId)) {
      await selectLiveSession(agent.tabId);
      return true;
    }
    const view = currentView();
    try {
      const res = await fetch('/api/live-sessions/attach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ muxId: agent.muxId }),
      });
      const data = await res.json();
      if (!res.ok || data.error || !data.session) throw new Error(data.error || 'Could not open the agent');
      upsertLiveSession(data.session);
      // Attaching can take seconds; whatever the user opened meanwhile stays.
      if (currentView() !== view) return false;
      await selectLiveSession(data.session.id);
      return true;
    } catch (error) {
      flashStatusError(error instanceof Error ? error.message : 'Could not open the agent', 8000);
      return false;
    }
  },
});

// Model Picker
const modelPickerController = setupModelPicker({
  getActiveLiveSessionId: () => activeLiveSessionId,
  isViewingActiveSession: () => viewingActiveSession,
  rpcCommand,
  flashStatusError,
  escapeHtml,
  setContextWindowSize(value) { contextWindowSize = value; },
  updateContextPill,
  focusComposer,
});

// Session tree view (modal opened from the header git-branch button, or the
// command palette). Selecting an entry moves the session leaf server-side;
// the conversation re-renders when the server broadcasts a fresh snapshot.
const treeViewController = setupTreeView({
  getActiveLiveSessionId: () => (viewingActiveSession && activeLiveSessionId ? activeLiveSessionId : null),
  isStreaming: () => state.isStreaming,
  setComposerText(text) {
    messageInput.value = text;
    // Trigger the textarea auto-resize handler.
    messageInput.dispatchEvent(new Event('input'));
    if (!isMobile()) messageInput.focus();
  },
  flashStatusError,
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  if (isImeComposition(e)) return;
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === 'Escape') {
    // Close palettes/panels first
    let closed = modelPickerController.closeIfOpen() || treeViewController.closeIfOpen() || commandPaletteController.closeIfOpen();
    if (agentsPanel.isVisible()) {
      agentsPanel.hide();
      closed = true;
    }
    if (!newLiveSessionModal?.classList.contains('hidden')) {
      closeNewLiveSessionModal();
      closed = true;
    }
    if (!settingsPanel.classList.contains('hidden')) {
      closeSettings();
      closed = true;
    }
    if (closed) {
      focusComposer();
      return;
    }

    if (viewingActiveSession && activeLiveSessionId && (state.isStreaming || sessionHasPendingWork(activeLiveSessionId))) {
      abortActiveSession();
    } else if (!sidebarEl.classList.contains('collapsed') && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Focus message input (when not already in an input)
  if (e.key === '/' && !isInInput()) {
    e.preventDefault();
    messageInput.focus();
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 768;
}

function updateSidebarToggleIcon() {
  sidebarToggle.textContent = '☰';
}

function toggleSidebar() {
  sidebarEl.classList.toggle('collapsed');
  sidebarOverlay.classList.toggle('visible', !sidebarEl.classList.contains('collapsed') && isMobile());
  updateSidebarToggleIcon();
}

sidebarToggle.addEventListener('click', toggleSidebar);

sidebarOverlay.addEventListener('click', () => {
  sidebarEl.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
  updateSidebarToggleIcon();
});



const newSessionBtn = document.getElementById('new-session-btn')!;
newSessionBtn.addEventListener('click', () => openNewLiveSessionModal());

refreshSessionsBtn.addEventListener('click', () => {
  if (isMobile()) {
    location.reload();
    return;
  }
  refreshSessionsBtn.classList.add('spinning');
  sidebar.loadProjects().then(() => {
    setTimeout(() => refreshSessionsBtn.classList.remove('spinning'), 600);
    updateLiveSessionIndicators();
  });
});

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    // Only track swipes starting within 20px of left edge
    if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains('collapsed')) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      tracking = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    // If vertical movement dominates, cancel
    if (dy > dx) {
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    if (dx > 60) {
      sidebarEl.classList.remove('collapsed');
      sidebarOverlay.classList.add('visible');
    }
  }, { passive: true });
})();

async function newSession() {
  sessionTotalCost = 0;
  lastInputTokens = 0;
  lastUsage = null;
  updateContextPill();
  await switchSession(null);
  sidebar.clearActive();
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
  if (!isMobile()) messageInput.focus();
}

async function handleSessionSelect(session: SidebarSession | null) {
  sessionLink.cancel();
  if (session) sidebar.setActive(session.filePath);
  sessionTotalCost = 0;
  lastInputTokens = 0;
  lastUsage = null;
  updateContextPill();
  if (session) await switchSession(session.filePath, session);

  // Close sidebar on mobile after selecting
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
}

// ═══════════════════════════════════════
// Read-only follow of a session another Pi process owns
// ═══════════════════════════════════════

/*
 * A session file that an orchestration worker (tmux, Herdr, Emacs) is
 * appending to must not be resumed here: two `pi` processes writing one JSONL
 * file interleave entries and fork the conversation tree. Such a session is
 * shown read-only instead, re-read from disk while it grows.
 */

const FOLLOW_POLL_MS = 3000;

type SessionOwner = { name: string; host: string };
type FollowedSession = {
  dirName: string;
  file: string;
  offset: number;
  entries: SessionHistoryEntry[];
  owner: SessionOwner;
  timer: ReturnType<typeof setInterval>;
};

let followed: FollowedSession | null = null;

function sessionOwnerOf(value: unknown): SessionOwner | null {
  if (typeof value !== 'object' || value === null) return null;
  const { name, host } = value as { name?: unknown; host?: unknown };
  return typeof name === 'string' && typeof host === 'string' ? { name, host } : null;
}

function stopFollowing() {
  if (!followed) return;
  clearInterval(followed.timer);
  followed = null;
}

async function readFollowedSession(dirName: string, file: string, since: number) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(file)}?since=${since}`);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Failed to read session file');
  return data as { entries: SessionHistoryEntry[]; offset: number; reset: boolean };
}

function renderFollowedSession(current: FollowedSession) {
  clearConversation();
  messageRenderer.renderSystemMessage(
    `Read-only: ${current.owner.name} is running this session on ${current.owner.host}. Open it again once that worker finishes to continue it here.`
  );
  renderSessionHistory(current.entries);
  updateLiveSessionInputState();
  updateUI();
}

async function pollFollowedSession() {
  const current = followed;
  if (!current) return;
  try {
    const chunk = await readFollowedSession(current.dirName, current.file, current.offset);
    if (followed !== current) return;
    current.offset = chunk.offset;
    if (chunk.reset) current.entries = chunk.entries;
    else if (chunk.entries.length) current.entries = current.entries.concat(chunk.entries);
    else return;
    renderFollowedSession(current);
  } catch (e) {
    stopFollowing();
    messageRenderer.renderError(e instanceof Error ? e.message : 'Stopped following this session');
  }
}

async function followSession(session: SidebarSession, owner: SessionOwner) {
  stopFollowing();
  const { dir: dirName, file } = session;
  try {
    const chunk = await readFollowedSession(dirName, file, 0);
    followed = { dirName, file, offset: chunk.offset, entries: chunk.entries, owner, timer: setInterval(pollFollowedSession, FOLLOW_POLL_MS) };
    renderFollowedSession(followed);
  } catch (e) {
    messageRenderer.renderError(e instanceof Error ? e.message : 'Failed to read session file');
  }
}

async function switchSession(sessionFile: string | null | undefined, session: SidebarSession | null = null) {
  try {
    // Clear any streaming state from previous session to prevent bleed
    currentMessageSteps.clear();
    pendingAssistantError = null;
    retryStatusElement = null;
    dialogHandler.clearCurrentDialog();
    viewingActiveSession = false;
    stopFollowing();

    state.reset();
    showTypingIndicator(false);
    updateUI();
    clearConversation();

    // Clicking a historical session resumes it as a live backend Tau tab.
    // selectLiveSession() will load the resumed tab snapshot with the same
    // historical entries after the backend has attached to the session file.
    if (sessionFile) {
      const live = liveSessions.find(s => s.sessionFile === sessionFile);
      if (live) {
        await selectLiveSession(live.id);
        return;
      }
      const owner = session ? sessionOwnerOf(session.owner) : null;
      if (owner) {
        updateLiveSessionInputState();
        await followSession(session!, owner);
        return;
      }
      // No live tab yet — ask the server to resume this session.
      messageRenderer.renderSystemMessage('Resuming session…');
      try {
        // The server reads the project directory from the session's own
        // header, so the resume request only has to name the file.
        const res = await fetch('/api/live-sessions/resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: sessionFile }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          clearConversation();
          viewingActiveSession = false;
          updateLiveSessionInputState();
          updateUI();
          // The listing was stale: another process took the session over
          // between the click and the request.
          const refused = sessionOwnerOf(data.owner);
          if (refused && session) {
            await followSession(session, refused);
            return;
          }
          messageRenderer.renderError(data.error || 'Failed to resume session');
          return;
        }
        // If the server found an existing live tab (reused), just focus it.
        if (data.reused && data.session) {
          upsertLiveSession(data.session);
          await selectLiveSession(data.session.id);
          return;
        }
        upsertLiveSession(data.session);
        await selectLiveSession(data.session.id);
      } catch (e) {
        clearConversation();
        messageRenderer.renderError('Failed to resume session');
        viewingActiveSession = false;
        updateLiveSessionInputState();
        updateUI();
      }
      return;
    }

    messageRenderer.renderWelcome();
  } catch (error) {
    console.error('[App] Failed to switch session:', error);
    messageRenderer.renderError('Failed to switch session');
  }
}

// ═══════════════════════════════════════
// Live-session snapshot sync
// ═══════════════════════════════════════

function applyLiveSessionSnapshot(data: LiveSessionSnapshotData, requestedAtRevision?: number) {
  console.log('[LiveSession] Received state snapshot:', data.entries?.length, 'entries');
  const sessionId = data.sessionId || activeLiveSessionId;
  if (!sessionId || !liveSessions.some(session => session.id === sessionId)) return;
  if (Array.isArray(data.dialogs)) reconcileSharedDialogs(sessionId, data.dialogs, data.generation);
  const interactionRevision = interactionStates.get(sessionId)?.interactionRevision;
  const staleInteractions = interactionRevision !== undefined && data.interactionRevision !== undefined && data.interactionRevision < interactionRevision;
  const staleMetadata = staleInteractions || (requestedAtRevision !== undefined && requestedAtRevision !== (sessionStateRevisions.get(sessionId) || 0));
  if (data.pendingDialogs && typeof data.interactionRevision === 'number') {
    reconcileInteractionState({ sessionId, pendingDialogs: data.pendingDialogs, interactionRevision: data.interactionRevision });
  }
  if (sessionId !== activeLiveSessionId) return;
  hasReceivedInitialServerState = true;

  // A snapshot's count, stop status and streaming flag are a single view of
  // the past. Do not let an HTTP response overwrite newer WebSocket state.
  viewingActiveSession = true;
  if (!staleMetadata) {
    const previousCwd = liveSessions.find(session => session.id === activeLiveSessionId)?.cwd;
    if (data.session) {
      upsertLiveSession(data.session);
      if (data.session.cwd !== previousCwd && !fileSidebar.classList.contains('collapsed')) void fileBrowser.load();
    }
    activeLiveSessionFile = data.sessionFile || data.session?.sessionFile || null;
    sidebar.setActive(activeLiveSessionFile);
    if (liveSessions.find(session => session.id === sessionId)?.attached && data.isStreaming === false) {
      localAbortStates.delete(sessionId);
    }
    state.setStreaming(!!data.isStreaming);
    showTypingIndicator(!!data.isStreaming);
  }
  updateLiveSessionInputState();
  updateUI();
  updateLiveSessionIndicators();

  // Update model display — server is canonical, assign directly.
  if (!staleMetadata && data.model !== undefined) {
    if (data.model?.contextWindow) {
      contextWindowSize = Number(data.model.contextWindow) || 0;
    }
    modelPickerController.setModelState(data.model || '', data.thinkingLevel || 'off');
  } else if (!staleMetadata && data.thinkingLevel) {
    modelPickerController.setThinkingLevel(data.thinkingLevel || 'off');
  }

  // A snapshot replaces live DOM, including any deltas received in flight.
  clearConversation();
  retryStatusElement = null;
  sessionTotalCost = 0;
  lastInputTokens = 0;
  lastUsage = null;

  if (data.entries && data.entries.length > 0) {
    renderSessionHistory(data.entries);
  } else {
    messageRenderer.renderWelcome();
  }
  assistantBlocks.setWorking(state.isStreaming);
  if (state.isStreaming) messagesContainer.lastElementChild?.classList.remove('history');

  updateContextPill();
  // A snapshot means the session's entries/leaf may have moved (e.g. another
  // client ran navigate_tree) — refresh an open tree modal so it is not stale.
  treeViewController.notifyTreeChanged(data.sessionId || activeLiveSessionId);
  // A live session just loaded — fetch its authoritative stats from pi.
  void sessionStatsCard.refresh();
  processQueuedExtensionUIRequest();
}

// Mark all live sessions in the sidebar with a green dot
function updateLiveSessionIndicators() {
  const liveFiles = new Set(liveInstances.map(i => i.sessionFile));
  // Also include the current active live session
  if (activeLiveSessionFile) liveFiles.add(activeLiveSessionFile);

  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('has-live-session', liveFiles.has(el.dataset.filePath));
  });
}

// Refresh live-session list for sidebar indicators if WS missed an update
async function pollInstances() {
  const requestedAtRevisions = new Map(sessionStateRevisions);
  try {
    const res = await fetch('/api/live-sessions');
    if (res.ok) {
      const data = await res.json();
      const wasActive = activeLiveSessionId;
      const sessions = (data.sessions || []).map((session: LiveSession) =>
        requestedAtRevisions.get(session.id) !== sessionStateRevisions.get(session.id)
          ? liveSessions.find(current => current.id === session.id) || session
          : session);
      setLiveSessions(sessions);
      const activeSession = wasActive ? liveSessions.find(s => s.id === wasActive) : null;
      if (wasActive && !activeSession) {
        handleLiveSessionClosed(wasActive);
      } else if (activeSession && viewingActiveSession) {
        state.setStreaming(!!activeSession.isStreaming);
        showTypingIndicator(!!activeSession.isStreaming);
        applyActiveSessionMetadata(activeSession);
        updateLiveSessionInputState();
        updateUI();
      }
    }
  } catch {}
}

// Poll every 10 seconds
setInterval(pollInstances, 10000);

// Enable/disable input based on whether we're viewing a live backend Tau tab
function updateLiveSessionInputState() {
  const inputArea = document.querySelector('.input-area');
  const hasLiveSession = viewingActiveSession && !!activeLiveSessionId;
  if (hasLiveSession) {
    messageInput.disabled = false;
    sendBtn.disabled = takeRequest?.sessionId === activeLiveSessionId;
    messageInput.placeholder = 'Message...';
    inputArea?.classList.remove('no-active-live-session');
  } else {
    messageInput.disabled = true;
    sendBtn.disabled = true;
    messageInput.placeholder = hasReceivedInitialServerState ? 'Create or select a Tau tab to chat' : 'Connecting...';
    inputArea?.classList.add('no-active-live-session');
  }
  takeHerdrBtn.setAttribute('aria-busy', String(takeRequest !== null));
  // Taking replaces a Tau tab's own conversation; a shared tab has none to give up.
  takeHerdrBtn.classList.toggle('hidden', !hasLiveSession || activeTabIsShared());
  document.getElementById('command-btn')!.disabled = !hasLiveSession;
  modelPickerController.setEnabled(hasLiveSession);
  // Tree navigation needs Tau's extension, which a shared Pi does not load.
  treeViewController.setVisible(hasLiveSession && !activeTabIsShared());
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

// Chunk only at user/compaction boundaries: a deferred chunk must never split
// one assistant activity block or steal the current live block's controller.
const INITIAL_SYNC_GROUPS = 30;
const HISTORY_CHUNK_GROUPS = 50;
const supportsScrollAnchoring = typeof CSS !== 'undefined' && !!CSS.supports && CSS.supports('overflow-anchor', 'auto');
messagesContainer.classList.toggle('native-scroll-anchoring', supportsScrollAnchoring);
let historyRenderToken = 0;

function setAssistantBlocksExpanded(expanded: boolean) {
  expandedAssistantBlocks = expanded;
  for (const blocks of assistantBlockControllers) blocks.setExpanded(expanded);
}

function clearConversation() {
  historyRenderToken++;
  messagesContainer.style.scrollBehavior = '';
  currentMessageSteps.clear();
  pendingAssistantError = null;
  clearRetryStatus();
  for (const blocks of assistantBlockControllers) blocks.clear();
  assistantBlockControllers.clear();
  assistantBlockControllers.add(assistantBlocks);
  expandedAssistantBlocks = false;
  messageRenderer.clear();
  toolCardRenderer.clear();
  state.toolExecutions.clear();
}

function renderHistoryItem(item: HistoryItem, blocks: AssistantBlocks, target: HTMLElement) {
  if (item.kind === 'user') {
    blocks.boundary();
    messageRenderer.renderUserMessage({ content: item.content, images: item.images }, true, target);
  } else if (item.kind === 'compaction') {
    blocks.boundary();
    messageRenderer.renderCompaction(item.summary, target);
  } else {
    let element: HTMLElement;
    let label: string;
    if (item.kind === 'assistant') {
      element = messageRenderer.renderAssistantStep(item.step);
      label = item.step.type;
    } else if (item.kind === 'assistantError') {
      element = messageRenderer.renderAssistantError(item.error);
      label = 'error';
    } else {
      element = toolCardRenderer.createHistoryCard({
        toolCallId: item.toolCallId, toolName: item.toolName, args: item.args,
        status: item.result !== undefined ? (item.isError ? 'error' : 'complete') : 'pending',
      }, document.createDocumentFragment());
      if (item.result !== undefined || item.isError) {
        toolCardRenderer.addHistoryResult(item.toolCallId, item.result ?? { content: [] }, !!item.isError);
      }
      label = item.toolName;
    }
    blocks.append(element, label);
    element.closest('.assistant-block')?.classList.add('history');
  }
}

function renderSessionHistory(entries: SessionHistoryEntry[]) {
  const token = ++historyRenderToken;
  const { items, totalCost, lastInputTokens: inputTokens, lastUsage: usage } = buildHistoryItems(entries);
  const groups: HistoryItem[][] = [];
  for (const item of items) {
    if (!groups.length || item.kind === 'user' || item.kind === 'compaction') groups.push([]);
    groups[groups.length - 1].push(item);
    if (item.kind === 'toolCall') {
      toolCardRenderer.rememberRoot({ toolCallId: item.toolCallId, toolName: item.toolName, args: item.args,
        status: item.result !== undefined ? (item.isError ? 'error' : 'complete') : 'pending' });
    }
  }
  // Stats are authoritative immediately, not accumulated by progressive DOM.
  sessionTotalCost = totalCost;
  lastInputTokens = inputTokens;
  lastUsage = usage;
  updateContextPill();
  fetchContextWindow();

  let cursor = Math.max(0, groups.length - INITIAL_SYNC_GROUPS);
  const beforeTail = messagesContainer.lastChild;
  for (const group of groups.slice(cursor)) {
    for (const item of group) renderHistoryItem(item, assistantBlocks, messagesContainer);
  }
  let topAnchor = beforeTail ? beforeTail.nextSibling : messagesContainer.firstChild;
  messagesContainer.style.scrollBehavior = 'auto';
  requestAnimationFrame(() => {
    if (token !== historyRenderToken) return;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    requestAnimationFrame(() => {
      if (token === historyRenderToken) messagesContainer.style.scrollBehavior = '';
    });
  });

  const scheduleChunk = (fn: () => void) => typeof requestIdleCallback === 'function'
    ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 16);
  const renderOlderChunk = () => {
    if (token !== historyRenderToken || !topAnchor?.isConnected) return;
    const start = Math.max(0, cursor - HISTORY_CHUNK_GROUPS);
    const target = document.createElement('div');
    const blocks = new AssistantBlocks(target);
    assistantBlockControllers.add(blocks);
    for (const group of groups.slice(start, cursor)) {
      for (const item of group) renderHistoryItem(item, blocks, target);
    }
    blocks.setExpanded(expandedAssistantBlocks);
    const chunk = document.createDocumentFragment();
    chunk.append(...Array.from(target.childNodes));
    const newTop = chunk.firstChild;
    if (supportsScrollAnchoring) {
      messagesContainer.insertBefore(chunk, topAnchor);
    } else {
      const behavior = messagesContainer.style.scrollBehavior;
      messagesContainer.style.scrollBehavior = 'auto';
      const height = messagesContainer.scrollHeight;
      const top = messagesContainer.scrollTop;
      messagesContainer.insertBefore(chunk, topAnchor);
      messagesContainer.scrollTop = top + messagesContainer.scrollHeight - height;
      messagesContainer.style.scrollBehavior = behavior;
    }
    if (newTop) topAnchor = newTop;
    cursor = start;
    if (cursor > 0) scheduleChunk(renderOlderChunk);
  };
  if (cursor > 0) scheduleChunk(renderOlderChunk);
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

function showTypingIndicator(show: boolean) {
  typingIndicator.classList.toggle('hidden', !show);
}

// The single header pill: shows context usage %, falling back to raw tokens
// (no context window info yet) or session cost (no context data yet).
// Clicking it opens the session stats card.
function updateContextPill() {
  if (lastInputTokens > 0 && contextWindowSize > 0) {
    const pct = Math.round((lastInputTokens / contextWindowSize) * 100);
    contextPillEl.textContent = pct === 0 ? '<1%' : `${pct}%`;
    contextPillEl.classList.add('visible');
    contextPillEl.classList.remove('warning', 'critical');
    if (pct >= 80) {
      contextPillEl.classList.add('critical');
    } else if (pct >= 60) {
      contextPillEl.classList.add('warning');
    }
    contextPillEl.title = `Context: ${(lastInputTokens / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k tokens — click for session stats`;
    if (pct >= 80) {
      showCompactButton();
    } else {
      hideCompactButton();
    }
  } else if (lastInputTokens > 0) {
    // No context window info yet, just show raw tokens
    contextPillEl.textContent = `${(lastInputTokens / 1000).toFixed(1)}k`;
    contextPillEl.classList.add('visible');
    contextPillEl.classList.remove('warning', 'critical');
    contextPillEl.title = 'Context tokens — click for session stats';
  } else if (sessionTotalCost > 0) {
    // No context data yet — show the session cost as a fallback.
    contextPillEl.textContent = `$${sessionTotalCost.toFixed(3)} (sub)`;
    contextPillEl.classList.add('visible');
    contextPillEl.classList.remove('warning', 'critical');
    contextPillEl.title = 'Session cost — click for session stats';
  } else {
    contextPillEl.classList.remove('visible', 'warning', 'critical');
  }
}

function showCompactButton() {
  if (document.getElementById('compact-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'compact-btn';
  btn.className = 'compact-btn';
  btn.textContent = 'Compact';
  btn.title = 'Context is over 80% — compact to save tokens';
  btn.addEventListener('click', () => {
    rpcCommand({ type: 'compact' }, 'Compacting...');
    hideCompactButton();
  });
  // Insert next to the context pill in the header
  const pillParent = contextPillEl.parentElement;
  if (pillParent) pillParent.insertBefore(btn, contextPillEl.nextSibling);
}

function hideCompactButton() {
  const btn = document.getElementById('compact-btn');
  if (btn) btn.remove();
}

async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await modelPickerController.fetchModelInfo();
}

let tailscaleUrl = '';

function updateConnectionStatus(status: string) {
  statusIndicator.className = `status-indicator ${status}`;

  if (status === 'connected') {
    statusText.textContent = currentStatusText();
    statusText.title = tailscaleUrl || '';
    // Fetch tailscale info on first connect
    if (!tailscaleUrl) {
      fetch('/api/health').then(r => r.json()).then(data => {
        if (data.tailscaleUrl) {
          tailscaleUrl = data.tailscaleUrl;
          statusText.textContent = currentStatusText();
          statusText.title = tailscaleUrl;
        }
      }).catch(() => {});
    }
  } else if (status === 'disconnected') {
    statusText.textContent = 'Disconnected';
  }
}

function currentStatusText() {
  if (wsClient.ws?.readyState !== WebSocket.OPEN) return 'Disconnected';
  if (viewingActiveSession && activeLiveSessionId) {
    const stopping = abortState(activeLiveSessionId);
    if (stopping === 'stopping') return 'Stopping…';
    if (stopping === 'timed_out') return 'Stop timed out — completion not confirmed';
    if (stopping === 'failed') return 'Stop failed — completion not confirmed';
    if (pendingInteractionCount(activeLiveSessionId)) return 'Waiting for approval';
    if (state.isStreaming) return 'Working...';
  }
  return tailscaleUrl ? 'Connected • TS' : 'Connected';
}

function updateUI() {
  const hasLiveSession = !!activeLiveSessionId && viewingActiveSession;
  const isStreaming = state.isStreaming && hasLiveSession;
  const hasPendingInteraction = hasLiveSession && pendingInteractionCount(activeLiveSessionId!) > 0;
  const stopping = hasLiveSession && abortState(activeLiveSessionId!) === 'stopping';
  abortBtn.disabled = !!stopping;
  abortBtn.title = stopping ? 'Stopping…' : 'Abort';
  abortBtn.setAttribute('aria-label', stopping ? 'Stopping…' : 'Abort');

  // Don't clobber an active red-dot error flash: it owns both the indicator
  // class and statusText for its full 3 s. The flash's restore callback
  // re-derives the current connection/streaming state, so skipping here is
  // safe. Other UI updates below (input enabling, abort button, etc.) still
  // run normally.
  if (statusFlashTimer === null) {
    restoreStatusIndicator();
    statusText.textContent = currentStatusText();
  }

  messageInput.disabled = !hasLiveSession;
  sendBtn.disabled = !hasLiveSession || takeRequest?.sessionId === activeLiveSessionId;

  if (isStreaming || hasPendingInteraction || stopping) {
    abortBtn.classList.remove('hidden');
    // A shared tab can steer, and on a phone this button is how.
    sendBtn.classList.toggle('hidden', !activeTabIsShared() || !!hasPendingInteraction || !!stopping);
  } else {
    abortBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
  }
  if (hasLiveSession && !isStreaming) flushQueue();
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener('sessionSwitch', () => {
  console.log('[App] Session switched');
});

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════



const settingsBtn = document.getElementById('settings-btn')!;
const settingsPanel = document.getElementById('settings-panel')!;
const settingsOverlay = document.getElementById('settings-overlay')!;
const settingsClose = document.getElementById('settings-close')!;
const themeGrid = document.getElementById('theme-grid')!;


const toggleAutoCompact = document.getElementById('toggle-auto-compact')!;
const btnThinkingLevel = document.getElementById('btn-thinking-level')!;
const toggleShowThinking = document.getElementById('toggle-show-thinking')!;


function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes) as [ThemeId, (typeof themes)[ThemeId]][]) {
    const btn = document.createElement('button');
    btn.className = `theme-swatch${current === id ? ' active' : ''}`;
    const dots = (theme.colors || []).map(c => 
      `<span class="swatch-dot" style="background:${c}"></span>`
    ).join('');
    btn.innerHTML = `<span class="swatch-colors">${dots}</span>`;
    btn.addEventListener('click', () => {
      chooseTheme(id);
      themeGrid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
    });
    themeGrid.appendChild(btn);
  }
}

async function openSettings() {
  buildThemeGrid();
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');

  // Fetch current state for toggles
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state', sessionId: activeLiveSessionId }),
    });
    const data = await resp.json();
    if (data.success && data.data) {
      const s = data.data;
      // Auto-compaction toggle
      toggleAutoCompact.className = `settings-toggle${s.autoCompactionEnabled ? ' on' : ''}`;
      // Thinking level
      btnThinkingLevel.textContent = s.thinkingLevel || 'off';
      modelPickerController.setThinkingLevel(s.thinkingLevel || 'off');
      // Session name is managed by Pi session history; no editable field in Tau settings.
    }
  } catch (e) {
    // Silent
  }

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: 'get_auth' });
    if (authData?.success && authData.data?.configured) {
      authSection.style.display = '';
      toggleAuth.className = `settings-toggle${authData.data.enabled ? ' on' : ''}`;
    } else {
      authSection.style.display = 'none';
    }
  } catch {
    authSection.style.display = 'none';
  }
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

// Auto-compaction toggle
toggleAutoCompact.addEventListener('click', async () => {
  const isOn = toggleAutoCompact.classList.contains('on');
  toggleAutoCompact.className = `settings-toggle${isOn ? '' : ' on'}`;
  await rpcCommand({ type: 'set_auto_compaction', enabled: !isOn });
});

// Thinking level cycle (settings panel button)
btnThinkingLevel.addEventListener('click', async () => {
  const data = await rpcCommand({ type: 'cycle_thinking_level' });
  if (data?.success && data.data?.level) {
    btnThinkingLevel.textContent = data.data.level;
    modelPickerController.setThinkingLevel(data.data.level);
  }
});

// Show thinking toggle (local pref)
const showThinking = localStorage.getItem('tau-show-thinking') !== 'false';
toggleShowThinking.className = `settings-toggle${showThinking ? ' on' : ''}`;
if (!showThinking) document.body.classList.add('hide-thinking');

toggleShowThinking.addEventListener('click', () => {
  const isOn = toggleShowThinking.classList.contains('on');
  toggleShowThinking.className = `settings-toggle${isOn ? '' : ' on'}`;
  document.body.classList.toggle('hide-thinking', isOn);
  for (const blocks of assistantBlockControllers) blocks.refreshThinking();
  localStorage.setItem('tau-show-thinking', String(!isOn));
});

// Fullscreen preference: on by default for touch devices, off for desktop;
// an explicit choice is remembered. Browsers only enter fullscreen from a user
// gesture, so while the preference is on, any tap outside fullscreen enters it
// (also after the browser left fullscreen, e.g. on an app switch).
const toggleFullscreen = document.getElementById('toggle-fullscreen')!;
const installedFullscreen = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
if (document.fullscreenEnabled && !installedFullscreen) {
  const savedFullscreen = localStorage.getItem('tau-fullscreen');
  let preferFullscreen = savedFullscreen ? savedFullscreen === 'on' : matchMedia('(pointer: coarse)').matches;
  const changeFullscreen = (enter: boolean) => {
    if (enter === Boolean(document.fullscreenElement)) return;
    const change = enter ? document.documentElement.requestFullscreen() : document.exitFullscreen();
    change.catch((error: unknown) => console.warn('Fullscreen change failed', error));
  };
  const syncFullscreenToggle = () => {
    toggleFullscreen.className = `settings-toggle${preferFullscreen ? ' on' : ''}`;
  };
  syncFullscreenToggle();
  document.addEventListener('click', (event) => {
    if (preferFullscreen && !(event.target instanceof Element && event.target.closest('#toggle-fullscreen'))) changeFullscreen(true);
  }, true);
  toggleFullscreen.addEventListener('click', () => {
    preferFullscreen = !preferFullscreen;
    localStorage.setItem('tau-fullscreen', preferFullscreen ? 'on' : 'off');
    syncFullscreenToggle();
    changeFullscreen(preferFullscreen);
  });
} else if (!installedFullscreen) {
  // iPhone Safari has no element fullscreen; a Home Screen web app is.
  document.getElementById('fullscreen-label')!.textContent = 'Fullscreen: add Tau to your Home Screen';
  toggleFullscreen.style.display = 'none';
} else {
  document.getElementById('setting-fullscreen')!.style.display = 'none';
}

// Auth toggle
const toggleAuth = document.getElementById('toggle-auth')!;
const authSection = document.getElementById('settings-auth-section')!;

toggleAuth.addEventListener('click', async () => {
  const isOn = toggleAuth.classList.contains('on');
  const data = await rpcCommand({ type: 'set_auth', enabled: !isOn });
  if (data?.success) {
    toggleAuth.className = `settings-toggle${!isOn ? ' on' : ''}`;
  }
});





applyTheme(getCurrentTheme());

// ═══════════════════════════════════════
// Session stats card (opened from the context pill)
// ═══════════════════════════════════════

// Fetch authoritative session stats from pi's get_session_stats RPC. Uses a
// plain fetch (not rpcCommand) so it never flashes status-bar messages.
// Resolves null when there is no live session or the fetch fails; a stale
// response for a session we already switched away from is discarded, and any
// authoritative numbers are synced into the pill's local state.
async function fetchSessionStats(): Promise<SessionStats | null> {
  if (!viewingActiveSession || !activeLiveSessionId) return null;
  const requestSessionId = activeLiveSessionId;
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_session_stats', sessionId: requestSessionId }),
    });
    const data = await resp.json();
    if (!data?.success || !data.data) return null;
    if (activeLiveSessionId !== requestSessionId || !viewingActiveSession) return null;
    const stats = data.data as SessionStats;

    // Sync authoritative numbers into the locally-tracked pill state so the
    // pill never drifts from what pi reports. contextUsage (and its fields)
    // may be null right after compaction — keep the last known values then.
    if (typeof stats.cost === 'number') sessionTotalCost = stats.cost;
    const cu = stats.contextUsage;
    if (cu && typeof cu.contextWindow === 'number' && cu.contextWindow > 0) {
      contextWindowSize = cu.contextWindow;
    }
    if (cu && typeof cu.tokens === 'number') {
      lastInputTokens = cu.tokens;
    }
    updateContextPill();
    return stats;
  } catch {
    return null;
  }
}

const sessionStatsCard = setupSessionStatsCard({
  pillEl: contextPillEl,
  cardEl: document.getElementById('session-stats-card')!,
  fetchStats: fetchSessionStats,
  getFallback: () => ({
    usage: lastUsage,
    cost: sessionTotalCost,
    contextTokens: lastInputTokens,
    contextWindow: contextWindowSize,
  }),
});

// Voice input (assigned once the DOM hooks below exist; session changes cancel it)
voiceInput = setupVoiceInput(document.getElementById('mic-btn')!, messageInput as HTMLTextAreaElement, document.getElementById('voice-status')!);

// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, start with the sidebar collapsed. The context pill stays in the
// header on all screen sizes.
if (isMobile()) {
  sidebarEl.classList.add('collapsed');
}

wsClient.connect();
messageRenderer.renderWelcome();
updateLiveSessionInputState();
sidebar.loadProjects().then(() => {
  updateLiveSessionIndicators();
});
launcherPanel.init();

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Dismiss mobile splash screen
const splash = document.getElementById('mobile-splash');
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300);
  });
}

console.log('🚀 Tau initialized');
