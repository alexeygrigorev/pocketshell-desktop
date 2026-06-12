/**
 * LogsClient — fetches and streams agent operation logs via the remote
 * `pocketshell logs` command.
 *
 * Usage:
 *   const client = new LogsClient(connection);
 *   const entries = await client.getLogs({ level: 'error' });
 *   const stop = await client.tail(entry => console.log(entry));
 *   // ... later
 *   stop();
 */

import type { SshConnection } from '../../ssh/connection/ssh-client';
import type { LogEntry, LogFilter } from './types';
import { parseLogs, filterLogs } from './log-parser';

/** Default exec timeout for log commands (ms). */
const DEFAULT_TIMEOUT = 15_000;

export class LogsClient {
  private connection: SshConnection;

  constructor(connection: SshConnection) {
    this.connection = connection;
  }

  /**
   * Fetch agent logs from the remote host.
   *
   * Runs `pocketshell logs` over SSH, parses the NDJSON output, and
   * optionally applies client-side filtering.
   */
  async getLogs(filter?: LogFilter): Promise<LogEntry[]> {
    const result = await this.connection.exec(
      'pocketshell logs',
      DEFAULT_TIMEOUT,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `pocketshell logs failed (exit ${result.exitCode}): ${result.stderr}`,
      );
    }

    const entries = parseLogs(result.stdout);

    return filter ? filterLogs(entries, filter) : entries;
  }

  /**
   * Stream new log entries as they arrive.
   *
   * Internally runs `pocketshell logs tail` in a persistent shell and
   * parses each NDJSON line as it arrives.
   *
   * @returns A stop function — call it to end the tail stream.
   */
  async tail(callback: (entry: LogEntry) => void): Promise<() => void> {
    const shell = await this.connection.shell();

    let buffer = '';

    const onData = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const entries = parseLogs(trimmed);
        for (const entry of entries) {
          callback(entry);
        }
      }
    };

    shell.stdout.on('data', onData);

    // Start tailing
    shell.stdin.write('pocketshell logs tail\n');

    // Return stop function
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      shell.stdout.removeListener('data', onData);
      shell.close();
    };
  }

  /**
   * Clear remote logs.
   *
   * Runs `pocketshell logs clear` on the remote host.
   */
  async clear(): Promise<void> {
    const result = await this.connection.exec(
      'pocketshell logs clear',
      DEFAULT_TIMEOUT,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `pocketshell logs clear failed (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
  }
}
