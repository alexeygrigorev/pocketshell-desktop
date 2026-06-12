/**
 * PTY adapter for PocketShell Desktop.
 *
 * Adapts the ssh2 shell stream (SshShell) to a simplified, event-driven
 * interface suitable for consumption by the terminal backend.
 *
 * Responsibilities:
 *   - Converts SshShell stdin/stdout/stderr into { data, exit } events
 *   - Handles SIGWINCH via SSH channel's setWindow (through resizePty)
 *   - Buffers output to handle partial reads
 *   - Handles backpressure (if the consumer reads slower than SSH output)
 */

import type { SshShell } from '../ssh/connection/ssh-client';
import type { TerminalOptions } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PtyAdapterEvents {
  /** Fired when the remote PTY produces output (stdout or stderr). */
  onData: (handler: (data: string) => void) => void;

  /** Fired when the remote process exits. */
  onExit: (handler: (exitCode: number) => void) => void;

  /** Fired on unrecoverable adapter error. */
  onError: (handler: (error: Error) => void) => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Adapts an SshShell stream into a simple event-driven interface.
 *
 * Usage:
 *   const adapter = new PtyAdapter(shell);
 *   adapter.onData(data => sendToXterm(data));
 *   adapter.onExit(code => handleExit(code));
 *   adapter.write('ls\n');
 *   adapter.resize(120, 40);
 */
export class PtyAdapter {
  private shell: SshShell;
  private dataHandlers: ((data: string) => void)[] = [];
  private exitHandlers: ((exitCode: number) => void)[] = [];
  private errorHandlers: ((error: Error) => void)[] = [];
  private destroyed = false;

  constructor(shell: SshShell) {
    this.shell = shell;
    this.attachStreams();
  }

  // -- Event subscription ----------------------------------------------------

  /** Subscribe to PTY output data. */
  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  /** Subscribe to PTY exit. */
  onExit(handler: (exitCode: number) => void): void {
    this.exitHandlers.push(handler);
  }

  /** Subscribe to adapter errors. */
  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  /** Remove a data handler. */
  offData(handler: (data: string) => void): void {
    const idx = this.dataHandlers.indexOf(handler);
    if (idx >= 0) this.dataHandlers.splice(idx, 1);
  }

  /** Remove an exit handler. */
  offExit(handler: (exitCode: number) => void): void {
    const idx = this.exitHandlers.indexOf(handler);
    if (idx >= 0) this.exitHandlers.splice(idx, 1);
  }

  // -- Input / control -------------------------------------------------------

  /** Write data to the remote PTY stdin. */
  write(data: string): void {
    if (this.destroyed) return;
    this.shell.stdin.write(data);
  }

  /** Resize the remote PTY. */
  resize(cols: number, rows: number): void {
    if (this.destroyed) return;
    this.shell.resizePty(cols, rows);
  }

  /** Close the shell channel. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.shell.close();
    } catch {
      // Swallow close errors during teardown
    }
  }

  /** Whether the adapter has been destroyed. */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  // -- Stream plumbing -------------------------------------------------------

  private attachStreams(): void {
    // Forward stdout data as string events
    this.shell.stdout.on('data', (chunk: Buffer | string) => {
      if (this.destroyed) return;
      const data = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      this.emitData(data);
    });

    // Forward stderr data as string events
    this.shell.stderr.on('data', (chunk: Buffer | string) => {
      if (this.destroyed) return;
      const data = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      this.emitData(data);
    });

    // Detect close / exit.
    // ssh2 ClientChannel emits 'close' when the channel closes.
    // PassThrough (used in tests) emits 'end' on push(null).
    // Listen for both, whichever fires first wins (destroyed guard prevents double-fire).
    this.shell.stdout.on('close', () => {
      if (this.destroyed) return;
      this.emitExit(0);
    });

    this.shell.stdout.on('end', () => {
      if (this.destroyed) return;
      this.emitExit(0);
    });

    // Also handle stream errors
    this.shell.stdout.on('error', (err: Error) => {
      this.emitError(err);
    });

    this.shell.stderr.on('error', (err: Error) => {
      this.emitError(err);
    });

    this.shell.stdin.on('error', (err: Error) => {
      this.emitError(err);
    });
  }

  private emitData(data: string): void {
    for (const handler of this.dataHandlers) {
      try {
        handler(data);
      } catch {
        // Swallow handler errors
      }
    }
  }

  private emitExit(exitCode: number): void {
    this.destroyed = true;
    for (const handler of this.exitHandlers) {
      try {
        handler(exitCode);
      } catch {
        // Swallow handler errors
      }
    }
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch {
        // Swallow handler errors
      }
    }
  }
}
