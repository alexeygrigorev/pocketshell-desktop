import type { ActivePortForward, SavedPortForwardSpec } from './port-forward-manager';
import {
  normalizeSavedPortForward,
  type SavedPortForwardPanelMapping,
} from './port-forward-panel-model';

export interface PortForwardRestorePlan {
  hostId: number;
  mappings: SavedPortForwardPanelMapping[];
}

export function normalizeSavedPortForwardState(
  input: unknown,
  hostId: number,
): SavedPortForwardPanelMapping | undefined {
  const normalized = normalizeSavedPortForward(input, hostId);
  if (!normalized || !isRecord(input)) {
    return normalized;
  }
  return {
    ...normalized,
    lastLocalPort: portField(input, 'lastLocalPort'),
    restoreOnReconnect: input.restoreOnReconnect === true,
  };
}

export function upsertSavedPortForward(
  saved: readonly SavedPortForwardPanelMapping[],
  mapping: SavedPortForwardPanelMapping,
): SavedPortForwardPanelMapping[] {
  const next = saved.slice();
  const existingIndex = next.findIndex((item) => item.id === mapping.id);
  if (existingIndex >= 0) {
    next[existingIndex] = {
      ...next[existingIndex],
      ...mapping,
      lastLocalPort: mapping.lastLocalPort ?? next[existingIndex].lastLocalPort,
      restoreOnReconnect: mapping.restoreOnReconnect ?? next[existingIndex].restoreOnReconnect,
    };
    return next;
  }
  next.push(mapping);
  return next;
}

export function deleteSavedPortForward(
  saved: readonly SavedPortForwardPanelMapping[],
  savedId: string,
): SavedPortForwardPanelMapping[] {
  return saved.filter((mapping) => mapping.id !== savedId);
}

export function markSavedPortForwardStarted(
  saved: readonly SavedPortForwardPanelMapping[],
  forward: Pick<ActivePortForward, 'id' | 'localPort' | 'state'>,
): SavedPortForwardPanelMapping[] {
  if (forward.state !== 'listening' || forward.localPort <= 0) {
    return saved.slice();
  }
  return saved.map((mapping) => mapping.id === forward.id
    ? {
        ...mapping,
        lastLocalPort: forward.localPort,
        restoreOnReconnect: true,
      }
    : mapping);
}

export function markSavedPortForwardStopped(
  saved: readonly SavedPortForwardPanelMapping[],
  savedId: string,
): SavedPortForwardPanelMapping[] {
  return saved.map((mapping) => mapping.id === savedId
    ? {
        ...mapping,
        restoreOnReconnect: false,
      }
    : mapping);
}

export function setSavedPortForwardRestore(
  saved: readonly SavedPortForwardPanelMapping[],
  savedId: string,
  restoreOnReconnect: boolean,
): SavedPortForwardPanelMapping[] {
  return saved.map((mapping) => mapping.id === savedId
    ? {
        ...mapping,
        restoreOnReconnect,
      }
    : mapping);
}

export function buildPortForwardRestorePlan(
  hostId: number,
  saved: readonly SavedPortForwardPanelMapping[],
  active: readonly ActivePortForward[] = [],
): PortForwardRestorePlan {
  const activeIds = new Set(
    active
      .filter((forward) => forward.hostId === hostId && forward.state !== 'stopped' && forward.state !== 'error')
      .map((forward) => forward.id),
  );
  return {
    hostId,
    mappings: saved.filter((mapping) =>
      mapping.hostId === hostId &&
      mapping.restoreOnReconnect === true &&
      !activeIds.has(mapping.id),
    ),
  };
}

export function savedMappingToStartSpec(
  mapping: SavedPortForwardPanelMapping,
  options: { preferLastLocalPort?: boolean } = {},
): SavedPortForwardSpec {
  return {
    id: mapping.id,
    hostId: mapping.hostId,
    name: mapping.name,
    localHost: mapping.localHost,
    localPort: options.preferLastLocalPort
      ? mapping.localPort ?? mapping.lastLocalPort
      : mapping.localPort,
    remoteHost: mapping.remoteHost,
    remotePort: mapping.remotePort,
  };
}

function portField(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 65535) {
    return raw;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
