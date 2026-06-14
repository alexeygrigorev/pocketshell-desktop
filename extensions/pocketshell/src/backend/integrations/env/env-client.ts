/**
 * EnvClient — manages environment variables on the remote host
 * via the `pocketshell env` subcommand.
 *
 * Uses an exec-based SSH connection pattern (same as GitClient).
 */

import type { SshConnection, ExecResult } from '../../ssh/connection/ssh-client';
import type { EnvVar } from './types';

// ---------------------------------------------------------------------------
// Secret detection
// ---------------------------------------------------------------------------

/** Patterns that indicate a value should be treated as a secret. */
const SECRET_PATTERNS = [
  /KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /API/i,
];

/**
 * Heuristic: returns true if the key name suggests the value is sensitive.
 * Matches keys containing: KEY, SECRET, TOKEN, PASSWORD, API.
 */
export function detectSecret(key: string, _value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

// ---------------------------------------------------------------------------
// EnvClient
// ---------------------------------------------------------------------------

export class EnvClient {
  private connection: SshConnection;

  constructor(connection: SshConnection) {
    this.connection = connection;
  }

  /**
   * List environment variables via `pocketshell env list`.
   *
   * @param scope Optional scope filter (global, project, session).
   * @returns Parsed env var entries.
   */
  async list(scope?: string): Promise<EnvVar[]> {
    let command = 'pocketshell env list';
    if (scope) {
      command += ` --scope '${scope}'`;
    }

    const result: ExecResult = await this.connection.exec(command);

    if (result.exitCode !== 0) {
      throw new Error(`pocketshell env list failed: ${result.stderr}`);
    }

    return this.parseListOutput(result.stdout);
  }

  /**
   * Get the value of a specific environment variable.
   *
   * @param key The variable name to look up.
   * @returns The variable value, or undefined if not found.
   */
  async get(key: string): Promise<string | undefined> {
    const result: ExecResult = await this.connection.exec(
      `pocketshell env get '${key}'`,
    );

    if (result.exitCode !== 0) {
      // Variable not found
      return undefined;
    }

    return result.stdout.trim();
  }

  /**
   * Set an environment variable via `pocketshell env set`.
   *
   * @param key Variable name.
   * @param value Variable value.
   * @param scope Optional scope (global, project, session).
   */
  async set(key: string, value: string, scope?: string): Promise<void> {
    let command = `pocketshell env set '${key}' '${value}'`;
    if (scope) {
      command += ` --scope '${scope}'`;
    }

    const result: ExecResult = await this.connection.exec(command);

    if (result.exitCode !== 0) {
      throw new Error(`pocketshell env set failed: ${result.stderr}`);
    }
  }

  /**
   * Remove an environment variable via `pocketshell env unset`.
   *
   * @param key Variable name to remove.
   * @param scope Optional scope (global, project, session).
   */
  async unset(key: string, scope?: string): Promise<void> {
    let command = `pocketshell env unset '${key}'`;
    if (scope) {
      command += ` --scope '${scope}'`;
    }

    const result: ExecResult = await this.connection.exec(command);

    if (result.exitCode !== 0) {
      throw new Error(`pocketshell env unset failed: ${result.stderr}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse the output of `pocketshell env list`.
   *
   * Expected format: one var per line as KEY=VALUE.
   * Values containing *** are treated as masked secrets.
   */
  private parseListOutput(output: string): EnvVar[] {
    const lines = output.split('\n').filter((line) => line.trim() !== '');
    return lines.map((line) => {
      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) {
        return { key: line.trim(), value: '', isSecret: false };
      }
      const key = line.slice(0, eqIndex).trim();
      const rawValue = line.slice(eqIndex + 1).trim();
      const isSecret = rawValue === '***' || detectSecret(key, rawValue);
      return { key, value: rawValue, isSecret };
    });
  }
}
