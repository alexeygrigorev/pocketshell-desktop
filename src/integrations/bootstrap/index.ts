/**
 * PocketShell bootstrap module.
 *
 * Re-exports the public API for the bootstrap helper.
 */

export { BootstrapManager } from './bootstrap-manager';
export {
  compareVersions,
  isUpdateAvailable,
  isVersionCompatible,
  MIN_POCKETSHELL_CLI_VERSION,
} from './version-checker';
export type { PocketshellStatus, InstallResult, UpgradeResult } from './types';
