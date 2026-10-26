/** Pure history pre-pass. Tool results stay attached to their calls. */
import type { AppMessage, AssistantStep, MessageContentBlock, UsageRecord } from './app-types.js';
import type { ToolResult } from './tool-card.js';

export type SessionHistoryEntry = { type?: string; message?: AppMessage; usage?: UsageRecord; summary?: string };
export type HistoryImage = { data: string; mimeType: string };
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
export type HistoryItem = HistoryUserItem | HistoryAssistantItem | HistoryToolCallItem | { kind: 'compaction'; summary?: string };
export type HistoryBuildResult = {
  items: HistoryItem[];
  totalCost: number;
  lastInputTokens: number;
  lastUsage: UsageRecord | null;
};

export function buildHistoryItems(entries: SessionHistoryEntry[]): HistoryBuildResult {
  const items: HistoryItem[] = [];
  const toolCallItems = new Map<string, HistoryToolCallItem>();
  let totalCost = 0;
  let lastInputTokens = 0;
  let lastUsage: UsageRecord | null = null;

  for (const entry of entries) {
    if (entry.type === 'compaction') {
      items.push({ kind: 'compaction', summary: entry.summary });
    }
    if (entry.type === 'usage') totalCost += entry.usage?.cost?.total || 0;
    if (entry.type !== 'message') continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content
        : (msg.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      const images = Array.isArray(msg.content) ? msg.content.filter(block => block.type === 'image')
        .map(block => ({ data: block.source?.data || block.data || '', mimeType: block.source?.media_type || block.media_type || 'image/png' })) : [];
      if (content || images.length) items.push({ kind: 'user', content, images: images.length ? images : undefined });
    } else if (msg.role === 'assistant') {
      // Usage belongs to the message, not each visual step within it.
      totalCost += msg.usage?.cost?.total || 0;
      if (msg.usage?.input) {
        lastInputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
        lastUsage = msg.usage;
      }
      for (const block of (msg.content as MessageContentBlock[]) || []) {
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
    } else if (msg.role === 'toolResult') {
      const item = toolCallItems.get(msg.toolCallId ?? '');
      if (item) {
        item.result = { content: (msg.content as MessageContentBlock[]) || [] };
        item.isError = msg.isError ?? false;
      }
    }
  }
  return { items, totalCost, lastInputTokens, lastUsage };
}
