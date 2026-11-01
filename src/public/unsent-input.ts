/** Input kept for review, never replayed, under its original agent, file and leaf. */
import type { PendingFilePath, PendingImage } from './app-types.js';

/** Opaque runtime anchor; only a complete owning snapshot can supply it. */
export type RuntimeInputContext = { sessionFile: string | null; leafId: string | null; contextId: string };
export type InputContext = { agentId: string | null; file: string | null; leafId: string | null | undefined; runtimeContext?: RuntimeInputContext | null };
export type CommandTarget = { sessionId: string; inputContext: InputContext };

export function runtimeInputContext(value: unknown): RuntimeInputContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const context = value as Record<string, unknown>;
  if (!(context.sessionFile === null || typeof context.sessionFile === 'string')
    || !(context.leafId === null || typeof context.leafId === 'string')
    || typeof context.contextId !== 'string' || !context.contextId) return null;
  return { sessionFile: context.sessionFile, leafId: context.leafId, contextId: context.contextId };
}

export function copyInputContext(context: InputContext): InputContext {
  return { ...context, ...(context.runtimeContext ? { runtimeContext: { ...context.runtimeContext } } : {}) };
}
export type UnsentInput = { text: string; images: PendingImage[]; files?: PendingFilePath[] };
export type KeptInput = { context: InputContext; input: UnsentInput };

export function contextKey(context: InputContext): string {
  const anchor = context.runtimeContext;
  return JSON.stringify([context.agentId, context.file, anchor
    ? [anchor.sessionFile, anchor.leafId, anchor.contextId]
    : [context.leafId === undefined ? [] : [context.leafId]]]);
}

export function sameContext(left: InputContext | null, right: InputContext | null): boolean {
  return left === right || !!left && !!right && contextKey(left) === contextKey(right);
}

export class UnsentInputStore {
  private kept = new Map<string, KeptInput>();
  private inFlight = new Map<string, { context: InputContext; input: UnsentInput }>();

  /** Receipt loss is not rejection: preserved text always needs explicit review. */
  track(id: string, context: InputContext, input: UnsentInput) {
    this.inFlight.set(id, { context: copyInputContext(context), input });
  }

  settle(id: string, delivered: boolean): boolean {
    const prompt = this.inFlight.get(id);
    if (!prompt) return false;
    this.inFlight.delete(id);
    if (!delivered) this.keep(prompt.context, prompt.input);
    return !delivered;
  }

  keepInFlight(context?: InputContext) {
    for (const [id, prompt] of this.inFlight) {
      if (context && !sameContext(context, prompt.context)) continue;
      this.inFlight.delete(id);
      this.keep(prompt.context, prompt.input);
    }
  }

  keep(context: InputContext, input: UnsentInput) {
    if (!input.text && !input.images.length && !input.files?.length) return;
    const key = contextKey(context), kept = this.kept.get(key)?.input;
    this.kept.set(key, { context: copyInputContext(context), input: kept
      ? { text: [kept.text, input.text].filter(Boolean).join('\n\n'), images: [...kept.images, ...input.images],
        ...((kept.files?.length || input.files?.length) ? { files: [...kept.files || [], ...input.files || []] } : {}) }
      : { ...input, images: [...input.images], ...(input.files ? { files: [...input.files] } : {}) } });
  }

  entries(): KeptInput[] {
    return [...this.kept.values()].map(({ context, input }) => ({ context: copyInputContext(context), input }));
  }

  /** The caller has explicitly chosen this original context for reuse or discard. */
  take(context: InputContext): UnsentInput | null {
    const key = contextKey(context), input = this.kept.get(key)?.input ?? null;
    this.kept.delete(key);
    return input;
  }
}
