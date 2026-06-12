/**
 * Application startup orchestrator for PocketShell Desktop.
 *
 * Initializes all core services in the correct order and returns
 * the shared app context.
 */

import { HostStore, initStore } from '../ssh/data/host-store';
import { ConnectionManager } from '../ssh/connection/connection-manager';
import { SettingsStore } from './settings';
import { AutoConnectService } from './auto-connect';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppContext {
  settings: SettingsStore;
  hostStore: HostStore;
  connectionManager: ConnectionManager;
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
 *  4. AutoConnectService — background reconnect to last host
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

  // 4. Auto-connect service
  const autoConnect = new AutoConnectService(
    hostStore,
    connectionManager,
    settings,
  );

  await autoConnect.init();

  return { settings, hostStore, connectionManager, autoConnect };
}
