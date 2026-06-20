/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SessionTerminalMap, sessionTerminalKey, type SessionTerminalEntry } from '../../backend/terminal/session-terminal-map';
import type { TmuxSessionPseudoterminal } from '../tmux-ui/tmux-session-terminal';

/**
 * vscode-aware registry of session terminals: ONE full-width editor terminal
 * tab per (host, tmux session), each backed by a tmux -CC session on the remote.
 *
 * Parity model (#103): a host is ONE SSH connection (warm lease, reused via
 * ConnectionManager.getOrConnect) carrying N tmux sessions. Each (host, session)
 * pair gets its own editor tab. Connecting to a host with an already-open
 * default session focuses it; opening an additional session on an already-
 * connected host opens a new tab over the same SSH connection.
 *
 * Wraps the pure {@link SessionTerminalMap} (which enforces the
 * one-tab-per-(host,session) invariant and is unit-tested independently) with:
 *   - a vscode.Terminal disposer that calls `terminal.dispose()`,
 *   - a `vscode.EventEmitter` so the left-panel session list can refresh, and
 *   - a record of the per-session {@link TmuxSessionPseudoterminal} so command
 *     palettes (send-text, split, etc.) can still address the active terminal.
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
  /** composite key -> the tmux -CC pseudoterminal backing the session terminal. */
  private readonly ptys = new Map<string, TmuxSessionPseudoterminal>();
  /** Disposables for per-terminal close listeners (cleared on remove). */
  private readonly closeSubs = new Map<string, vscode.Disposable>();

  /** Fires whenever a session terminal is added, replaced, or removed. */
  readonly onDidChange = this.changeEmitter.event;

  /**
   * Register a session terminal for a (host, tmux session), replacing any
   * pre-existing tab for that exact (host, session) pair (so reconnecting the
   * same session never stacks duplicate terminals). A different sessionName on
   * the same host adds a new entry (multi-session per host).
   *
   * @param hostId      Stable SSH host id.
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
    const key = sessionTerminalKey(hostId, sessionName);
    // Drop any previous entry for this exact (host, session) (closes its tab)
    // and its listeners. Other sessions on the same host are left intact.
    this.removeInternal(hostId, sessionName);

    this.ptys.set(key, pty);
    // When the user closes the editor terminal tab, drop the entry without
    // trying to dispose the (already-gone) terminal.
    const closeSub = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        this.removeInternal(hostId, sessionName);
        this.changeEmitter.fire();
      }
    });
    this.closeSubs.set(key, closeSub);

    const entry = this.terminals.register({ hostId, hostLabel, terminal, sessionName, createdAt: Date.now() });
    this.changeEmitter.fire();
    return entry;
  }

  /**
   * Get the session terminal entry for a (host, session), or undefined.
   * Without `sessionName`, returns the host's first entry (single-session callers).
   */
  get(hostId: number, sessionName?: string): SessionTerminalEntry<vscode.Terminal> | undefined {
    return this.terminals.get(hostId, sessionName);
  }

  /**
   * Get the tmux -CC pseudoterminal backing a (host, session), or undefined.
   * Without `sessionName`, returns the host's first pty.
   */
  getPty(hostId: number, sessionName?: string): TmuxSessionPseudoterminal | undefined {
    const key = sessionName !== undefined ? sessionTerminalKey(hostId, sessionName) : undefined;
    if (key) {
      return this.ptys.get(key);
    }
    // Fall back to the host's first pty (insertion order).
    const entry = this.terminals.get(hostId);
    return entry ? this.ptys.get(sessionTerminalKey(entry.hostId, entry.sessionName)) : undefined;
  }

  /** Whether a session terminal is currently registered (optionally for a specific session). */
  has(hostId: number, sessionName?: string): boolean {
    return this.terminals.has(hostId, sessionName);
  }

  /** Snapshot of all session terminal entries (for the left-panel list). */
  list(): SessionTerminalEntry<vscode.Terminal>[] {
    return this.terminals.list();
  }

  /** Snapshot of all session terminal entries for one host. */
  listForHost(hostId: number): SessionTerminalEntry<vscode.Terminal>[] {
    return this.terminals.listForHost(hostId);
  }

  /**
   * Remove and dispose a (host, session)'s terminal. Returns true if removed.
   * Without `sessionName`, removes the host's first entry.
   */
  remove(hostId: number, sessionName?: string): boolean {
    const target = sessionName !== undefined ? sessionName : this.terminals.get(hostId)?.sessionName;
    if (!target) {
      return false;
    }
    const removed = this.removeInternal(hostId, target);
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

  private removeInternal(hostId: number, sessionName: string): boolean {
    const key = sessionTerminalKey(hostId, sessionName);
    const sub = this.closeSubs.get(key);
    if (sub) {
      sub.dispose();
      this.closeSubs.delete(key);
    }
    this.ptys.delete(key);
    return this.terminals.delete(hostId, sessionName);
  }
}
