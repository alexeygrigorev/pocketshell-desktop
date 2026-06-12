/**
 * Terminal types for PocketShell Desktop.
 *
 * Defines the data types used by the terminal subsystem: options for
 * creating terminals, and the SshTerminal handle that tracks a live
 * terminal instance.
 */

// ---------------------------------------------------------------------------
// Terminal options
// ---------------------------------------------------------------------------

/** Options for creating an SSH terminal. */
export interface TerminalOptions {
  /** Display name for the terminal tab. */
  name?: string;

  /** Remote working directory to start in. */
  cwd?: string;

  /** Environment variables to set on the remote shell. */
  env?: Record<string, string>;

  /** Initial PTY columns (default 80). */
  cols?: number;

  /** Initial PTY rows (default 24). */
  rows?: number;

  /** Remote shell path (default: user's login shell). */
  shell?: string;

  /** TERM environment variable (default 'xterm-256color'). */
  term?: string;
}

// ---------------------------------------------------------------------------
// Terminal handle
// ---------------------------------------------------------------------------

/** A live SSH terminal instance tracked by the TerminalManager. */
export interface SshTerminal {
  /** Unique identifier for this terminal. */
  id: string;

  /** The backend that bridges the SSH shell stream. */
  backend: import('./ssh-terminal-backend').SshTerminalBackend;

  /** The host ID this terminal is connected to. */
  hostId: number;

  /** Display name. */
  name: string;

  /** Timestamp (ms since epoch) when this terminal was created. */
  createdAt: number;

  /** Whether the terminal is currently active (not closed). */
  isActive: boolean;
}
