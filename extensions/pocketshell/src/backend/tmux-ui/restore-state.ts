import type { TmuxTreeSnapshot } from './types';

export type TmuxSessionRestoreBehavior = 'ask' | 'restore-ready' | 'skip';

export interface TmuxRestoreTarget {
  hostId: number;
  hostLabel?: string;
  sessionName: string;
  sessionId?: string;
  windowId?: string;
  paneId?: string;
  cwd?: string;
  path?: string;
  updatedAt: number;
}

export interface RestoreDecisionInput {
  enabled: boolean;
  behavior: TmuxSessionRestoreBehavior;
  target: TmuxRestoreTarget | null;
  hostReady: boolean;
}

export interface TmuxRestoreSettings {
  restoreSessionOnStartup: boolean;
  sessionRestoreBehavior: TmuxSessionRestoreBehavior;
}

export type RestoreDecision =
  | { action: 'skip'; reason: 'disabled' | 'no-state' | 'user-skip' | 'host-not-ready' }
  | { action: 'ask'; target: TmuxRestoreTarget }
  | { action: 'restore'; target: TmuxRestoreTarget };

export function parseTmuxRestoreTarget(value: unknown): TmuxRestoreTarget | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.hostId) || (record.hostId as number) < 0) {
    return null;
  }
  if (typeof record.sessionName !== 'string' || record.sessionName.trim().length === 0) {
    return null;
  }

  return {
    hostId: record.hostId as number,
    hostLabel: optionalString(record.hostLabel),
    sessionName: record.sessionName,
    sessionId: optionalString(record.sessionId),
    windowId: optionalString(record.windowId),
    paneId: optionalString(record.paneId),
    cwd: optionalString(record.cwd),
    path: optionalString(record.path),
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : 0,
  };
}

export function serializeTmuxRestoreTarget(target: TmuxRestoreTarget): Record<string, unknown> {
  return {
    hostId: target.hostId,
    hostLabel: target.hostLabel,
    sessionName: target.sessionName,
    sessionId: target.sessionId,
    windowId: target.windowId,
    paneId: target.paneId,
    cwd: target.cwd,
    path: target.path,
    updatedAt: target.updatedAt,
  };
}

export function decideTmuxStartupRestore(input: RestoreDecisionInput): RestoreDecision {
  if (!input.enabled) {
    return { action: 'skip', reason: 'disabled' };
  }
  if (!input.target) {
    return { action: 'skip', reason: 'no-state' };
  }
  if (input.behavior === 'skip') {
    return { action: 'skip', reason: 'user-skip' };
  }
  if (input.behavior === 'restore-ready' && !input.hostReady) {
    return { action: 'skip', reason: 'host-not-ready' };
  }
  if (input.behavior === 'ask') {
    return { action: 'ask', target: input.target };
  }
  return { action: 'restore', target: input.target };
}

export function readTmuxRestoreSettings(settings: Record<string, unknown> | null | undefined): TmuxRestoreSettings {
  const behavior = settings?.sessionRestoreBehavior;
  return {
    restoreSessionOnStartup: typeof settings?.restoreSessionOnStartup === 'boolean'
      ? settings.restoreSessionOnStartup
      : true,
    sessionRestoreBehavior: behavior === 'restore-ready' || behavior === 'skip' ? behavior : 'ask',
  };
}

export function targetFromSnapshot(
  base: Pick<TmuxRestoreTarget, 'hostId' | 'hostLabel' | 'sessionName' | 'path'>,
  snapshot: TmuxTreeSnapshot,
  now: number,
): TmuxRestoreTarget {
  const session = snapshot.sessions.find((candidate) => candidate.isActive)
    ?? snapshot.sessions.find((candidate) => candidate.name === base.sessionName)
    ?? snapshot.sessions[0];
  const window = session?.windows.find((candidate) => candidate.isActive) ?? session?.windows[0];
  const pane = window?.panes.find((candidate) => candidate.isActive) ?? window?.panes[0];

  return {
    ...base,
    sessionName: session?.name ?? base.sessionName,
    sessionId: session?.id,
    windowId: window?.id,
    paneId: pane?.id,
    cwd: pane?.cwd,
    updatedAt: now,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
