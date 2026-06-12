/**
 * Auto-connect service for PocketShell Desktop.
 *
 * On app startup, looks for the host with the most recent `lastConnectedAt`
 * timestamp and attempts to reconnect in the background.
 *
 * Emits events for each outcome so the UI layer can react accordingly.
 */

import { HostStore, Host } from '../ssh/data/host-store';
import { ConnectionManager } from '../ssh/connection/connection-manager';
import { SettingsStore, AppSettings } from './settings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoConnectEvent =
  | { type: 'no-hosts' }
  | { type: 'skipped' }
  | { type: 'connected'; host: Host }
  | { type: 'connect-failed'; host: Host; error: Error };

type EventCallback = (event: AutoConnectEvent) => void;

// ---------------------------------------------------------------------------
// AutoConnectService
// ---------------------------------------------------------------------------

export class AutoConnectService {
  private listeners: EventCallback[] = [];

  constructor(
    private hostStore: HostStore,
    private connectionManager: ConnectionManager,
    private settingsStore: SettingsStore,
  ) {}

  /**
   * Run the auto-connect logic.
   *
   * This is non-blocking: connection attempts happen in the background.
   * Call on startup.
   */
  async init(): Promise<void> {
    const settings = this.settingsStore.get();

    // Check if auto-connect is enabled
    if (!settings.autoConnect) {
      this.emit({ type: 'skipped' });
      return;
    }

    // Load all hosts and find the most recently connected one
    const hosts = this.hostStore.list();

    if (hosts.length === 0) {
      this.emit({ type: 'no-hosts' });
      return;
    }

    const lastHost = this.findMostRecentHost(hosts);

    if (!lastHost) {
      this.emit({ type: 'no-hosts' });
      return;
    }

    // Attempt to connect in the background
    try {
      const params = this.buildConnectParams(lastHost, settings);
      await this.connectionManager.connect(lastHost.id, params);
      this.emit({ type: 'connected', host: lastHost });
    } catch (err: any) {
      this.emit({ type: 'connect-failed', host: lastHost, error: err });
    }
  }

  /** Enable auto-connect and persist. */
  enable(): void {
    this.settingsStore.update({ autoConnect: true });
  }

  /** Disable auto-connect and persist. */
  disable(): void {
    this.settingsStore.update({ autoConnect: false });
  }

  /** Check whether auto-connect is currently enabled. */
  isEnabled(): boolean {
    return this.settingsStore.get().autoConnect;
  }

  /** Register a callback for auto-connect events. Returns unsubscribe fn. */
  onEvent(callback: EventCallback): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Convenience: subscribe to successful connections only. */
  onConnected(callback: (host: Host) => void): () => void {
    return this.onEvent((event) => {
      if (event.type === 'connected') callback(event.host);
    });
  }

  /** Convenience: subscribe to connection failures only. */
  onConnectFailed(callback: (host: Host, error: Error) => void): () => void {
    return this.onEvent((event) => {
      if (event.type === 'connect-failed') callback(event.host, event.error);
    });
  }

  // -- Private helpers -------------------------------------------------------

  private emit(event: AutoConnectEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // Swallow listener errors
      }
    }
  }

  /**
   * Find the host with the most recent `lastConnectedAt`.
   * Returns undefined if no host has ever been connected.
   */
  private findMostRecentHost(hosts: Host[]): Host | undefined {
    let best: Host | undefined;
    for (const host of hosts) {
      if (host.lastConnectedAt != null) {
        if (!best || host.lastConnectedAt > best.lastConnectedAt!) {
          best = host;
        }
      }
    }
    return best;
  }

  /**
   * Build SshConnectParams from a Host and current settings.
   *
   * Note: This is a simplified implementation. In production, the key material
   * would be resolved from KeyStore. For now we set up the params with a
   * placeholder that the connection manager can work with.
   */
  private buildConnectParams(
    host: Host,
    _settings: AppSettings,
  ): import('../ssh/connection/ssh-client').SshConnectParams {
    return {
      host: host.hostname,
      port: host.port,
      user: host.username,
      key: { type: 'path', file: host.keyPath },
      knownHosts: { type: 'acceptAll' },
    };
  }
}
