/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildSnapshot } from '../../backend/tmux-ui/snapshot-builder';
import type { SessionTerminalEntry } from '../../backend/terminal/session-terminal-map';
import type { SessionTerminalRegistry } from './session-terminal-registry';

/**
 * Canonical "Sessions" sidebar tree — the merged, per-session view (#103).
 *
 * Mirrors the PocketShell Android app's FolderList: the host's tmux SESSIONS
 * (not just one row per host) are listed and grouped. The app groups sessions by
 * working directory (folder); on desktop the stable, always-correct rendering
 * groups by HOST (one collapsible folder per connected host showing its session
 * count), because the registry layer does not have reliable watched-folder /
 * per-session cwd data until the tmux control channel reports it. Sessions with
 * a known cwd (from the pty's live snapshot) are annotated with that path in
 * their description. Clicking a session focuses its full-width editor terminal.
 *
 * This consolidates the former two sidebar views (`pocketshell.sessions` at
 * 1/host and `pocketshell.tmuxSessions` at N/host) into ONE tree driven by the
 * {@link SessionTerminalRegistry}, which after #103 holds one entry per
 * (host, tmux session).
 *
 * The view is a two-level tree:
 *   host (collapsible, session-count badge) → session (click → focus terminal).
 */
export class CanonicalSessionTreeProvider implements vscode.TreeDataProvider<CanonicalSessionNode> {
  private readonly changeEmitter = new vscode.EventEmitter<CanonicalSessionNode | undefined | null>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly registry: SessionTerminalRegistry) {
    this.registry.onDidChange(() => this.refresh());
  }

  /** Trigger a refresh of the sessions view. */
  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getChildren(element?: CanonicalSessionNode): CanonicalSessionNode[] {
    if (element === undefined) {
      return buildHostNodes(this.registry);
    }
    if (element.kind === 'host') {
      return element.sessions.map((entry) => toSessionNode(entry, this.registry));
    }
    return [];
  }

  getTreeItem(element: CanonicalSessionNode): vscode.TreeItem {
    if (element.kind === 'host') {
      const item = new vscode.TreeItem(element.hostLabel, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `host:${element.hostId}`;
      item.description = vscode.l10n.t('{0} session(s)', element.sessions.length);
      item.tooltip = vscode.l10n.t(
        '{0}\n{1} open tmux session(s).\nClick a session to focus its terminal tab.',
        element.hostLabel,
        element.sessions.length,
      );
      item.contextValue = 'pocketshellSessionHost';
      item.iconPath = new vscode.ThemeIcon('server');
      return item;
    }

    const entry = element.entry;
    const cwd = element.cwd;
    const item = new vscode.TreeItem(entry.sessionName, vscode.TreeItemCollapsibleState.None);
    item.id = `session:${entry.hostId}:${entry.sessionName}`;
    item.description = cwd ?? entry.hostLabel;
    item.tooltip = vscode.l10n.t(
      'Session: {0}\nHost: {1}\ntmux: {2}{3}\nClick to focus this session\'s terminal tab.',
      entry.sessionName,
      entry.hostLabel,
      entry.sessionName,
      cwd ? `\nFolder: ${cwd}` : '',
    );
    item.iconPath = new vscode.ThemeIcon('terminal-tmux');
    item.contextValue = 'pocketshellSession';
    // Clicking a session focuses its full-width editor terminal tab.
    item.command = {
      command: 'pocketshell.session.focusTerminal',
      title: 'Focus Session Terminal',
      arguments: [entry.hostId, entry.sessionName],
    };
    return item;
  }
}

/**
 * A node in the canonical session tree: a host group or a session leaf.
 *
 * The session leaf carries the (hostId, sessionName, hostLabel) identity both
 * nested under `entry` (consumed by the surface focus/close commands) AND as
 * top-level passthrough fields. The top-level fields let the shared resolvers
 * in {@link resolveHostId} (host-picking.ts) and the tmux-ui/conversation/
 * prompt-composer commands resolve the session directly from the tree node
 * when it is passed as the command `element` (e.g. via a right-click menu) —
 * without those commands needing to know the canonical-tree node shape.
 */
export type CanonicalSessionNode =
  | {
      kind: 'host';
      hostId: number;
      hostLabel: string;
      sessions: SessionTerminalEntry<vscode.Terminal>[];
    }
  | {
      kind: 'session';
      entry: SessionTerminalEntry<vscode.Terminal>;
      /** Stable SSH host id this session belongs to (mirrors entry.hostId). */
      hostId: number;
      /** tmux session name backing this terminal (mirrors entry.sessionName). */
      sessionName: string;
      /** Display label for the host (mirrors entry.hostLabel). */
      hostLabel: string;
      /** Working directory if known from the pty's live snapshot, else undefined. */
      cwd?: string;
    };

function toSessionNode(
  entry: SessionTerminalEntry<vscode.Terminal>,
  registry: SessionTerminalRegistry,
): CanonicalSessionNode {
  return {
    kind: 'session',
    entry,
    hostId: entry.hostId,
    sessionName: entry.sessionName,
    hostLabel: entry.hostLabel,
    cwd: cwdForEntry(registry, entry),
  };
}

/**
 * Build one collapsible host node per connected host, each carrying its session
 * leaves. Hosts are ordered by hostId for stability; sessions within a host are
 * ordered alphabetically by tmux session name.
 */
function buildHostNodes(registry: SessionTerminalRegistry): CanonicalSessionNode[] {
  const entries = registry.list();
  const byHost = new Map<number, SessionTerminalEntry<vscode.Terminal>[]>();
  const labelByHost = new Map<number, string>();

  for (const entry of entries) {
    const list = byHost.get(entry.hostId);
    if (list) {
      list.push(entry);
    } else {
      byHost.set(entry.hostId, [entry]);
      labelByHost.set(entry.hostId, entry.hostLabel);
    }
  }

  const hostIds = [...byHost.keys()].sort((a, b) => a - b);
  return hostIds.map((hostId) => {
    const sessions = (byHost.get(hostId) ?? []).slice().sort((a, b) => a.sessionName.localeCompare(b.sessionName));
    return {
      kind: 'host' as const,
      hostId,
      hostLabel: labelByHost.get(hostId) ?? `host-${hostId}`,
      sessions,
    };
  });
}

/**
 * Best-effort: read the active pane's cwd from the session pty's live tmux
 * snapshot. Returns undefined when the pty is not yet connected or the snapshot
 * has no cwd. Used only for the description/tooltip annotation — grouping is by
 * host, so an unknown cwd never hides a session.
 */
function cwdForEntry(
  registry: SessionTerminalRegistry,
  entry: SessionTerminalEntry<vscode.Terminal>,
): string | undefined {
  const pty = registry.getPty(entry.hostId, entry.sessionName);
  if (!pty) {
    return undefined;
  }
  try {
    const state = pty.getState();
    if (!state) {
      return undefined;
    }
    const snapshot = buildSnapshot(state, new Map());
    for (const session of snapshot.sessions) {
      for (const window of session.windows) {
        const activePane = window.panes.find((pane) => pane.isActive) ?? window.panes[0];
        if (activePane?.cwd) {
          return activePane.cwd;
        }
      }
    }
  } catch {
    // State shape mismatch — treat as unknown cwd.
  }
  return undefined;
}
