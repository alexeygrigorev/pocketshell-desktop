/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SessionTerminalMap, type SessionTerminalEntry } from '../../backend/terminal/session-terminal-map';
import type { TmuxSessionPseudoterminal } from '../tmux-ui/tmux-session-terminal';

/**
 * vscode-aware registry of session terminals: ONE full-width editor terminal
 * tab per SSH session (host), each backed by a tmux -CC session on the remote.
 *
 * Wraps the pure {@link SessionTerminalMap} (which enforces the one-tab-per-host
 * invariant and is unit-tested independently) with:
 *   - a vscode.Terminal disposer that calls `terminal.dispose()`,
 *   - a `vscode.EventEmitter` so the left-panel session list can refresh, and
 *   - a record of the per-session {@link TmuxSessionPseudoterminal} so command
 *     palettes (send-text, split, etc.) can still address the active terminal.
 *
 * "Session" here means an SSH connection to a host. Selecting/connecting a
 * host is how the user gets that host's single terminal tab.
 */
export class SessionTerminalRegistry implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly terminals = new SessionTerminalMap<vscode.Terminal>((terminal) => {
    // Disposing a vscode.Terminal that the user already closed is a no-op;
    // disposing one we are replacing closes its editor tab.
    try {
      terminal.dispose();
    } catch {
      // Ignore — terminal may already be disposed.
    }
  });
  /** hostId -> the tmux -CC pseudoterminal backing the session terminal. */
  private readonly ptys = new Map<number, TmuxSessionPseudoterminal>();
  /** Disposables for per-terminal close listeners (cleared on remove). */
  private readonly closeSubs = new Map<number, vscode.Disposable>();

  /** Fires whenever a session terminal is added, replaced, or removed. */
  readonly onDidChange = this.changeEmitter.event;

  /**
   * Register a session terminal for `hostId`, replacing any pre-existing tab
   * for that host (so reconnecting never stacks duplicate terminals).
   *
   * @param hostId      Stable SSH host id (the session key).
   * @param hostLabel   Display label for the host.
   * @param sessionName tmux session name backing the terminal.
   * @param terminal    The vscode.Terminal opened in the editor area.
   * @param pty         The tmux -CC pseudoterminal driving `terminal`.
   */
  register(
    hostId: number,
    hostLabel: string,
    sessionName: string,
    terminal: vscode.Terminal,
    pty: TmuxSessionPseudoterminal,
  ): SessionTerminalEntry<vscode.Terminal> {
    // Drop any previous entry for this host (closes its tab) and its listeners.
    this.removeInternal(hostId);

    this.ptys.set(hostId, pty);
    // When the user closes the editor terminal tab, drop the entry without
    // trying to dispose the (already-gone) terminal.
    const closeSub = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        this.removeInternal(hostId);
        this.changeEmitter.fire();
      }
    });
    this.closeSubs.set(hostId, closeSub);

    const entry = this.terminals.register({ hostId, hostLabel, terminal, sessionName, createdAt: Date.now() });
    this.changeEmitter.fire();
    return entry;
  }

  /** Get the session terminal entry for a host, or undefined. */
  get(hostId: number): SessionTerminalEntry<vscode.Terminal> | undefined {
    return this.terminals.get(hostId);
  }

  /** Get the tmux -CC pseudoterminal backing a host's session, or undefined. */
  getPty(hostId: number): TmuxSessionPseudoterminal | undefined {
    return this.ptys.get(hostId);
  }

  /** Whether a session terminal is currently registered for a host. */
  has(hostId: number): boolean {
    return this.terminals.has(hostId);
  }

  /** Snapshot of all session terminal entries (for the left-panel list). */
  list(): SessionTerminalEntry<vscode.Terminal>[] {
    return this.terminals.list();
  }

  /** Remove and dispose a host's session terminal. Returns true if removed. */
  remove(hostId: number): boolean {
    const removed = this.removeInternal(hostId);
    if (removed) {
      this.changeEmitter.fire();
    }
    return removed;
  }

  dispose(): void {
    for (const sub of this.closeSubs.values()) {
      sub.dispose();
    }
    this.closeSubs.clear();
    this.ptys.clear();
    this.terminals.clear();
    this.changeEmitter.dispose();
  }

  private removeInternal(hostId: number): boolean {
    const sub = this.closeSubs.get(hostId);
    if (sub) {
      sub.dispose();
      this.closeSubs.delete(hostId);
    }
    this.ptys.delete(hostId);
    return this.terminals.delete(hostId);
  }
}
