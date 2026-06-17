/**
 * SessionTerminalMap — one terminal per SSH session (host).
 *
 * The terminal-surface rework models "sessions" as SSH connections to a host:
 * each host (PocketShell/SSH session) gets exactly ONE terminal tab in the
 * editor area. Reconnecting or re-selecting a host MUST reuse its existing
 * tab rather than piling up duplicate terminals.
 *
 * This module holds the pure (non-vscode) mapping logic so it can be unit
 * tested without the VS Code API. The extension layer wraps a `vscode.Terminal`
 * around this map (see session-terminal-registry.ts in the extension).
 *
 * The map is generic over the terminal handle type `T` so the pure logic is
 * independent of the concrete terminal object owned by the host process.
 */

/**
 * A registered session terminal: the terminal handle plus the metadata needed
 * to (re)identify and surface it in the left-panel session list.
 */
export interface SessionTerminalEntry<T> {
  /** The stable SSH host id this terminal belongs to (the session key). */
  hostId: number;
  /** Display label for the host (name or hostname). */
  hostLabel: string;
  /** The underlying terminal handle (e.g. vscode.Terminal in the extension). */
  terminal: T;
  /** tmux session name backing this terminal on the remote. */
  sessionName: string;
  /** Epoch milliseconds when the session terminal was first opened. */
  createdAt: number;
}

/**
 * Callback used to release a terminal handle when it is evicted from the map.
 * The extension uses this to dispose the underlying vscode.Terminal.
 */
export type DisposeTerminal<T> = (terminal: T) => void;

/**
 * A map from SSH host id to a single session terminal entry.
 *
 * Invariants:
 *   - At most one entry per hostId (one tab per session).
 *   - `register` replaces any pre-existing entry for the same hostId and
 *     disposes the previous terminal via the supplied disposer (so reconnecting
 *     a host never creates a second tab — the old one is torn down first).
 *   - `get` returns the current entry for a host, or undefined.
 */
export class SessionTerminalMap<T> {
  private readonly entries = new Map<number, SessionTerminalEntry<T>>();
  private readonly disposeTerminal: DisposeTerminal<T>;

  constructor(disposeTerminal: DisposeTerminal<T>) {
    this.disposeTerminal = disposeTerminal;
  }

  /**
   * Return the existing terminal entry for `hostId`, or undefined if none.
   */
  get(hostId: number): SessionTerminalEntry<T> | undefined {
    return this.entries.get(hostId);
  }

  /**
   * Whether a terminal entry is currently registered for `hostId`.
   */
  has(hostId: number): boolean {
    return this.entries.has(hostId);
  }

  /**
   * Register a terminal entry for a host.
   *
   * If an entry already exists for the same hostId it is replaced: the old
   * terminal handle is disposed first (so VS Code closes the stale tab before
   * the new one opens, avoiding transient duplicate tabs).
   */
  register(entry: SessionTerminalEntry<T>): SessionTerminalEntry<T> {
    const existing = this.entries.get(entry.hostId);
    if (existing) {
      this.disposeTerminal(existing.terminal);
    }
    this.entries.set(entry.hostId, entry);
    return entry;
  }

  /**
   * Remove and dispose the entry for `hostId`, if any. Returns true if an
   * entry was removed.
   */
  delete(hostId: number): boolean {
    const existing = this.entries.get(hostId);
    if (!existing) {
      return false;
    }
    this.entries.delete(hostId);
    this.disposeTerminal(existing.terminal);
    return true;
  }

  /**
   * Remove an entry by its terminal handle identity WITHOUT disposing it
   * (used when VS Code reports the terminal was closed by the user — the
   * terminal is already gone). Returns true if an entry was removed.
   */
  removeByTerminal(terminal: T): boolean {
    for (const [hostId, entry] of this.entries) {
      if (entry.terminal === terminal) {
        this.entries.delete(hostId);
        return true;
      }
    }
    return false;
  }

  /**
   * Return a snapshot of all registered session terminals. Order is not
   * guaranteed; callers should sort if they need a stable order.
   */
  list(): SessionTerminalEntry<T>[] {
    return Array.from(this.entries.values());
  }

  /**
   * Number of currently registered session terminals.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Remove and dispose every entry.
   */
  clear(): void {
    for (const entry of this.entries.values()) {
      this.disposeTerminal(entry.terminal);
    }
    this.entries.clear();
  }
}

/**
 * Derive a stable, tmux-safe session name for a host.
 *
 * The terminal-surface rework backs each host's editor terminal with a tmux
 * -CC session named after the host, so reconnecting attaches to the same
 * remote shell (the same behavior as the PocketShell Android app). tmux session
 * names may not contain a colon or start with a dot; this sanitizes the host
 * label accordingly and prefixes it so the session is recognisable as
 * PocketShell-managed.
 */
export function tmuxSessionNameForHost(hostLabel: string): string {
  const sanitized = hostLabel
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'default';
  return `pocketshell-${sanitized}`;
}
