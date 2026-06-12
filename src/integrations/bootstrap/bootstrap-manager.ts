/**
 * Bootstrap manager for the pocketshell utility.
 *
 * Detects, installs, upgrades, and uninstalls the pocketshell binary on a
 * remote host over SSH.
 *
 * Install strategies (tried in order until one succeeds):
 *   1. Official curl/sh script: `curl -sSL https://get.pocketshell.dev | sh`
 *   2. pip: `pip install pocketshell`
 *   3. Manual binary download (platform-specific)
 */

import type { SshConnection } from '../../ssh/connection/ssh-client';
import type { PocketshellStatus, InstallResult, UpgradeResult } from './types';
import { compareVersions } from './version-checker';

/** Sentinel version returned when the latest version cannot be determined. */
const UNKNOWN_VERSION = '0.0.0';

/**
 * Manages the lifecycle of the pocketshell binary on a remote host.
 */
export class BootstrapManager {
  constructor(private readonly connection: SshConnection) {}

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Detect whether pocketshell is installed and whether an update is
   * available.
   */
  async detect(): Promise<PocketshellStatus> {
    const installed = await this.detectInstalled();

    if (!installed.isInstalled) {
      // Still try to learn the latest version so the caller can offer an
      // install prompt.
      const latestVersion = await this.fetchLatestVersion();
      return {
        isInstalled: false,
        needsUpdate: false,
        latestVersion,
      };
    }

    const latestVersion = await this.fetchLatestVersion();
    const needsUpdate =
      installed.version !== undefined &&
      compareVersions(installed.version, latestVersion) < 0;

    return {
      isInstalled: true,
      version: installed.version,
      binaryPath: installed.binaryPath,
      needsUpdate,
      latestVersion,
    };
  }

  /**
   * Install pocketshell on the remote host.
   *
   * Tries install strategies in order and returns the result of the first
   * one that succeeds. If all fail, returns the last error.
   */
  async install(): Promise<InstallResult> {
    const strategies: InstallStrategy[] = [
      { name: 'curl-sh', fn: () => this.installViaCurlSh() },
      { name: 'pip', fn: () => this.installViaPip() },
      { name: 'manual', fn: () => this.installViaManualDownload() },
    ];

    let lastError = '';
    for (const strategy of strategies) {
      const result = await strategy.fn();
      if (result.success) {
        return result;
      }
      lastError = result.error ?? `${strategy.name} failed`;
    }

    return { success: false, error: lastError };
  }

  /**
   * Upgrade pocketshell to the latest version.
   */
  async upgrade(): Promise<UpgradeResult> {
    const installed = await this.detectInstalled();
    const oldVersion = installed.version;

    if (!installed.isInstalled) {
      return {
        success: false,
        error: 'Pocketshell is not installed; call install() first',
      };
    }

    // Re-run the install (which tries all strategies) to pull the latest.
    const installResult = await this.install();
    if (!installResult.success) {
      return {
        success: false,
        oldVersion,
        error: installResult.error,
      };
    }

    return {
      success: true,
      oldVersion,
      newVersion: installResult.version,
    };
  }

  /**
   * Uninstall pocketshell from the remote host.
   */
  async uninstall(): Promise<void> {
    // Try removing the binary we detected (if any).
    const installed = await this.detectInstalled();
    if (installed.binaryPath) {
      try {
        await this.connection.exec(`rm -f '${installed.binaryPath}'`);
      } catch {
        // Best-effort removal — ignore errors.
      }
    }

    // Also attempt pip uninstall in case it was installed via pip.
    try {
      await this.connection.exec('pip uninstall -y pocketshell 2>/dev/null || true');
    } catch {
      // Ignore.
    }
  }

  // -----------------------------------------------------------------------
  // Detection helpers
  // -----------------------------------------------------------------------

