import type { TmuxTreeSnapshot, TmuxSessionInfo, TmuxWindowInfo, TmuxPaneInfo } from './types';

export interface TmuxTreeSessionEntry {
  id: string;
  label: string;
  hostId: number;
  sessionName: string;
  snapshot: TmuxTreeSnapshot | undefined;
}

export type TmuxTreeNode =
  | TmuxTreeRootNode
  | TmuxTreeSessionNode
  | TmuxTreeWindowNode
  | TmuxTreePaneNode;

export interface TmuxTreeRootNode {
  kind: 'root';
  entryId: string;
  hostId: number;
  label: string;
  description: string;
  sessionName: string;
}

export interface TmuxTreeSessionNode {
  kind: 'session';
  entryId: string;
  hostId: number;
  session: TmuxSessionInfo;
}

export interface TmuxTreeWindowNode {
  kind: 'window';
  entryId: string;
  hostId: number;
  session: TmuxSessionInfo;
  window: TmuxWindowInfo;
}

export interface TmuxTreePaneNode {
  kind: 'pane';
  entryId: string;
  hostId: number;
  session: TmuxSessionInfo;
  window: TmuxWindowInfo;
  pane: TmuxPaneInfo;
}

export type TmuxTreeKillTarget =
  | { kind: 'session'; id: string; label: string }
  | { kind: 'window'; id: string; label: string }
  | { kind: 'pane'; id: string; label: string };

export function buildTmuxTreeRoots(entries: readonly TmuxTreeSessionEntry[]): TmuxTreeRootNode[] {
  return entries.map((entry) => ({
    kind: 'root',
    entryId: entry.id,
    hostId: entry.hostId,
    label: entry.label,
    description: entry.snapshot?.activePaneId ? `active ${entry.snapshot.activePaneId}` : entry.sessionName,
    sessionName: entry.sessionName,
  }));
}

export function getTmuxTreeChildren(
  entries: readonly TmuxTreeSessionEntry[],
  node?: TmuxTreeNode,
): TmuxTreeNode[] {
  if (!node) {
    return buildTmuxTreeRoots(entries);
  }

  const entry = entries.find((candidate) => candidate.id === node.entryId);
  if (!entry?.snapshot) {
    return [];
  }

  if (node.kind === 'root') {
    return entry.snapshot.sessions.map((session) => ({
      kind: 'session',
      entryId: entry.id,
      hostId: entry.hostId,
      session,
    }));
  }

  if (node.kind === 'session') {
    return node.session.windows.map((window) => ({
      kind: 'window',
      entryId: entry.id,
      hostId: entry.hostId,
      session: node.session,
      window,
    }));
  }

  if (node.kind === 'window') {
    return node.window.panes.map((pane) => ({
      kind: 'pane',
      entryId: entry.id,
      hostId: entry.hostId,
      session: node.session,
      window: node.window,
      pane,
    }));
  }

  return [];
}

export function getKillTargetFromTmuxTreeNode(node: TmuxTreeNode): TmuxTreeKillTarget | undefined {
  if (node.kind === 'session') {
    return { kind: 'session', id: node.session.id, label: node.session.name };
  }
  if (node.kind === 'window') {
    return { kind: 'window', id: node.window.id, label: node.window.name };
  }
  if (node.kind === 'pane') {
    return { kind: 'pane', id: node.pane.id, label: node.pane.id };
  }
  return undefined;
}
