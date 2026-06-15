/**
 * Application startup orchestrator for PocketShell Desktop.
 *
 * Initializes all core services in the correct order and returns
 * the shared app context.
 */

import { HostStore, initStore } from '../ssh/data/host-store';
import { ConnectionManager } from '../ssh/connection/connection-manager';
import { PortForwardManager } from '../port-forwarding';
import { SettingsStore } from './settings';
import { AutoConnectService } from './auto-connect';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppContext {
  settings: SettingsStore;
  hostStore: HostStore;
  connectionManager: ConnectionManager;
  portForwardManager: PortForwardManager;
  autoConnect: AutoConnectService;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the application.
 *
 * Creates and wires up all core services:
 *  1. SettingsStore  — load persisted preferences
 *  2. HostStore      — init SQLite database
 *  3. ConnectionManager — SSH connection state machine
 *  4. PortForwardManager — local tunnels over active SSH connections
 *  5. AutoConnectService — background reconnect to last host
 *
 * @returns The shared app context.
 */
export async function initializeApp(options?: {
  settingsPath?: string;
  dbPath?: string;
}): Promise<AppContext> {
  // 1. Settings
  const settings = new SettingsStore(options?.settingsPath);
  settings.load();

  // 2. Host database
  const hostStore = await initStore(options?.dbPath);

  // 3. Connection manager
  const connectionManager = new ConnectionManager();

  // 4. Port forwarding
  const portForwardManager = new PortForwardManager({
    connections: connectionManager,
  });

  // 5. Auto-connect service
  const autoConnect = new AutoConnectService(
    hostStore,
    connectionManager,
    settings,
  );

  autoConnect.startInBackground();

  return {
    settings,
    hostStore,
    connectionManager,
    portForwardManager,
    autoConnect,
  };
}
