/**
 * Usage client for PocketShell Desktop.
 *
 * Executes the `pocketshell usage` command over an active SSH connection
 * and returns structured usage/quota data for AI providers.
 */

import type { SshConnection } from '../../ssh/connection/ssh-client';
import type { ProviderUsage, UsageSummary } from './types';
import { parseUsageOutput } from './usage-parser';

// ---------------------------------------------------------------------------
// UsageClient
// ---------------------------------------------------------------------------

/**
 * Client for fetching AI provider usage data via the `pocketshell` CLI.
 *
 * Requires an active SSH connection to a remote host where `pocketshell`
 * is installed and configured.
 */
export class UsageClient {
  private connection: SshConnection;

  constructor(connection: SshConnection) {
    this.connection = connection;
  }

  /**
   * Fetch aggregate usage across all providers.
   *
   * Executes `pocketshell usage --json` on the remote host and parses
   * the output into a UsageSummary.
   */
  async getUsage(): Promise<UsageSummary> {
    const result = await this.connection.exec('pocketshell usage --json');

    if (result.exitCode !== 0) {
      throw new Error(
        `pocketshell usage failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }

    return parseUsageOutput(result.stdout);
  }

  /**
   * Fetch usage data for a specific provider.
   *
   * Calls getUsage() and filters to the requested provider.
   * Throws if the provider is not found in the results.
   */
  async getProviderUsage(provider: string): Promise<ProviderUsage> {
    const summary = await this.getUsage();
    const entry = summary.providers.find(
      (p) => p.provider.toLowerCase() === provider.toLowerCase(),
    );

    if (!entry) {
      throw new Error(
        `Provider '${provider}' not found. Available: ${summary.providers.map((p) => p.provider).join(', ') || '(none)'}`,
      );
    }

    return entry;
  }
}
