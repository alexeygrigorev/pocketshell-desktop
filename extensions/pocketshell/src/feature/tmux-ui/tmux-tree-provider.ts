import * as vscode from 'vscode';
import { getTmuxTreeChildren, type TmuxTreeNode } from '../../backend/tmux-ui/tree-model';
import type { TmuxPaneInfo, TmuxSessionInfo, TmuxWindowInfo } from '../../backend/tmux-ui/types';
import type { TmuxSessionRegistry } from './tmux-session-registry';

export class TmuxTreeProvider implements vscode.TreeDataProvider<TmuxTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TmuxTreeNode | undefined>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly registry: TmuxSessionRegistry) {
    this.registry.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getChildren(element?: TmuxTreeNode): TmuxTreeNode[] {
    return getTmuxTreeChildren(this.registry.entries(), element);
  }

  getTreeItem(element: TmuxTreeNode): vscode.TreeItem {
    if (element.kind === 'root') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = element.entryId;
      item.description = element.description;
      item.contextValue = 'tmuxUiRoot';
      item.iconPath = new vscode.ThemeIcon('terminal-tmux');
      return item;
    }

    if (element.kind === 'session') {
      return createSessionItem(element.entryId, element.session);
    }

    if (element.kind === 'window') {
      return createWindowItem(element.entryId, element.window);
    }

    return createPaneItem(element.entryId, element.pane);
  }
}

function createSessionItem(entryId: string, session: TmuxSessionInfo): vscode.TreeItem {
  const item = new vscode.TreeItem(session.name, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `${entryId}:session:${session.id}`;
  item.description = session.isActive ? `${session.id} active` : session.id;
  item.contextValue = 'tmuxUiSession';
  item.iconPath = new vscode.ThemeIcon(session.isActive ? 'vm-active' : 'server-process');
  item.tooltip = `${session.name} (${session.id})`;
  return item;
}
function createWindowItem(entryId: string, window: TmuxWindowInfo): vscode.TreeItem {
  const item = new vscode.TreeItem(window.name, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `${entryId}:window:${window.id}`;
  item.description = window.isActive ? `${window.id} active` : `${window.id} ${window.panes.length} pane(s)`;
  item.contextValue = 'tmuxUiWindow';
  item.iconPath = new vscode.ThemeIcon(window.isActive ? 'window' : 'window');
  item.tooltip = `${window.name} (${window.id})`;
  return item;
}

function createPaneItem(entryId: string, pane: TmuxPaneInfo): vscode.TreeItem {
  const item = new vscode.TreeItem(pane.id, vscode.TreeItemCollapsibleState.None);
  item.id = `${entryId}:pane:${pane.id}`;
  item.description = pane.isActive ? 'active' : `${pane.width}x${pane.height}`;
  item.contextValue = 'tmuxUiPane';
  item.iconPath = new vscode.ThemeIcon(pane.isActive ? 'play' : 'terminal');
  item.tooltip = [pane.title, pane.cwd, `${pane.width}x${pane.height}`, pane.mode]
    .filter((part) => part && part.length > 0)
    .join('\n');
  item.command = {
    command: 'pocketshell.tmux-ui.selectPane',
    title: 'Select Pane',
    arguments: [{ kind: 'pane', entryId, pane }],
  };
  return item;
}
