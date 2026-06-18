import type { SshService } from '../ssh/SshService.js';
import type { ConnectionRegistry } from '../ssh/ConnectionRegistry.js';
import type { ForwardSpec } from '../../shared/types.js';
import {
  AutoForwarder,
  DEFAULT_AUTO_CONFIG,
  type ForwardState,
} from './AutoForwarder.js';
import { scanRemotePorts, type RemotePort } from './scanRemotePorts.js';

/**
 * Per-connection forward manager. Owns one AutoForwarder (the scan loop) and
 * exposes the manual-forward + scan surface the IPC layer calls. The
 * reconnect FSM (AutoForwarderSupervisor) is deferred to Phase 3.5; for the
 * initial port-forward feature we run against the already-connected host.
 */
export class ForwardService {
  /** One AutoForwarder per connectionId. */
  private readonly forwarders = new Map<string, AutoForwarder>();
  private readonly listeners = new Set<(connectionId: string, states: ForwardState[]) => void>();

  constructor(
    private readonly ssh: SshService,
    private readonly registry: ConnectionRegistry,
  ) {}

  /** Subscribe to forward-state snapshots per connection. */
  onStates(listener: (connectionId: string, states: ForwardState[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Run a one-shot remote port scan (does not require the forwarder running). */
  async scan(connectionId: string): Promise<RemotePort[]> {
    return scanRemotePorts(this.ssh, connectionId);
  }

  /** Start the auto-forwarder for a connection (idempotent). */
  startAuto(connectionId: string): void {
    if (this.forwarders.has(connectionId)) return;
    const fwd = new AutoForwarder(this.ssh, connectionId, this.registry, DEFAULT_AUTO_CONFIG);
    fwd.onStates((states) => {
      for (const l of this.listeners) l(connectionId, states);
    });
    fwd.start();
    this.forwarders.set(connectionId, fwd);
  }

  stopAuto(connectionId: string): void {
    const fwd = this.forwarders.get(connectionId);
    if (fwd) {
      fwd.stop();
      this.forwarders.delete(connectionId);
    }
    for (const l of this.listeners) l(connectionId, []);
  }

  /** Add a manual forward (-L/-R/-D). */
  async addManual(connectionId: string, spec: ForwardSpec): Promise<boolean> {
    const fwd = this.forwarders.get(connectionId);
    if (fwd) return fwd.addManual(spec);
    // No auto-forwarder yet: create one lazily so manual forwards persist.
    this.startAuto(connectionId);
    return (await this.forwarders.get(connectionId)?.addManual(spec)) ?? false;
  }

  /** Remove a forward by key. */
  async remove(connectionId: string, key: string): Promise<void> {
    const fwd = this.forwarders.get(connectionId);
    if (fwd) await fwd.remove(key);
    for (const l of this.listeners) l(connectionId, fwd?.snapshot() ?? []);
  }

  /** Current snapshot for a connection. */
  list(connectionId: string): ForwardState[] {
    return this.forwarders.get(connectionId)?.snapshot() ?? [];
  }

  /** Tear down everything for a connection (on disconnect). */
  evict(connectionId: string): void {
    this.stopAuto(connectionId);
  }
}
