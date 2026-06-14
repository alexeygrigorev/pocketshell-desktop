/**
 * Types for the PocketShell bootstrap helper.
 *
 * Used by BootstrapManager to detect, install, upgrade, and uninstall
 * the pocketshell utility on remote servers.
 */

/** Result of probing for pocketshell on the remote host. */
export interface PocketshellStatus {
  /** Whether pocketshell is found on the remote host. */
  isInstalled: boolean;
  /** Installed version string (e.g. "1.2.3"), if available. */
  version?: string;
  /** Absolute path to the pocketshell binary, if found. */
  binaryPath?: string;
  /** Whether a newer version is available. */
  needsUpdate: boolean;
  /** Latest available version (fetched from the remote release endpoint). */
  latestVersion?: string;
}

/** Result of installing pocketshell. */
export interface InstallResult {
  /** Whether the installation succeeded. */
  success: boolean;
  /** Installed version, if available. */
  version?: string;
  /** Error message on failure. */
  error?: string;
}

/** Result of upgrading pocketshell. */
export interface UpgradeResult {
  /** Whether the upgrade succeeded. */
  success: boolean;
  /** Version before the upgrade. */
  oldVersion?: string;
  /** Version after the upgrade. */
  newVersion?: string;
  /** Error message on failure. */
  error?: string;
}
