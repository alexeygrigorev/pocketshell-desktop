/**
 * Terminal Manager for PocketShell Desktop.
 *
 * Manages the lifecycle of SSH terminal instances: creation, tracking,
 * and destruction. Each terminal is backed by an SshTerminalBackend that
 * bridges xterm.js with a remote SSH PTY.
 *
 * The manager:
 *   - Assigns unique IDs to each terminal
 *   - Tracks active terminals by ID
 *   - Supports multiple concurrent terminals (e.g., one per tmux pane,
 *     or standalone shells)
 *   - Provides batch cleanup (closeAll)
 */

import type { SshConnection } from '../ssh/connection/ssh-client';
import { SshTerminalBackend } from './ssh-terminal-backend';
import type { TerminalOptions, SshTerminal } from './types';

export type { SshTerminal };

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let nextId = 1;

function generateId(): string {
  return `ssh-term-${nextId++}`;
}

// Reset for testing
export function resetIdCounter(): void {
  nextId = 1;
}

// ---------------------------------------------------------------------------
// Terminal Manager
// ---------------------------------------------------------------------------

export class TerminalManager {
  private terminals = new Map<string, SshTerminal>();

  /**
   * Create a new SSH terminal.
   *
   * Opens a shell on the remote host and returns an SshTerminal handle.
   *
   * @param hostId - The host ID (used for ConnectionManager lookup).
   * @param connection - The active SSH connection for this host.
   * @param options - Terminal options (name, cols, rows, cwd, env, etc.).
   * @returns The created terminal handle.
   * @throws Error if the shell cannot be opened.
   */
  async createTerminal(
    hostId: number,
    connection: SshConnection,
    options?: TerminalOptions,
  ): Promise<SshTerminal> {
    const id = generateId();
    const backend = new SshTerminalBackend(connection, options);

    // Start the backend (opens the remote shell)
    await backend.start();

    const terminal: SshTerminal = {
      id,
      backend,
      hostId,
      name: options?.name ?? `Terminal ${id}`,
      createdAt: Date.now(),
      isActive: true,
    };

    // When the backend exits, mark the terminal as inactive
    backend.onExit(() => {
      terminal.isActive = false;
    });

    this.terminals.set(id, terminal);
    return terminal;
  }

  /**
   * List all tracked terminals (including inactive ones).
   */
  listTerminals(): SshTerminal[] {
    return Array.from(this.terminals.values());
  }

  /**
   * Get a terminal by ID.
   */
  getTerminal(id: string): SshTerminal | undefined {
    return this.terminals.get(id);
  }

  /**
   * Close a specific terminal by ID.
   *
   * Kills the backend and removes the terminal from tracking.
   * No-op if the terminal doesn't exist.
   */
  closeTerminal(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;

    if (terminal.isActive) {
      terminal.backend.kill();
      terminal.isActive = false;
    }

    this.terminals.delete(id);
  }

  /**
   * Close all tracked terminals.
   */
  closeAll(): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.isActive) {
        terminal.backend.kill();
        terminal.isActive = false;
      }
    }
    this.terminals.clear();
  }

  /**
   * Number of currently tracked terminals.
   */
  get count(): number {
    return this.terminals.size;
  }
}
