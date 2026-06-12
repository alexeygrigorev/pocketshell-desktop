/**
 * PocketShell bootstrap module.
 *
 * Re-exports the public API for the bootstrap helper.
 */

export { BootstrapManager } from './bootstrap-manager';
export { compareVersions, isUpdateAvailable } from './version-checker';
export type { PocketshellStatus, InstallResult, UpgradeResult } from './types';
