/**
 * SessionTerminalMap — one terminal per (host, tmux session).
 *
 * Parity model (#103): a host is ONE SSH connection carrying N tmux sessions.
 * Each (host, tmux session) pair gets exactly ONE editor terminal tab. Opening
 * the same (host, session) again reuses its tab; opening a different session on
 * an already-connected host opens a second tab over the same SSH connection.
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
  /** The stable SSH host id this terminal belongs to. */
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

/** Build the composite storage key for a (hostId, sessionName) pair. */
export function sessionTerminalKey(hostId: number, sessionName: string): string {
  return `${hostId}:${sessionName}`;
}

/**
 * A map from (host id, tmux session name) to a single session terminal entry.
 *
 * Invariants:
 *   - At most one entry per (hostId, sessionName) — one tab per tmux session.
 *     A host may have MANY entries (one per open tmux session).
 *   - `register` replaces any pre-existing entry for the same
 *     (hostId, sessionName) and disposes the previous terminal via the supplied
 *     disposer (so reconnecting a session never creates a second tab — the old
 *     one is torn down first).
 *   - `get(hostId)` / `has(hostId)` (sessionName omitted) address the host's
 *     first entry — retained for single-session callers that do not care which
 *     tmux session backs the tab.
 *   - `get(hostId, sessionName)` / `has(hostId, sessionName)` address a specific
 *     tmux session's tab.
 */
export class SessionTerminalMap<T> {
  private readonly entries = new Map<string, SessionTerminalEntry<T>>();
  private readonly disposeTerminal: DisposeTerminal<T>;

  constructor(disposeTerminal: DisposeTerminal<T>) {
    this.disposeTerminal = disposeTerminal;
  }

  /**
   * Return the terminal entry for a host.
   *
   * If `sessionName` is given, address that specific tmux session's tab. Without
   * `sessionName`, return the host's first entry (insertion order) — useful for
   * single-session callers. Returns undefined if no entry matches.
   */
  get(hostId: number, sessionName?: string): SessionTerminalEntry<T> | undefined {
    if (sessionName !== undefined) {
      return this.entries.get(sessionTerminalKey(hostId, sessionName));
    }
    for (const entry of this.entries.values()) {
      if (entry.hostId === hostId) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Whether a terminal entry is currently registered.
   *
   * With `sessionName`: for that specific (host, session). Without: whether the
   * host has any entry at all.
   */
  has(hostId: number, sessionName?: string): boolean {
    if (sessionName !== undefined) {
      return this.entries.has(sessionTerminalKey(hostId, sessionName));
    }
    for (const entry of this.entries.values()) {
      if (entry.hostId === hostId) {
        return true;
      }
    }
    return false;
  }

  /**
   * Register a terminal entry for a (host, tmux session).
   *
   * If an entry already exists for the same (hostId, sessionName) it is
   * replaced: the old terminal handle is disposed first (so VS Code closes the
   * stale tab before the new one opens, avoiding transient duplicate tabs).
   * A different sessionName on the same host adds a new entry (multi-session).
   */
  register(entry: SessionTerminalEntry<T>): SessionTerminalEntry<T> {
    const key = sessionTerminalKey(entry.hostId, entry.sessionName);
    const existing = this.entries.get(key);
    if (existing) {
      this.disposeTerminal(existing.terminal);
    }
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Remove and dispose the entry for a (host, session), if any. Returns true if
   * an entry was removed.
   */
  delete(hostId: number, sessionName: string): boolean {
    const key = sessionTerminalKey(hostId, sessionName);
    const existing = this.entries.get(key);
    if (!existing) {
      return false;
    }
    this.entries.delete(key);
    this.disposeTerminal(existing.terminal);
    return true;
  }

  /**
   * Remove an entry by its terminal handle identity WITHOUT disposing it
   * (used when VS Code reports the terminal was closed by the user — the
   * terminal is already gone). Returns true if an entry was removed.
   */
  removeByTerminal(terminal: T): boolean {
    for (const [key, entry] of this.entries) {
      if (entry.terminal === terminal) {
        this.entries.delete(key);
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
   * Return a snapshot of all registered session terminals for one host.
   * Order is insertion order; callers should sort if they need a stable order.
   */
  listForHost(hostId: number): SessionTerminalEntry<T>[] {
    return this.list().filter((entry) => entry.hostId === hostId);
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
 * Derive a stable, tmux-safe default session name for a host.
 *
 * This is the DEFAULT attach target when the user connects to a host without
 * picking a specific session (mirrors the PocketShell Android app's stable,
 * host-derived session). Multiple concurrent sessions on the same host use
 * distinct names supplied by the caller (e.g. directory-derived). tmux session
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
