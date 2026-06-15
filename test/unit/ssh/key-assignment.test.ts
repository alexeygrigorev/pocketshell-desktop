import { describe, it, expect } from 'vitest';
import type { Host } from '../../../src/ssh/data/host-store';
import { assignManagedKeyToHost, createHostKeyAssignmentPlan } from '../../../src/ssh/data/key-assignment';

function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: 7,
    name: 'Prod',
    hostname: 'prod.example.com',
    port: 22,
    username: 'deploy',
    keyPath: '~/.ssh/id_rsa',
    maxAutoPort: 10000,
    skipPortsBelow: 1000,
    scanIntervalSec: 5,
    enabled: true,
    createdAt: 1,
    lastConnectedAt: null,
    tmuxInstalled: null,
    lastBootstrapAt: null,
    pocketshellInstalled: null,
    pocketshellLastDetectedAt: null,
    pocketshellCliVersion: null,
    pocketshellExpectedCliVersion: null,
    pocketshellVersionCompatible: null,
    pocketshellDaemonRunning: null,
    pocketshellDaemonEnabled: null,
    usageCommandOverride: null,
    claudeProfilesJson: null,
    codexProfilesJson: null,
    ...overrides,
  };
}

describe('key assignment helpers', () => {
  it('plans assignment from a managed key path', () => {
    const plan = createHostKeyAssignmentPlan(makeHost(), {
      privateKeyPath: '/tmp/pocketshell/keys/id_ed25519',
    });

    expect(plan).toEqual({
      hostId: 7,
      hostName: 'Prod',
      previousKeyPath: '~/.ssh/id_rsa',
      nextKeyPath: '/tmp/pocketshell/keys/id_ed25519',
      changed: true,
    });
  });

  it('updates only the host keyPath', () => {
    const host = makeHost();
    const updated = assignManagedKeyToHost(host, {
      privateKeyPath: '/tmp/pocketshell/keys/id_ed25519',
    });

    expect(updated).toEqual({
      ...host,
      keyPath: '/tmp/pocketshell/keys/id_ed25519',
    });
  });

  it('marks unchanged assignments', () => {
    const host = makeHost({ keyPath: '/tmp/key' });
    expect(createHostKeyAssignmentPlan(host, { privateKeyPath: '/tmp/key' }).changed).toBe(false);
  });
});
