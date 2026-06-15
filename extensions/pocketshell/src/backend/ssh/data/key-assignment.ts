import type { Host } from './host-store';
import type { SshKey } from './key-store';

export interface HostKeyAssignmentPlan {
  hostId: number;
  hostName: string;
  previousKeyPath: string;
  nextKeyPath: string;
  changed: boolean;
}

export function createHostKeyAssignmentPlan(host: Host, key: Pick<SshKey, 'privateKeyPath'>): HostKeyAssignmentPlan {
  return {
    hostId: host.id,
    hostName: host.name || host.hostname,
    previousKeyPath: host.keyPath,
    nextKeyPath: key.privateKeyPath,
    changed: host.keyPath !== key.privateKeyPath,
  };
}

export function assignManagedKeyToHost(host: Host, key: Pick<SshKey, 'privateKeyPath'>): Host {
  return {
    ...host,
    keyPath: key.privateKeyPath,
  };
}