  /**
   * Probe the remote host for an installed pocketshell binary.
   */
  private async detectInstalled(): Promise<{
    isInstalled: boolean;
    version?: string;
    binaryPath?: string;
  }> {
    try {
      // `which pocketshell` to find the binary.
      const which = await this.connection.exec('which pocketshell 2>/dev/null');
      if (which.exitCode !== 0 || !which.stdout.trim()) {
        return { isInstalled: false };
      }

      const binaryPath = which.stdout.trim();

      // Query the installed version.
      const ver = await this.connection.exec('pocketshell --version');
      const version = ver.exitCode === 0 ? ver.stdout.trim() : undefined;

      return { isInstalled: true, version, binaryPath };
    } catch {
      return { isInstalled: false };
    }
  }

  /**
   * Fetch the latest available version from the remote release endpoint.
   *
   * Runs `curl -sSLf` on the remote host so we respect any proxy/env
   * configuration on the server.
   */
  private async fetchLatestVersion(): Promise<string> {
    try {
      const result = await this.connection.exec(
        'curl -sSLf https://get.pocketshell.dev/version 2>/dev/null',
        10_000,
      );
      if (result.exitCode === 0 && result.stdout.trim()) {
        return result.stdout.trim();
      }
    } catch {
      // Fall through.
    }
    return UNKNOWN_VERSION;
  }

  // -----------------------------------------------------------------------
  // Install strategies
  // -----------------------------------------------------------------------

  /** Strategy 1: official curl | sh installer. */
  private async installViaCurlSh(): Promise<InstallResult> {
    try {
      const result = await this.connection.exec(
        'curl -sSL https://get.pocketshell.dev | sh',
        120_000,
      );
      if (result.exitCode === 0) {
        const installed = await this.detectInstalled();
        return {
          success: true,
          version: installed.version,
        };
      }
      return {
        success: false,
        error: result.stderr.trim() || `curl|sh exited with code ${result.exitCode}`,
      };
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /** Strategy 2: pip install. */
  private async installViaPip(): Promise<InstallResult> {
    try {
      const result = await this.connection.exec(
        'pip install pocketshell 2>&1',
        120_000,
      );
      if (result.exitCode === 0) {
        const installed = await this.detectInstalled();
        return {
          success: true,
          version: installed.version,
        };
      }
      return {
        success: false,
        error: result.stderr.trim() || `pip exited with code ${result.exitCode}`,
      };
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /** Strategy 3: manual binary download. */
  private async installViaManualDownload(): Promise<InstallResult> {
    try {
      // Detect platform/arch on the remote host.
      const uname = await this.connection.exec('uname -ms');
      if (uname.exitCode !== 0) {
        return { success: false, error: 'Cannot determine remote platform' };
      }

      const [os, arch] = uname.stdout.trim().split(/\s+/);
      const platform = mapPlatform(os, arch);

      const installDir = '$HOME/.local/bin';
      const url = `https://github.com/alexeygrigorev/pocketshell/releases/latest/download/pocketshell-${platform}`;

      const result = await this.connection.exec(
        `mkdir -p ${installDir} && curl -sSLf -o ${installDir}/pocketshell '${url}' && chmod +x ${installDir}/pocketshell`,
        120_000,
      );
      if (result.exitCode === 0) {
        const installed = await this.detectInstalled();
        return {
          success: true,
          version: installed.version,
        };
      }
      return {
        success: false,
        error: result.stderr.trim() || `manual download exited with code ${result.exitCode}`,
      };
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// Internal types & helpers
// ---------------------------------------------------------------------------

interface InstallStrategy {
  name: string;
  fn: () => Promise<InstallResult>;
}

/**
 * Map `uname -ms` output to a release-platform string.
 *
 * Examples:
 *   "Linux x86_64"  -> "linux-amd64"
 *   "Darwin arm64"   -> "darwin-arm64"
 *   "Linux aarch64"  -> "linux-arm64"
 */
function mapPlatform(os: string, arch: string): string {
  const osLower = os.toLowerCase();
  const archNorm =
    arch === 'x86_64'
      ? 'amd64'
      : arch === 'aarch64'
        ? 'arm64'
        : arch.toLowerCase();

  return `${osLower}-${archNorm}`;
}
