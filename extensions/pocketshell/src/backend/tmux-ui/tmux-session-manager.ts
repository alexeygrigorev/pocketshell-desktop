/**
 * Tmux Session Manager
 *
 * Bridges the tmux -CC client with the terminal system and exposes
 * a management API for the UI layer.
 *
 * Responsibilities:
 *   - Keep TmuxState synchronized by subscribing to TmuxClient events
 *   - Automatically create/close terminals when panes are added/removed
 *   - Map pane IDs to terminal IDs
 *   - Provide session/window/pane operations
 */

import type { TmuxClient, SshChannel } from '../tmux/client';
import type { TmuxState, TmuxSession, TmuxWindow, TmuxPane } from '../tmux/state';
import { emptyState, allPanes } from '../tmux/state';
import type { TerminalManager, SshTerminal } from '../terminal/terminal-manager';
import type { SplitDirection } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StateChangeCallback = (state: TmuxState) => void;

// ---------------------------------------------------------------------------
// TmuxSessionManager
// ---------------------------------------------------------------------------

export class TmuxSessionManager {
  private tmuxClient: TmuxClient;
  private terminalManager: TerminalManager;

  /** Current cached state snapshot from the tmux client. */
  private state: TmuxState = emptyState();

  /** Map from pane ID (e.g. "%0") to terminal ID (e.g. "ssh-term-3"). */
  private paneToTerminal = new Map<string, string>();

  /** Map from terminal ID to pane ID (reverse lookup). */
  private terminalToPane = new Map<string, string>();

  /** State change subscribers. */
  private stateChangeCallbacks = new Set<StateChangeCallback>();

  /** Subscription handle from TmuxClient.onStateChange(). */
  private clientStateSub: { unsubscribe(): void } | null = null;

  /** SSH connection parameters needed to create terminals for panes. */
  private hostId: number | null = null;

  /** Whether the manager has been started. */
  private started = false;

