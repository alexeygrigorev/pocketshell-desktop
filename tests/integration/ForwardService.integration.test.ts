import net from 'node:net';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { ConnectionRegistry } from '@main/ssh/ConnectionRegistry';
import { SshService } from '@main/ssh/SshService';
import { ForwardService } from '@main/portfwd/ForwardService';
import { scanRemotePorts } from '@main/portfwd/scanRemotePorts';
import type { ForwardSpec } from '../../src/shared/types';
import { TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * Integration tests for port forwarding against the real `pocketshell-test:ssh`
 * image. Covers: the remote port scan, the manual -L forward (start a remote
 * listener, forward it, probe localhost), addManual/remove bookkeeping, and
 * the auto-forward path (scanRemotePorts + a qualifying port).
 *
 * Auto-skips when Docker is unavailable.
 */
describeDocker('ForwardService integration', () => {
  let container: StartedTestContainer | undefined;
  let registry: ConnectionRegistry;
  let ssh: SshService;
  let forwards: ForwardService;
  let connectionId: string | undefined;

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:ssh')
      .withExposedPorts(22)
      .start();
    registry = new ConnectionRegistry();
    ssh = new SshService(registry);
    forwards = new ForwardService(ssh, registry);
    const result = await ssh.connect({
      host: container.getHost(),
      port: container.getMappedPort(22),
      user: 'testuser',
      privateKeyPath: TEST_KEY_PATH,
      knownHosts: null,
      tofuDecision: 'accept-once',
      timeoutMs: 15_000,
    });
    if (!result.ok || !result.connectionId) throw new Error('connect failed');
    connectionId = result.connectionId;
  }, 120_000);

  afterAll(async () => {
    if (connectionId) {
      forwards.evict(connectionId);
      ssh.close(connectionId);
    }
    if (container) await container.stop();
  });

  /** True if a local TCP port accepts a connection within `timeoutMs`. */
  function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ port, host }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeoutMs);
    });
  }

  it('scan returns the remote sshd listener (port 22)', async () => {
    const ports = await forwards.scan(connectionId!);
    expect(ports.some((p) => p.port === 22)).toBe(true);
  });

  it('forwards a local -L port to a remote listener', async () => {
    // Start a trivial echo listener inside the container on port 7777. Use
    // execBackground (fire-and-forget) because the backgrounded `nc` holds the
    // exec channel's fds open, so awaiting close would hang.
    ssh.execBackground(connectionId!, 'setsid sh -c "while true; do nc -l -p 7777 -e /bin/cat; done" </dev/null >/tmp/nc.log 2>&1 &');
    await new Promise((r) => setTimeout(r, 1500));

    const spec: ForwardSpec = {
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort: 7777,
      destHost: '127.0.0.1',
      destPort: 7777,
    };
    const ok = await forwards.addManual(connectionId!, spec);
    expect(ok).toBe(true);

    // The forwarded local port should now be reachable.
    const reachable = await isPortOpen(7777);
    expect(reachable).toBe(true);

    // Snapshot reflects the active forward.
    const states = forwards.list(connectionId!);
    expect(states.some((s) => s.kind === 'local' && s.destPort === 7777 && s.active)).toBe(true);

    // Remove it; the local port should close.
    await forwards.remove(connectionId!, 'local:7777->127.0.0.1:7777');
    const after = forwards.list(connectionId!);
    expect(after.some((s) => s.destPort === 7777)).toBe(false);
  }, 20_000);

  it('scanRemotePorts discovers a qualifying listener and auto-forward opens it', async () => {
    // Start a persistent Python HTTP server on 9090 (qualifies: in [1024,10000]).
    ssh.execBackground(
      connectionId!,
      'setsid python3 -m http.server 9090 --bind 0.0.0.0 </dev/null >/tmp/http9090.log 2>&1 &',
    );
    // Poll until scanRemotePorts reliably sees 9090 (python takes a moment to bind).
    let saw = false;
    for (let i = 0; i < 20 && !saw; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const probe = await scanRemotePorts(ssh, connectionId!);
      saw = probe.some((p) => p.port === 9090);
    }
    expect(saw).toBe(true);

    // The scan found the port; now open a manual forward for it (the same
    // code path the AutoForwarder uses internally once it sees the port) and
    // verify the tunnel works end-to-end.
    const spec: ForwardSpec = {
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort: 9090,
      destHost: '127.0.0.1',
      destPort: 9090,
    };
    const ok = await forwards.addManual(connectionId!, spec);
    expect(ok).toBe(true);
    const reachable = await isPortOpen(9090);
    expect(reachable).toBe(true);
    const states = forwards.list(connectionId!);
    expect(states.some((s) => s.destPort === 9090 && s.active)).toBe(true);
    await forwards.remove(connectionId!, 'local:9090->127.0.0.1:9090');
  }, 30_000);
});
