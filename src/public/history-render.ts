/** Pure history pre-pass. Tool results stay attached to their calls. */
import type { AppMessage, AssistantStep, UsageRecord } from './app-types.js';
import type { ToolResult } from './tool-card.js';

export type SessionHistoryEntry = {
  type?: string;
  message?: AppMessage;
  usage?: UsageRecord;
  /** Fields of a `compaction` entry. Entries from a session file have no estimate. */
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
};
/** A user image: its base64 data, or, from a server snapshot, a link to it. */
export type HistoryImage = { data: string; mimeType: string; url?: string };
export type HistoryUserItem = { kind: 'user'; content: string; images?: HistoryImage[] };
export type HistoryAssistantItem = { kind: 'assistant'; step: AssistantStep };
export type HistoryToolCallItem = {
  kind: 'toolCall';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  isError?: boolean;
};
/** The divider for a finished compaction, at the point where it happened. */
export type HistoryCompactionItem = {
  kind: 'compaction';
  summary: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
};
export type HistoryItem = HistoryUserItem | HistoryAssistantItem | HistoryToolCallItem
  | { kind: 'assistantError'; error: string } | HistoryCompactionItem;
export type HistoryBuildResult = {
  items: HistoryItem[];
  totalCost: number;
  lastInputTokens: number;
  /** True when lastInputTokens is Pi's estimate after a compaction, not usage a reply reported. */
  contextTokensEstimated: boolean;
  lastUsage: UsageRecord | null;
};

/**
 * Mark failed assistant replies that a later assistant reply replaced within
 * the same turn. Pi keeps the failed attempt in the session file while it
 * retries, so reopening the session must not show errors the user never saw
 * as final.
 */
function findRecoveredErrorEntries(entries: SessionHistoryEntry[]): Set<number> {
  const recovered = new Set<number>();
  let laterAssistantReply = false;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    if (message.role === 'user') {
      laterAssistantReply = false;
      continue;
    }
    if (message.role !== 'assistant') continue;
    if (message.stopReason === 'error' && laterAssistantReply) recovered.add(index);
    laterAssistantReply = true;
  }
  return recovered;
}

export function messageImages(message: AppMessage): HistoryImage[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter(block => block.type === 'image').map(block => ({
    data: block.source?.data || block.data || '',
    mimeType: block.source?.media_type || block.mimeType || block.media_type || 'image/png',
    ...(typeof block.url === 'string' ? { url: block.url } : {}),
  }));
}

export function buildHistoryItems(entries: SessionHistoryEntry[]): HistoryBuildResult {
  const items: HistoryItem[] = [];
  const toolCallItems = new Map<string, HistoryToolCallItem>();
  const recoveredErrorEntries = findRecoveredErrorEntries(entries);
  let totalCost = 0;
  let lastInputTokens = 0;
  let contextTokensEstimated = false;
  let lastUsage: UsageRecord | null = null;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.type === 'compaction') {
      items.push({
        kind: 'compaction',
        summary: typeof entry.summary === 'string' ? entry.summary : '',
        ...(typeof entry.tokensBefore === 'number' ? { tokensBefore: entry.tokensBefore } : {}),
        ...(typeof entry.estimatedTokensAfter === 'number' ? { estimatedTokensAfter: entry.estimatedTokensAfter } : {}),
      });
      // Usage from before the compaction no longer describes the context.
      lastInputTokens = typeof entry.estimatedTokensAfter === 'number' ? entry.estimatedTokensAfter : 0;
      contextTokensEstimated = lastInputTokens > 0;
      continue;
    }
    // Cache warming costs money but does not replace the context measurement.
    if (entry.type === 'usage') totalCost += entry.usage?.cost?.total || 0;
    if (entry.type !== 'message') continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content
        : (msg.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      const images = messageImages(msg);
      if (content || images.length) items.push({ kind: 'user', content, images: images.length ? images : undefined });
    } else if (msg.role === 'assistant') {
      // Usage belongs to the message, not each visual step within it.
      totalCost += msg.usage?.cost?.total || 0;
      if (msg.usage?.input) {
        lastInputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
        contextTokensEstimated = false;
        lastUsage = msg.usage;
      }
      const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content || [];
      for (const block of blocks) {
        if (block.type === 'text' || block.type === 'thinking') {
          items.push({ kind: 'assistant', step: { type: block.type, text: block.type === 'thinking' ? block.thinking || '' : block.text || '' } });
        } else if (block.type === 'toolCall') {
          const item: HistoryToolCallItem = {
            kind: 'toolCall', toolCallId: block.id || '', toolName: block.name || '', args: block.arguments || {},
          };
          items.push(item);
          toolCallItems.set(item.toolCallId, item);
        }
      }
      if (msg.stopReason === 'error' && !recoveredErrorEntries.has(index)) {
        items.push({ kind: 'assistantError', error: msg.errorMessage || 'Request failed' });
      }
    } else if (msg.role === 'toolResult') {
      const item = toolCallItems.get(msg.toolCallId ?? '');
      if (item) {
        item.result = {
          content: typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content || [],
          ...(msg.nestedCalls ? { nestedCalls: msg.nestedCalls } : {}),
        };
        item.isError = msg.isError ?? false;
      }
    }
  }
  return { items, totalCost, lastInputTokens, contextTokensEstimated, lastUsage };
}
