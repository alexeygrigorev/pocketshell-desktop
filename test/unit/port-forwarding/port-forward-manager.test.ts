import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { PassThrough, Duplex } from 'stream';
import type {
  ExecResult,
  ForwardOutParams,
  ShellOptions,
  SshConnection,
  SshShell,
} from '../../../src/ssh/connection/ssh-client';
import { PortForwardManager } from '../../../src/port-forwarding';

class FakeSshConnection implements SshConnection {
  connected = true;
  forwardOutCalls: ForwardOutParams[] = [];
  failForwardOut = false;

  async exec(_command: string, _timeout?: number): Promise<ExecResult> {
    throw new Error('not used');
  }

  async shell(_options?: ShellOptions): Promise<SshShell> {
    throw new Error('not used');
  }

  async sftp(): Promise<any> {
    throw new Error('not used');
  }

  async forwardOut(params: ForwardOutParams): Promise<Duplex> {
    this.forwardOutCalls.push(params);
    if (this.failForwardOut) {
      throw new Error('remote refused');
    }
    return new PassThrough();
  }

  disconnect(): void {
    this.connected = false;
  }
}

function listen(server: net.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function connectAndEcho(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      data += chunk;
      socket.end();
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

async function findFreePort(): Promise<number> {
  const probe = net.createServer();
  const freePort = await listen(probe);
  await close(probe);
  return freePort;
}

describe('PortForwardManager', () => {
  const managers: PortForwardManager[] = [];
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(managers.map((manager) => manager.dispose()));
    managers.length = 0;

    await Promise.all(
      servers.map((server) => (server.listening ? close(server) : Promise.resolve())),
    );
    servers.length = 0;
  });

  async function makeManagerAroundFreePort(connection: FakeSshConnection) {
    const freePort = await findFreePort();

    const manager = new PortForwardManager({
      connections: { getConnection: () => connection },
      skipPortsBelow: freePort,
      maxAutoPort: freePort + 4,
    });
    managers.push(manager);
    return manager;
  }

  it('allocates a local port and forwards local sockets over the existing SSH connection', async () => {
    const connection = new FakeSshConnection();
    const manager = await makeManagerAroundFreePort(connection);

    const handle = await manager.start({
      hostId: 42,
      remoteHost: '127.0.0.1',
      remotePort: 8080,
    });

    expect(handle.localPort).toBeGreaterThanOrEqual(1000);
    expect(manager.get(handle.id)?.state).toBe('listening');

    await expect(connectAndEcho(handle.localPort, 'ping')).resolves.toBe('ping');
    expect(connection.forwardOutCalls).toMatchObject([
      {
        dstHost: '127.0.0.1',
        dstPort: 8080,
      },
    ]);
  });

  it('skips externally occupied ports during auto-allocation', async () => {
    const blocker = net.createServer();
    servers.push(blocker);
    const blockedPort = await listen(blocker);

    const connection = new FakeSshConnection();
    const manager = new PortForwardManager({
      connections: { getConnection: () => connection },
      skipPortsBelow: blockedPort,
      maxAutoPort: blockedPort + 2,
    });
    managers.push(manager);

    const handle = await manager.start({
      hostId: 1,
      remoteHost: 'localhost',
      remotePort: 80,
    });

    expect(handle.localPort).toBeGreaterThan(blockedPort);
  });

  it('rejects an explicit local port already owned by another tunnel', async () => {
    const connection = new FakeSshConnection();
    const manager = await makeManagerAroundFreePort(connection);
    const first = await manager.start({
      hostId: 1,
      remoteHost: 'localhost',
      remotePort: 80,
    });

    await expect(
      manager.start({
        hostId: 1,
        localPort: first.localPort,
        remoteHost: 'localhost',
        remotePort: 81,
      }),
    ).rejects.toMatchObject({
      code: 'LOCAL_PORT_IN_USE',
    });
  });

  it('records channel errors without removing the listening tunnel', async () => {
    const connection = new FakeSshConnection();
    connection.failForwardOut = true;
    const manager = await makeManagerAroundFreePort(connection);
    const handle = await manager.start({
      hostId: 1,
      remoteHost: 'localhost',
      remotePort: 80,
    });

    await connectAndEcho(handle.localPort, 'ping').catch(() => '');

    const tunnel = manager.get(handle.id);
    expect(tunnel?.state).toBe('listening');
    expect(tunnel?.error).toMatchObject({ code: 'CHANNEL_FAILED' });
  });

  it('uses the provider current connection for sockets accepted after replacement', async () => {
    const firstConnection = new FakeSshConnection();
    const secondConnection = new FakeSshConnection();
    let currentConnection: FakeSshConnection | null = firstConnection;
    const freePort = await findFreePort();

    const replacementAwareManager = new PortForwardManager({
      connections: { getConnection: () => currentConnection },
      skipPortsBelow: freePort,
      maxAutoPort: freePort + 4,
    });
    managers.push(replacementAwareManager);

    const handle = await replacementAwareManager.start({
      hostId: 1,
      remoteHost: 'localhost',
      remotePort: 80,
    });

    currentConnection = secondConnection;

    await expect(connectAndEcho(handle.localPort, 'reconnected')).resolves.toBe('reconnected');
    expect(firstConnection.forwardOutCalls).toHaveLength(0);
    expect(secondConnection.forwardOutCalls).toHaveLength(1);
  });

  it('records connection loss for new sockets without using a stale connection', async () => {
    const firstConnection = new FakeSshConnection();
    let currentConnection: FakeSshConnection | null = firstConnection;
    const freePort = await findFreePort();
    const manager = new PortForwardManager({
      connections: { getConnection: () => currentConnection },
      skipPortsBelow: freePort,
      maxAutoPort: freePort + 4,
    });
    managers.push(manager);

    const handle = await manager.start({
      hostId: 1,
      remoteHost: 'localhost',
      remotePort: 80,
    });

    currentConnection = null;

    await connectAndEcho(handle.localPort, 'lost').catch(() => '');

    const tunnel = manager.get(handle.id);
    expect(firstConnection.forwardOutCalls).toHaveLength(0);
    expect(tunnel?.state).toBe('listening');
    expect(tunnel?.error).toMatchObject({ code: 'CONNECTION_UNAVAILABLE' });
  });

  it('rejects when no active connection is available from the provider', async () => {
    const manager = new PortForwardManager({
      connections: { getConnection: () => null },
      skipPortsBelow: 40100,
      maxAutoPort: 40100,
    });
    managers.push(manager);

    await expect(
      manager.start({
        hostId: 9,
        remoteHost: 'localhost',
        remotePort: 80,
      }),
    ).rejects.toMatchObject({
      code: 'CONNECTION_UNAVAILABLE',
    });
  });

  it('stops and disposes tunnels idempotently', async () => {
    const connection = new FakeSshConnection();
    const manager = await makeManagerAroundFreePort(connection);
    const handle = await manager.start({
      hostId: 1,
      remoteHost: 'localhost',
      remotePort: 80,
    });

    await handle.stop();
    await handle.stop();
    await manager.stop(handle.id);
    await manager.dispose();

    expect(manager.get(handle.id)).toBeUndefined();
    expect(manager.list()).toEqual([]);
  });

  it('throws a PortForwardError when auto-allocation has no available ports', async () => {
    const blocker = net.createServer();
    servers.push(blocker);
    const blockedPort = await listen(blocker);

    const connection = new FakeSshConnection();
    const manager = new PortForwardManager({
      connections: { getConnection: () => connection },
      skipPortsBelow: blockedPort,
      maxAutoPort: blockedPort,
    });
    managers.push(manager);

    await expect(
      manager.start({
        hostId: 1,
        remoteHost: 'localhost',
        remotePort: 80,
      }),
    ).rejects.toMatchObject({ code: 'NO_AVAILABLE_PORT' });
  });
});
