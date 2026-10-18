/** Consumed links must not override the saved tab when the page reloads. */
export function clearSessionLinkHash(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'state' | 'replaceState'>,
): void {
  if (location.hash.startsWith('#session=')) {
    history.replaceState(history.state, '', location.pathname + location.search);
  }
}

/** One navigation intent, consumed against the next authoritative live-tab list. */
export type SessionLinkResult =
  | { kind: 'select'; id: string }
  | { kind: 'missing' }
  | { kind: 'invalid' };

export class SessionLink {
  private pending: string | null = null;
  private invalid = false;

  constructor(hash: string) { this.set(hash); }

  set(hash: string): void {
    this.cancel();
    if (!hash.startsWith('#session=')) return;
    try {
      const id = decodeURIComponent(hash.slice('#session='.length));
      if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('Invalid session id');
      this.pending = id;
    } catch {
      this.invalid = true;
    }
  }

  cancel(): void {
    this.pending = null;
    this.invalid = false;
  }

  take(liveIds: Iterable<string>): SessionLinkResult | null {
    const id = this.pending;
    const invalid = this.invalid;
    this.cancel();
    if (invalid) return { kind: 'invalid' };
    if (id === null) return null;
    return Array.from(liveIds).includes(id) ? { kind: 'select', id } : { kind: 'missing' };
  }
}
