import type { SshService } from '../ssh/SshService.js';
import type { ConnectionRegistry } from '../ssh/ConnectionRegistry.js';
import type { ForwardSpec } from '../../shared/types.js';
import { Forwarder, type ForwardState } from './Forwarder.js';
import { scanRemotePorts, type RemotePort } from './scanRemotePorts.js';

/** Re-exported so the IPC/preload layer imports the type from one place. */
export type { ForwardState };

/**
 * Auto-forward engine: periodically scans the remote host for listening TCP
 * ports and mirrors each one to localhost (like the Android AutoForwarder,
 * extended for desktop). User-added manual forwards persist for the session.
 *
 * Port resolution (matches the Android contract):
 *   - user remapping wins
 *   - if port in [1024, 10000] -> mirror (localhost:N <-> remote:N)
 *   - else allocate from 3000..3999
 */

export interface AutoForwardConfig {
  scanIntervalSec: number;
  maxAutoPort: number;
  skipPortsBelow: number;
  localPortRange: [number, number];
}

export const DEFAULT_AUTO_CONFIG: AutoForwardConfig = {
  scanIntervalSec: 10,
  maxAutoPort: 10_000,
  skipPortsBelow: 1024,
  localPortRange: [3_000, 3_999],
};

export class AutoForwarder {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly forwards = new Map<string, Forwarder>(); // key: `${kind}:${local}->${remote}`
  private readonly manual = new Set<number>(); // remote ports the user force-enabled
  private readonly remappings: Map<number, number>; // remotePort -> localPort
  private readonly listeners = new Set<(states: ForwardState[]) => void>();
  private config: AutoForwardConfig;

  constructor(
    private readonly ssh: SshService,
    private readonly connectionId: string,
    private readonly registry: ConnectionRegistry,
    config: AutoForwardConfig = DEFAULT_AUTO_CONFIG,
    remappings: Record<number, number> = {},
  ) {
    this.config = config;
    this.remappings = new Map(Object.entries(remappings).map(([k, v]) => [Number(k), v]));
  }

  /** Subscribe to the forward-state snapshot (called after each scan). */
  onStates(listener: (states: ForwardState[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start the scan loop. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scanAndForward(), this.config.scanIntervalSec * 1000);
    void this.scanAndForward();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const f of this.forwards.values()) void f.stop();
    this.forwards.clear();
    this.emit();
  }

  /** Manually add a local forward (-L). */
  async addManual(spec: ForwardSpec): Promise<boolean> {
    const f = new Forwarder(this.registry, this.connectionId, spec);
    const ok = await f.start();
    if (ok) {
      this.forwards.set(this.key(spec), f);
      if (spec.kind === 'local') this.manual.add(spec.destPort);
    }
    this.emit();
    return ok;
  }

  /** Remove a forward by key. */
  async remove(key: string): Promise<void> {
    const f = this.forwards.get(key);
    if (f) {
      await f.stop();
      this.forwards.delete(key);
    }
    this.emit();
  }

  /** Toggle auto-forward for a remote port on/off (overrides policy). */
  async togglePort(remotePort: number): Promise<void> {
    if (this.manual.has(remotePort)) {
      this.manual.delete(remotePort);
    } else {
      this.manual.add(remotePort);
    }
    await this.scanAndForward();
  }

  snapshot(): ForwardState[] {
    return [...this.forwards.values()].map((f) => f.snapshot());
  }

  private async scanAndForward(): Promise<void> {
    const ports = await this.scan();
    const activeRemote = new Set<number>();
    for (const rp of ports) {
      activeRemote.add(rp.port);
      if (!this.shouldForward(rp.port)) continue;
      const localPort = this.resolveLocalPort(rp.port);
      const key = `local:${localPort}->${rp.port}`;
      if (this.forwards.has(key)) continue;
      const spec: ForwardSpec = {
        kind: 'local',
        listenHost: '127.0.0.1',
        listenPort: localPort,
        destHost: '127.0.0.1',
        destPort: rp.port,
      };
      const f = new Forwarder(this.registry, this.connectionId, spec);
      const ok = await f.start();
      if (ok) this.forwards.set(key, f);
    }
    // Tear down forwards whose remote port vanished (unless manually toggled).
    for (const [key, f] of this.forwards) {
      if (f.spec.kind !== 'local') continue;
      const remote = f.spec.destPort;
      if (!activeRemote.has(remote) && !this.manual.has(remote)) {
        await f.stop();
        this.forwards.delete(key);
      }
    }
    this.emit();
  }

  private shouldForward(remotePort: number): boolean {
    if (this.manual.has(remotePort)) return true;
    // Auto policy: forward non-privileged ports below the cap.
    return remotePort >= this.config.skipPortsBelow && remotePort <= this.config.maxAutoPort;
  }

  private resolveLocalPort(remotePort: number): number {
    const remap = this.remappings.get(remotePort);
    if (remap !== undefined) return remap;
    if (remotePort >= this.config.skipPortsBelow && remotePort <= this.config.maxAutoPort) {
      return remotePort; // mirror
    }
    return this.allocateLocalPort();
  }

  private allocateLocalPort(): number {
    const [lo, hi] = this.config.localPortRange;
    const used = new Set([...this.forwards.values()].map((f) => f.spec.listenPort));
    for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
    throw new Error('local port range exhausted');
  }

  private async scan(): Promise<RemotePort[]> {
    // `ss -tlnp` as non-root HIDES ports whose process info it can't read
    // (it filters rather than just omitting the name). So we use `ss -tln`
    // (all listeners) and enrich with process names from `ss -tlnp` where
    // available, falling back to netstat.
    return scanRemotePorts(this.ssh, this.connectionId);
  }

  private key(spec: ForwardSpec): string {
    return `${spec.kind}:${spec.listenPort}->${spec.destHost}:${spec.destPort}`;
  }

  private emit(): void {
    const states = this.snapshot();
    for (const l of this.listeners) l(states);
  }
}