  constructor(tmuxClient: TmuxClient, terminalManager: TerminalManager) {
    this.tmuxClient = tmuxClient;
    this.terminalManager = terminalManager;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start tmux control mode via SSH, initialize state tracking.
   *
   * @param channel - SSH channel for the tmux control mode session
   * @param hostId - Host ID for creating terminals
   */
  async start(channel: SshChannel, hostId: number): Promise<void> {
    if (this.started) {
      throw new Error('TmuxSessionManager already started');
    }

    this.hostId = hostId;

    // Subscribe to client state changes before connecting
    this.clientStateSub = this.tmuxClient.onStateChange((newState) => {
      const prevState = this.state;
      this.state = newState;
      this.onStateUpdate(prevState, newState);
      this.notifyStateChange();
    });

    // Connect the tmux client via the SSH channel
    await this.tmuxClient.connect(channel);

    this.started = true;
  }

  /**
   * Detach from tmux and close all tmux terminals.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    // Unsubscribe from client events
    if (this.clientStateSub) {
      this.clientStateSub.unsubscribe();
      this.clientStateSub = null;
    }

    // Detach the tmux client (best effort)
    try {
      await this.tmuxClient.detach();
    } catch {
      // Best effort
    }

    // Close all terminals that belong to tmux panes
    this.closeAllPaneTerminals();

    this.state = emptyState();
    this.paneToTerminal.clear();
    this.terminalToPane.clear();
    this.hostId = null;
    this.started = false;
  }

  // -----------------------------------------------------------------------
  // State queries
  // -----------------------------------------------------------------------

  /**
   * Get the current tmux state snapshot.
   */
  getState(): TmuxState {
    return this.state;
  }

  /**
   * Subscribe to state updates.
   * Returns an unsubscribe function.
   */
  onStateChange(callback: StateChangeCallback): () => void {
    this.stateChangeCallbacks.add(callback);
    return () => {
      this.stateChangeCallbacks.delete(callback);
    };
  }

  // -----------------------------------------------------------------------
  // Session operations
  // -----------------------------------------------------------------------

  /**
   * Create a new tmux session.
   */
  async createSession(name: string, cwd?: string): Promise<TmuxSession> {
    const response = await this.tmuxClient.newSession(name, cwd);
    if (response.isError) {
      throw new Error(`Failed to create session: ${response.output.join('\n')}`);
    }

    // Refresh state to pick up the new session
    await this.tmuxClient.refreshState();

    // Find the newly created session in state
    const state = this.tmuxClient.getState();
    for (const [_sessionId, session] of state.sessions) {
      if (session.name === name) {
        return session;
      }
    }

    throw new Error(`Session "${name}" not found after creation`);
  }

  /**
   * Kill a tmux session and cleanup associated terminals.
   */
  async killSession(sessionId: string): Promise<void> {
    // Collect all pane IDs in this session before killing
    const session = this.state.sessions.get(sessionId);
    const paneIds: string[] = [];
    if (session) {
      for (const window of session.windows.values()) {
        for (const paneId of window.panes.keys()) {
          paneIds.push(paneId);
        }
      }
    }

    const response = await this.tmuxClient.killSession(sessionId);
    if (response.isError) {
      throw new Error(`Failed to kill session: ${response.output.join('\n')}`);
    }

    // Cleanup terminals for all panes that were in this session
    for (const paneId of paneIds) {
      this.removePaneTerminal(paneId);
    }
  }

  /**
   * Rename a tmux session.
   */
  async renameSession(sessionId: string, newName: string): Promise<void> {
    const response = await this.tmuxClient.renameSession(sessionId, newName);
    if (response.isError) {
      throw new Error(`Failed to rename session: ${response.output.join('\n')}`);
    }
  }

  /**
   * Switch to a different tmux session.
   */
  async switchSession(sessionId: string): Promise<void> {
    // switch-client in -CC mode triggers a session-changed event
    const response = await this.tmuxClient.sendCommand(`switch-client -t ${sessionId}`);
    if (response.isError) {
      throw new Error(`Failed to switch session: ${response.output.join('\n')}`);
    }
  }

  // -----------------------------------------------------------------------
  // Window operations
  // -----------------------------------------------------------------------

  /**
   * Create a new window in a session.
   */
  async createWindow(sessionId: string, name?: string): Promise<TmuxWindow> {
    const response = await this.tmuxClient.newWindow(sessionId, name);
    if (response.isError) {
      throw new Error(`Failed to create window: ${response.output.join('\n')}`);
    }

    // Refresh state to pick up the new window and its initial pane
    await this.tmuxClient.refreshState();

    // Find the new window — it will be the newest window in the session
    const state = this.tmuxClient.getState();
    const session = state.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found after window creation`);
    }

    // Return the last window in order (most recently added)
    const lastWindowId = session.windowOrder[session.windowOrder.length - 1];
    if (lastWindowId) {
      const win = session.windows.get(lastWindowId);
      if (win) return win;
    }

    throw new Error('New window not found after creation');
  }

  /**
   * Kill a window and cleanup pane terminals.
   */
  async killWindow(windowId: string): Promise<void> {
    // Collect all pane IDs in this window before killing
    const paneIds = this.getPaneIdsForWindow(windowId);

    const response = await this.tmuxClient.killWindow(windowId);
    if (response.isError) {
      throw new Error(`Failed to kill window: ${response.output.join('\n')}`);
    }

    // Cleanup terminals for all panes that were in this window
    for (const paneId of paneIds) {
      this.removePaneTerminal(paneId);
    }
  }

  /**
   * Rename a window.
   */
  async renameWindow(windowId: string, newName: string): Promise<void> {
    const response = await this.tmuxClient.sendCommand(`rename-window -t ${windowId} '${newName.replace(/'/g, "'\\''")}'`);
    if (response.isError) {
      throw new Error(`Failed to rename window: ${response.output.join('\n')}`);
    }
  }

  /**
   * Switch to a different window.
   */
  async switchWindow(windowId: string): Promise<void> {
    const response = await this.tmuxClient.selectWindow(windowId);
    if (response.isError) {
      throw new Error(`Failed to switch window: ${response.output.join('\n')}`);
    }
  }

  // -----------------------------------------------------------------------
  // Pane operations
  // -----------------------------------------------------------------------

  /**
   * Split a pane (creates a new pane and a terminal for it).
   */
  async splitPane(windowId: string, direction: SplitDirection = 'vertical'): Promise<TmuxPane> {
    // Find a pane in this window to split
    const paneId = this.findPaneInWindow(windowId);
    if (!paneId) {
      throw new Error(`No pane found in window ${windowId} to split`);
    }

    const horizontal = direction === 'horizontal';
    const response = await this.tmuxClient.splitWindow(paneId, horizontal);
    if (response.isError) {
      throw new Error(`Failed to split pane: ${response.output.join('\n')}`);
    }

    // Refresh state to discover the new pane
    await this.tmuxClient.refreshState();

    // Find the new pane — look for panes in this window that don't have terminals yet
    const state = this.tmuxClient.getState();
    for (const session of state.sessions.values()) {
      const win = session.windows.get(windowId);
      if (!win) continue;
      for (const pane of win.panes.values()) {
        if (!this.paneToTerminal.has(pane.id) && pane.id !== paneId) {
          return pane;
        }
      }
    }

    throw new Error('New pane not found after split');
  }

  /**
   * Kill a pane and cleanup its terminal.
   */
  async killPane(paneId: string): Promise<void> {
    const response = await this.tmuxClient.killPane(paneId);
    if (response.isError) {
      throw new Error(`Failed to kill pane: ${response.output.join('\n')}`);
    }

    // Cleanup the terminal for this pane
    this.removePaneTerminal(paneId);
  }

  /**
   * Get the terminal associated with a pane, if any.
   */
  getPaneTerminal(paneId: string): SshTerminal | undefined {
    const terminalId = this.paneToTerminal.get(paneId);
    if (!terminalId) return undefined;
    return this.terminalManager.getTerminal(terminalId);
  }

  /**
   * Capture the visible content of a pane.
   */
  async capturePane(paneId: string): Promise<string> {
    const result = await this.tmuxClient.captureWithCursor(paneId, 0);
    return result.capture.output.join('\n');
  }

  // -----------------------------------------------------------------------
  // Pane-terminal mapping
  // -----------------------------------------------------------------------

  /**
   * Get the pane-to-terminal mapping (for snapshot builder).
   */
  getPaneTerminalMap(): ReadonlyMap<string, string> {
    return this.paneToTerminal;
  }

  // -----------------------------------------------------------------------
  // Internal: state synchronization
  // -----------------------------------------------------------------------

  /**
   * Called when the TmuxClient state changes.
   * Detects pane additions/removals and manages terminals accordingly.
   */
  private onStateUpdate(prevState: TmuxState, newState: TmuxState): void {
    const prevPanes = allPanes(prevState);
    const newPanes = allPanes(newState);

    const prevPaneIds = new Set(prevPanes.map(p => p.id));
    const newPaneIds = new Set(newPanes.map(p => p.id));

    // Detect added panes
    for (const paneId of newPaneIds) {
      if (!prevPaneIds.has(paneId)) {
        this.onPaneAdded(paneId);
      }
    }

    // Detect removed panes
    for (const paneId of prevPaneIds) {
      if (!newPaneIds.has(paneId)) {
        this.onPaneRemoved(paneId);
      }
    }
  }

  /**
   * Handle a new pane being added — create a terminal for it.
   *
   * Note: In a real integration, we'd open a dedicated SSH exec channel
   * per pane. For now, the terminal creation is deferred to when the UI
   * actually needs to render a pane's content. We just track the mapping.
   */
  private onPaneAdded(_paneId: string): void {
    // Terminal creation is lazy — getPaneTerminal will return undefined
    // until the UI requests a terminal. This avoids opening SSH channels
    // for panes that might not be visible.
    //
    // If eager creation is desired, uncomment below:
    // await this.createPaneTerminal(paneId);
  }

  /**
   * Handle a pane being removed — cleanup its terminal.
   */
  private onPaneRemoved(paneId: string): void {
    this.removePaneTerminal(paneId);
  }

  /**
   * Create a terminal for a pane.
   * Associates the terminal with the pane in the mapping.
   */
  async createPaneTerminal(
    paneId: string,
    connection: import('../ssh/connection/ssh-client').SshConnection,
  ): Promise<SshTerminal> {
    // If already has a terminal, return existing
    const existingId = this.paneToTerminal.get(paneId);
    if (existingId) {
      const existing = this.terminalManager.getTerminal(existingId);
      if (existing) return existing;
    }

    const terminal = await this.terminalManager.createTerminal(
      this.hostId!,
      connection,
      { name: `tmux ${paneId}` },
    );

    this.paneToTerminal.set(paneId, terminal.id);
    this.terminalToPane.set(terminal.id, paneId);

    return terminal;
  }

  /**
   * Remove the terminal associated with a pane.
   */
  private removePaneTerminal(paneId: string): void {
    const terminalId = this.paneToTerminal.get(paneId);
    if (terminalId) {
      this.terminalManager.closeTerminal(terminalId);
      this.paneToTerminal.delete(paneId);
      this.terminalToPane.delete(terminalId);
    }
  }

  /**
   * Close all pane-associated terminals.
   */
  private closeAllPaneTerminals(): void {
    for (const [_paneId, terminalId] of this.paneToTerminal) {
      this.terminalManager.closeTerminal(terminalId);
    }
    this.paneToTerminal.clear();
    this.terminalToPane.clear();
  }

  // -----------------------------------------------------------------------
  // Internal: helpers
  // -----------------------------------------------------------------------

  /**
   * Get all pane IDs for a window from current state.
   */
  private getPaneIdsForWindow(windowId: string): string[] {
    const paneIds: string[] = [];
    for (const session of this.state.sessions.values()) {
      const win = session.windows.get(windowId);
      if (win) {
        paneIds.push(...win.panes.keys());
      }
    }
    return paneIds;
  }

  /**
   * Find any pane ID in a given window.
   */
  private findPaneInWindow(windowId: string): string | undefined {
    for (const session of this.state.sessions.values()) {
      const win = session.windows.get(windowId);
      if (win && win.paneOrder.length > 0) {
        return win.paneOrder[0];
      }
    }
    return undefined;
  }

  /**
   * Notify all state change subscribers.
   */
  private notifyStateChange(): void {
    for (const cb of this.stateChangeCallbacks) {
      try {
        cb(this.state);
      } catch {
        // Ignore subscriber errors
      }
    }
  }
}
