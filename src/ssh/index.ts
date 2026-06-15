/**
 * SSH module barrel export.
 *
 * Re-exports all public APIs from the ssh submodules.
 */

// Data layer
export { HostStore, initStore, createHostStore } from './data/host-store';
export type { Host, NewHost } from './data/host-store';

export {
  KeyStore,
  initKeyStore,
  computeFingerprint,
  looksLikePrivateKey,
  hasPrivateKeyPassphrase,
  defaultKeysDir,
} from './data/key-store';
export type { SshKey, NewSshKey } from './data/key-store';

export {
  parseSshConfig,
  parseSshConfigString,
  filterConcreteHosts,
} from './data/ssh-config-parser';
export type { SshConfigHost } from './data/ssh-config-parser';
export { createSshConfigImportPlan } from './data/ssh-config-import';
export type {
  SshConfigImportCandidate,
  SshConfigImportHost,
  SshConfigImportPlan,
  SshConfigImportSkipped,
} from './data/ssh-config-import';

// Connection layer
export { SshClient, ConnectionPool } from './connection/ssh-client';
export type {
  SshKeyMaterial,
  KnownHostsPolicy,
  SshConnectParams,
  ExecResult,
  SshConnection,
  ShellOptions,
  SshShell,
  PoolKey,
} from './connection/ssh-client';

export { ConnectionManager, ConnectionState, ConnectionEvent } from './connection/connection-manager';
export type { StateChange, StateChangeCallback } from './connection/connection-manager';
