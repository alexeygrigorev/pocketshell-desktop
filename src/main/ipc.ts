import { ipcMain } from 'electron';
import { ipc } from '../shared/channels.js';
import type { HostEntry } from '../shared/types.js';
import { SshService } from './ssh/SshService.js';
import { ConnectionRegistry } from './ssh/ConnectionRegistry.js';
import { readSshConfig } from './ssh-config/SshConfigParser.js';
import { KnownHosts } from './ssh-config/KnownHosts.js';

/**
 * Registers all ipcMain handlers. Called once from the main process entry.
 *
 * Every privileged operation lives here. The renderer calls the typed
 * `window.api` surface exposed by the preload, which forwards to these
 * channels. Keys/passphrases never leave this module.
 */
export function registerIpcHandlers(deps: {
  registry: ConnectionRegistry;
  ssh: SshService;
}): void {
  const { registry, ssh } = deps;

  // --- ssh:listConfigHosts -------------------------------------------------
  ipcMain.handle(ipc.ssh.listConfigHosts, async (): Promise<HostEntry[]> => {
    return readSshConfig();
  });

  // --- ssh:connect ---------------------------------------------------------
  ipcMain.handle(
    ipc.ssh.connect,
    async (
      _evt,
      payload: {
        host: string;
        port?: number;
        user: string;
        privateKeyPath?: string;
        privateKey?: string;
        passphrase?: string;
        tofuDecision?: 'accept-always' | 'accept-once' | 'reject';
      },
    ) => {
      const knownHosts = new KnownHosts();
      const result = await ssh.connect({
        host: payload.host,
        port: payload.port,
        user: payload.user,
        privateKeyPath: payload.privateKeyPath,
        privateKey: payload.privateKey,
        passphrase: payload.passphrase,
        knownHosts,
        tofuDecision: payload.tofuDecision,
      });
      return result;
    },
  );

  // --- ssh:exec ------------------------------------------------------------
  ipcMain.handle(
    ipc.ssh.exec,
    async (_evt, connectionId: string, command: string) => {
      return ssh.exec(connectionId, command);
    },
  );

  // --- ssh:close -----------------------------------------------------------
  ipcMain.handle(ipc.ssh.close, async (_evt, connectionId: string) => {
    ssh.close(connectionId);
    return true;
  });

  // Plumbing: expose registry size for tests/debugging without leaking clients.
  void registry;
}
