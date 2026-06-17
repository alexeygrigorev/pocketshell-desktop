/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { SessionTerminalRegistry } from './session-terminal-registry';
import type { SessionTerminalEntry } from '../../backend/terminal/session-terminal-map';

/**
 * Tree data provider for the "Sessions" view in the left panel.
 *
 * Lists the current PocketShell/SSH sessions: one row per host that has an
 * open terminal tab. Selecting a row reveals and focuses that session's
 * terminal editor tab (so the user can switch between sessions from the
 * sidebar, just like switching editor file tabs).
 *
 * This is intentionally a separate view from "SSH Hosts": the Hosts view lists
 * every configured host (the connection targets), whereas the Sessions view
 * lists the live sessions (connected hosts with an open terminal) — a different
 * concept and a different lifecycle.
 */
export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTerminalEntry<vscode.Terminal>> {
  private readonly changeEmitter = new vscode.EventEmitter<SessionTerminalEntry<vscode.Terminal> | undefined | null>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly registry: SessionTerminalRegistry) {
    this.registry.onDidChange(() => this.refresh());
  }

  /** Trigger a refresh of the sessions view. */
  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getChildren(): SessionTerminalEntry<vscode.Terminal>[] {
    // Stable order by host id so the list does not jump around on refresh.
    return this.registry.list().sort((a, b) => a.hostId - b.hostId);
  }

  getTreeItem(entry: SessionTerminalEntry<vscode.Terminal>): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.hostLabel, vscode.TreeItemCollapsibleState.None);
    item.id = `session:${entry.hostId}`;
    item.description = entry.sessionName;
    item.tooltip = vscode.l10n.t(
      'Session: {0}\ntmux: {1}\nClick to focus this session\'s terminal tab.',
      entry.hostLabel,
      entry.sessionName,
    );
    item.iconPath = new vscode.ThemeIcon('terminal-tmux');
    item.contextValue = 'pocketshellSession';
    // Clicking a session focuses its full-width editor terminal tab.
    item.command = {
      command: 'pocketshell.session.focusTerminal',
      title: 'Focus Session Terminal',
      arguments: [entry.hostId],
    };
    return item;
  }
}
