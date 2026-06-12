/**
 * SSH Terminal Backend for PocketShell Desktop.
 *
 * Bridges VS Code's terminal (xterm.js) with a remote SSH PTY.
 * Implements an IPty-compatible interface that VS Code's terminal
 * infrastructure can consume.
 *
 * The backend:
 *   1. Opens a shell via the SshConnection.shell() method
 *   2. Pipes output from the remote PTY to xterm.js (via onData)
 *   3. Pipes input from xterm.js to the remote PTY (via write)
 *   4. Handles resize by sending SIGWINCH to the remote PTY
 *   5. Handles exit / kill / shutdown lifecycle
 */

import type { SshConnection } from '../ssh/connection/ssh-client';
import type { TerminalOptions } from './types';
import { PtyAdapter } from './pty-adapter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal event emitter interface.
 *
 * Modeled after VS Code's Event<T> / Emitter<T> pattern but kept
 * self-contained to avoid depending on VS Code internals.
 */
export interface Event<T> {
  (listener: (e: T) => any): { dispose(): void };
}

// ---------------------------------------------------------------------------
// Simple Emitter
// ---------------------------------------------------------------------------

class Emitter<T> {
  private listeners: ((e: T) => any)[] = [];

  /** Subscribe to events. Returns a disposable. */
  get event(): Event<T> {
    return (listener: (e: T) => any) => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          const idx = this.listeners.indexOf(listener);
          if (idx >= 0) this.listeners.splice(idx, 1);
        },
      };
    };
  }

  /** Fire an event to all listeners. */
  fire(data: T): void {
    const listeners = this.listeners.slice(); // snapshot
    for (const listener of listeners) {
      try {
        listener(data);
      } catch {
        // Swallow listener errors
      }
    }
  }

  /** Remove all listeners. */
  dispose(): void {
    this.listeners.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

/**
 * SSH-backed terminal backend.
 *
 * Implements an IPty-compatible interface that VS Code's terminal can
 * consume. Each instance wraps a single SSH shell channel.
 */
export class SshTerminalBackend {
  private connection: SshConnection;
  private options: TerminalOptions;
  private adapter: PtyAdapter | null = null;
  private started = false;
  private _killed = false;

  private readonly onDataEmitter = new Emitter<string>();
  private readonly onExitEmitter = new Emitter<{ exitCode: number }>();

  constructor(connection: SshConnection, options?: TerminalOptions) {
    this.connection = connection;
    this.options = options ?? {};
  }

  // -- Public events (IPty-compatible) ---------------------------------------

  /** Fires when the remote PTY produces output data for xterm.js. */
  readonly onData: Event<string> = this.onDataEmitter.event;

  /** Fires when the remote PTY exits. */
  readonly onExit: Event<{ exitCode: number }> = this.onExitEmitter.event;

  // -- Lifecycle -------------------------------------------------------------

  /**
   * Start the terminal backend.
   *
   * Opens a shell on the remote host via SSH, sets up the PTY adapter,
   * and begins piping data between xterm.js and the remote PTY.
   *
   * @throws Error if the connection is not active or shell() fails.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Terminal backend already started');
    }

    if (!this.connection.connected) {
      throw new Error('SSH connection is not active');
    }

    const cols = this.options.cols ?? 80;
    const rows = this.options.rows ?? 24;
    const term = this.options.term ?? 'xterm-256color';

    // Open remote shell
    const shell = await this.connection.shell({
      term,
      cols,
      rows,
    });

    // Set up the PTY adapter
    this.adapter = new PtyAdapter(shell);

    this.adapter.onData((data) => {
      this.onDataEmitter.fire(data);
    });

    this.adapter.onExit((exitCode) => {
      this.onExitEmitter.fire({ exitCode });
      this.cleanup();
    });

    this.adapter.onError((_error) => {
      // On error, treat as exit with code 1
      this.onExitEmitter.fire({ exitCode: 1 });
      this.cleanup();
    });

    // If a cwd was specified, send a cd command
    if (this.options.cwd) {
      this.adapter.write(`cd ${this.options.cwd}\n`);
    }

    // If env vars were specified, export them
    if (this.options.env) {
      for (const [key, value] of Object.entries(this.options.env)) {
        // Escape single quotes in the value
        const escaped = value.replace(/'/g, "'\\''");
        this.adapter.write(`export ${key}='${escaped}'\n`);
      }
    }

    this.started = true;
  }

  /**
   * Write data to the remote PTY stdin (from xterm.js user input).
   */
  write(data: string): void {
    if (!this.adapter || this._killed) return;
    this.adapter.write(data);
  }

  /**
   * Resize the remote PTY.
   */
  resize(cols: number, rows: number): void {
    if (!this.adapter || this._killed) return;
    this.adapter.resize(cols, rows);
  }

  /**
   * Kill the terminal (close the SSH channel).
   */
  kill(): void {
    if (this._killed) return;
    this._killed = true;

    if (this.adapter) {
      this.adapter.destroy();
    }

    // Fire exit event so VS Code's terminal infrastructure cleans up
    this.onExitEmitter.fire({ exitCode: 0 });
    this.cleanup();
  }

  /**
   * Graceful shutdown.
   *
   * Sends 'exit\n' to the remote shell, giving it a chance to close
   * cleanly. Falls back to kill() after a timeout.
   */
  shutdown(timeoutMs: number = 3000): Promise<void> {
    if (this._killed) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;

      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      // Listen for the natural exit
      const sub = this.onExitEmitter.event(() => {
        sub.dispose();
        done();
      });

      // Send exit command
      if (this.adapter) {
        this.adapter.write('exit\n');
      }

      // Fallback: force kill after timeout
      setTimeout(() => {
        sub.dispose();
        if (!settled) {
          this.kill();
          done();
        }
      }, timeoutMs);
    });
  }

  /** Whether the backend has been started. */
  get isStarted(): boolean {
    return this.started;
  }

  /** Whether the backend has been killed. */
  get isKilled(): boolean {
    return this._killed;
  }

  // -- Private helpers -------------------------------------------------------

  private cleanup(): void {
    this.started = false;
    this.onDataEmitter.dispose();
    this.onExitEmitter.dispose();
  }
}
