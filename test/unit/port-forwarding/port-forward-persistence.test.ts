import { describe, expect, it } from 'vitest';
import * as net from 'net';
import { Duplex, PassThrough } from 'stream';
import {
  buildPortForwardRestorePlan,
  markSavedPortForwardStarted,
  markSavedPortForwardStopped,
  normalizeSavedPortForwardState,
  savedMappingToStartSpec,
  setSavedPortForwardRestore,
  upsertSavedPortForward,
  PortForwardManager,
  type ActivePortForward,
  type SavedPortForwardPanelMapping,
} from '../../../src/port-forwarding';
import type {
  ExecResult,
  ForwardOutParams,
  ShellOptions,
  SshConnection,
  SshShell,
} from '../../../src/ssh/connection/ssh-client';

class FakeSshConnection implements SshConnection {
  connected = true;

  async exec(_command: string, _timeout?: number): Promise<ExecResult> {
    throw new Error('not used');
  }

  async shell(_options?: ShellOptions): Promise<SshShell> {
    throw new Error('not used');
  }

  async sftp(): Promise<any> {
    throw new Error('not used');
  }

  async forwardOut(_params: ForwardOutParams): Promise<Duplex> {
    return new PassThrough();
  }

  disconnect(): void {
    this.connected = false;
  }
}

describe('port forwarding persistence', () => {
  it('normalizes persisted saved mappings per host with last local port and restore choice', () => {
    expect(normalizeSavedPortForwardState({
      id: 'web',
      hostId: 7,
      name: 'Web',
      localHost: '127.0.0.1',
      lastLocalPort: 43000,
      restoreOnReconnect: true,
      remoteHost: '127.0.0.1',
      remotePort: 3000,
    }, 7)).toMatchObject({
      id: 'web',
      hostId: 7,
      lastLocalPort: 43000,
      restoreOnReconnect: true,
    });

    expect(normalizeSavedPortForwardState({
      id: 'other',
      hostId: 8,
      remoteHost: '127.0.0.1',
      remotePort: 3000,
      restoreOnReconnect: true,
    }, 7)).toBeUndefined();
  });

  it('preserves remembered local ports and restore selection when updating a mapping', () => {
    const saved: SavedPortForwardPanelMapping[] = [
      mapping({ id: 'web', name: 'Old', lastLocalPort: 43000, restoreOnReconnect: true }),
    ];

    expect(upsertSavedPortForward(saved, mapping({ id: 'web', name: 'New' }))).toEqual([
      mapping({ id: 'web', name: 'New', lastLocalPort: 43000, restoreOnReconnect: true }),
    ]);
  });

  it('records user-selected active tunnels and excludes already-active restores', () => {
    const saved = [
      mapping({ id: 'web' }),
      mapping({ id: 'api', remotePort: 9000 }),
    ];
    const started = markSavedPortForwardStarted(saved, active({ id: 'web', localPort: 43000 }));

    expect(started[0]).toMatchObject({
      lastLocalPort: 43000,
      restoreOnReconnect: true,
    });
    expect(markSavedPortForwardStopped(started, 'web')[0].restoreOnReconnect).toBe(false);
    expect(setSavedPortForwardRestore(started, 'api', true)[1].restoreOnReconnect).toBe(true);

    expect(buildPortForwardRestorePlan(7, started, [
      active({ id: 'web', localPort: 43000 }),
    ])).toEqual({
      hostId: 7,
      mappings: [],
    });
    expect(buildPortForwardRestorePlan(7, started, [])).toEqual({
      hostId: 7,
      mappings: [started[0]],
    });
  });

  it('uses remembered local ports for restore specs and falls back to auto allocation after a conflict', async () => {
    const blocker = net.createServer();
    const blockedPort = await listen(blocker);
    const connection = new FakeSshConnection();
    const manager = new PortForwardManager({
      connections: { getConnection: () => connection },
      skipPortsBelow: blockedPort,
      maxAutoPort: blockedPort + 2,
    });
    const saved = mapping({ lastLocalPort: blockedPort });

    try {
      await expect(
        manager.start(savedMappingToStartSpec(saved, { preferLastLocalPort: true })),
      ).rejects.toMatchObject({ code: 'LOCAL_PORT_IN_USE' });

      const handle = await manager.start(savedMappingToStartSpec(saved));
      expect(handle.localPort).toBeGreaterThan(blockedPort);
    } finally {
      await manager.dispose();
      await close(blocker);
    }
  });
});

function mapping(patch: Partial<SavedPortForwardPanelMapping> = {}): SavedPortForwardPanelMapping {
  return {
    id: 'web',
    hostId: 7,
    name: 'Web',
    localHost: '127.0.0.1',
    remoteHost: '127.0.0.1',
    remotePort: 3000,
    ...patch,
  };
}

function active(patch: Partial<ActivePortForward> = {}): ActivePortForward {
  return {
    id: 'web',
    hostId: 7,
    localHost: '127.0.0.1',
    localPort: 43000,
    remoteHost: '127.0.0.1',
    remotePort: 3000,
    state: 'listening',
    createdAt: 1,
    startedAt: 2,
    activeChannels: 0,
    ...patch,
  };
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
