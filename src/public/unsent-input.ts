/** Input kept for review, never replayed, under its original agent, file and leaf. */
import type { PendingFilePath, PendingImage } from './app-types.js';

export type InputContext = { agentId: string | null; file: string | null; leafId: string | null | undefined };
export type UnsentInput = { text: string; images: PendingImage[]; files?: PendingFilePath[] };
export type KeptInput = { context: InputContext; input: UnsentInput };

export function contextKey(context: InputContext): string {
  return JSON.stringify([context.agentId, context.file, context.leafId === undefined ? [] : [context.leafId]]);
}

export function sameContext(left: InputContext | null, right: InputContext | null): boolean {
  return left === right || !!left && !!right && contextKey(left) === contextKey(right);
}

export class UnsentInputStore {
  private kept = new Map<string, KeptInput>();
  private inFlight = new Map<string, { context: InputContext; input: UnsentInput }>();

  /** Receipt loss is not rejection: preserved text always needs explicit review. */
  track(id: string, context: InputContext, input: UnsentInput) {
    this.inFlight.set(id, { context: { ...context }, input });
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
    this.kept.set(key, { context: { ...context }, input: kept
      ? { text: [kept.text, input.text].filter(Boolean).join('\n\n'), images: [...kept.images, ...input.images],
        ...((kept.files?.length || input.files?.length) ? { files: [...kept.files || [], ...input.files || []] } : {}) }
      : { ...input, images: [...input.images], ...(input.files ? { files: [...input.files] } : {}) } });
  }

  entries(): KeptInput[] {
    return [...this.kept.values()].map(({ context, input }) => ({ context: { ...context }, input }));
  }

  /** The caller has explicitly chosen this original context for reuse or discard. */
  take(context: InputContext): UnsentInput | null {
    const key = contextKey(context), input = this.kept.get(key)?.input ?? null;
    this.kept.delete(key);
    return input;
  }
}
