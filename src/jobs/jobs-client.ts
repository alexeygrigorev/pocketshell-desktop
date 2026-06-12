/**
 * Jobs client for PocketShell Desktop.
 *
 * Manages agent background jobs via the `pocketshell jobs` subcommand
 * over an SSH connection.
 */

import type { SshConnection, ExecResult } from '../ssh/connection/ssh-client';
import type { AgentJob } from './types';
import { parseJobsList } from './jobs-parser';

// ---------------------------------------------------------------------------
// JobsClient
// ---------------------------------------------------------------------------

export class JobsClient {
  private connection: SshConnection;

  constructor(connection: SshConnection) {
    this.connection = connection;
  }

  /**
   * List all agent jobs via `pocketshell jobs list`.
   */
  async list(): Promise<AgentJob[]> {
    const result = await this.connection.exec('pocketshell jobs list');
    if (result.exitCode !== 0) {
      throw new Error(`pocketshell jobs list failed: ${result.stderr}`);
    }
    return parseJobsList(result.stdout);
  }

  /**
   * Get a specific job by ID.
   *
   * Returns null if the job is not found.
   */
  async get(jobId: string): Promise<AgentJob | null> {
    const jobs = await this.list();
    return jobs.find((job) => job.id === jobId) ?? null;
  }

  /**
   * Cancel a running job via `pocketshell jobs remove <id>`.
   */
  async cancel(jobId: string): Promise<void> {
    const result = await this.connection.exec(
      `pocketshell jobs remove ${quoteArg(jobId)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`pocketshell jobs remove failed: ${result.stderr}`);
    }
  }

  /**
   * Get the output/logs of a job via `pocketshell jobs edit <id>`.
   *
   * The pocketshell utility exposes job details through the edit subcommand.
   * In a real deployment this would use a dedicated logs subcommand.
   */
  async logs(jobId: string): Promise<string> {
    const result = await this.connection.exec(
      `pocketshell jobs edit ${quoteArg(jobId)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`pocketshell jobs edit failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  /**
   * Stream job output by polling for new output.
   *
   * Returns an unsubscribe function that stops the polling.
   *
   * @param jobId - The job ID to follow
   * @param callback - Called with each chunk of new output
   * @param intervalMs - Polling interval in milliseconds (default 2000)
   */
  async follow(
    jobId: string,
    callback: (chunk: string) => void,
    intervalMs: number = 2000,
  ): Promise<() => void> {
    let running = true;

    // Fire-and-forget poll loop
    const poll = async () => {
      while (running) {
        try {
          const output = await this.logs(jobId);
          callback(output);
        } catch {
          // Connection may have dropped; stop polling
          break;
        }

        // Wait for the interval, checking cancellation
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalMs);
          // If unsubscribe is called during the wait, resolve immediately
          const check = () => {
            if (!running) {
              clearTimeout(timer);
              resolve();
            }
          };
          // Poll running flag frequently
          const interval = setInterval(check, 200);
          // Cleanup the checker when the sleep resolves
          const origResolve = resolve;
          resolve = () => {
            clearInterval(interval);
            origResolve();
          };
        });
      }
    };

    // Start polling in the background
    poll();

    // Return unsubscribe function
    return () => {
      running = false;
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quote a shell argument with single quotes. */
function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
