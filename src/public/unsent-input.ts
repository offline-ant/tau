/**
 * What the user wrote for a shared agent that did not reach it.
 *
 * A shared agent outlives its Tau tab: the connection to it, or to Tau itself,
 * can end while it keeps running, and a tab id does not survive that. Input is
 * therefore kept under the agent's pimux id until a tab on that agent opens.
 * It goes back into the composer, never to Pi by itself: the user decides
 * whether it still applies, and a prompt that did arrive before the connection
 * ended is not sent twice.
 */

import type { PendingImage } from './app-types.js';

export type UnsentInput = { text: string; images: PendingImage[] };

export class UnsentInputStore {
  private kept = new Map<string, UnsentInput>();
  private inFlight = new Map<string, { muxId: string; input: UnsentInput }>();

  /** A prompt was handed to the WebSocket; it counts as sent once Tau acknowledges `id`. */
  track(id: string, muxId: string, input: UnsentInput) {
    this.inFlight.set(id, { muxId, input });
  }

  /** Tau answered prompt `id`. Returns whether it was tracked and failed, so its input is kept again. */
  settle(id: string, delivered: boolean): boolean {
    const prompt = this.inFlight.get(id);
    if (!prompt) return false;
    this.inFlight.delete(id);
    if (!delivered) this.keep(prompt.muxId, prompt.input);
    return !delivered;
  }

  /** The connection carrying these prompts ended, so no acknowledgement can arrive: all of them, or one agent's. */
  keepInFlight(muxId?: string) {
    for (const [id, prompt] of this.inFlight) {
      if (muxId !== undefined && prompt.muxId !== muxId) continue;
      this.inFlight.delete(id);
      this.keep(prompt.muxId, prompt.input);
    }
  }

  keep(muxId: string, input: UnsentInput) {
    const kept = this.kept.get(muxId);
    this.kept.set(muxId, kept
      ? { text: [kept.text, input.text].filter(Boolean).join('\n\n'), images: [...kept.images, ...input.images] }
      : input);
  }

  take(muxId: string): UnsentInput | null {
    const input = this.kept.get(muxId) ?? null;
    this.kept.delete(muxId);
    return input;
  }

  /** The user detached on purpose; nothing is coming back for this agent. */
  forget(muxId: string) {
    this.kept.delete(muxId);
    for (const [id, prompt] of this.inFlight) if (prompt.muxId === muxId) this.inFlight.delete(id);
  }
}
