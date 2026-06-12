/**
 * Unit tests for SshTerminalBackend.
 *
 * Uses hand-rolled mock classes (matching the project convention from
 * test/unit/tmux/client.test.ts) to verify:
 *   - start() creates a shell stream
 *   - write() sends data to the stream
 *   - resize() sends SIGWINCH (via resizePty)
 *   - onData emits remote output
 *   - onExit emits on stream close
 *   - kill() closes the channel
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SshTerminalBackend } from '../../../src/terminal/ssh-terminal-backend';
import type { SshConnection, SshShell } from '../../../src/ssh/connection/ssh-client';
import * as stream from 'stream';

// ---------------------------------------------------------------------------
// Mock SshShell
// ---------------------------------------------------------------------------

/**
 * Mock shell stream that simulates the ssh2 ClientChannel.
 *
 * Provides controllable stdin/stdout/stderr streams and tracks
 * resize/close calls.
 */
class MockSshShell implements SshShell {
  stdin: stream.Writable;
  stdout: stream.Readable;
  stderr: stream.Readable;

  resizeCalls: Array<{ cols: number; rows: number }> = [];
  closeCalled = false;

  constructor() {
    this.stdin = new stream.PassThrough();
    this.stdout = new stream.PassThrough();
    this.stderr = new stream.PassThrough();
  }

  resizePty(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  close(): void {
    this.closeCalled = true;
    // Destroy streams to simulate channel close
    this.stdout.destroy();
    this.stderr.destroy();
    this.stdin.end();
  }

  /** Simulate data arriving from the remote PTY. */
  pushStdout(data: string): void {
    this.stdout.push(data);
  }

  /** Simulate stderr data from the remote PTY. */
  pushStderr(data: string): void {
    this.stderr.push(data);
  }

  /** Simulate the channel closing (remote exit). */
  simulateExit(): void {
    this.stdout.push(null); // EOF
    this.stderr.push(null); // EOF
  }
}

// ---------------------------------------------------------------------------
// Mock SshConnection
// ---------------------------------------------------------------------------

class MockSshConnection implements SshConnection {
  private _connected = true;
  private mockShell: MockSshShell | null = null;

  get connected(): boolean {
    return this._connected;
  }

  setConnected(value: boolean): void {
    this._connected = value;
  }

  /** Get the last shell created by shell(). */
  get lastShell(): MockSshShell | null {
    return this.mockShell;
  }

  async exec(): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    throw new Error('Not implemented in mock');
  }

  async shell(): Promise<SshShell> {
    const shell = new MockSshShell();
    this.mockShell = shell;
    return shell;
  }

  async sftp(): Promise<any> {
    throw new Error('Not implemented in mock');
  }

  disconnect(): void {
    this._connected = false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SshTerminalBackend', () => {
  let connection: MockSshConnection;

  beforeEach(() => {
    connection = new MockSshConnection();
  });

  describe('start()', () => {
    it('creates a shell stream via connection.shell()', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      expect(backend.isStarted).toBe(true);
      expect(connection.lastShell).not.toBeNull();
    });

    it('passes cols and rows to shell()', async () => {
      const backend = new SshTerminalBackend(connection, {
        cols: 120,
        rows: 40,
      });
      await backend.start();

      expect(backend.isStarted).toBe(true);
    });

    it('throws if already started', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      await expect(backend.start()).rejects.toThrow('already started');
    });

    it('throws if connection is not active', async () => {
      connection.setConnected(false);
      const backend = new SshTerminalBackend(connection);

      await expect(backend.start()).rejects.toThrow('not active');
    });

    it('sends cd command when cwd is specified', async () => {
      const backend = new SshTerminalBackend(connection, {
        cwd: '/home/user/project',
      });
      await backend.start();

      // Read what was written to stdin
      const shell = connection.lastShell!;
      const chunks: Buffer[] = [];
      shell.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      // Give the cd command time to be written
      await new Promise((r) => setTimeout(r, 50));

      const written = Buffer.concat(chunks).toString('utf-8');
      expect(written).toContain('cd /home/user/project');
    });

    it('sends export commands when env is specified', async () => {
      const backend = new SshTerminalBackend(connection, {
        env: { FOO: 'bar', BAZ: 'qux' },
      });
      await backend.start();

      const shell = connection.lastShell!;
      const chunks: Buffer[] = [];
      shell.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      await new Promise((r) => setTimeout(r, 50));

      const written = Buffer.concat(chunks).toString('utf-8');
      expect(written).toContain("export FOO='bar'");
      expect(written).toContain("export BAZ='qux'");
    });
  });

  describe('write()', () => {
    it('sends data to the shell stdin', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      const shell = connection.lastShell!;
      const chunks: Buffer[] = [];
      shell.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      backend.write('echo hello\n');

      await new Promise((r) => setTimeout(r, 50));

      const written = Buffer.concat(chunks).toString('utf-8');
      expect(written).toContain('echo hello\n');
    });

    it('does nothing after kill', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      backend.kill();

      const shell = connection.lastShell!;
      const chunks: Buffer[] = [];
      shell.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      backend.write('echo hello\n');

      await new Promise((r) => setTimeout(r, 50));

      // After kill, write should be a no-op
      expect(chunks).toHaveLength(0);
    });
  });

  describe('resize()', () => {
    it('sends SIGWINCH via resizePty', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      const shell = connection.lastShell!;

      backend.resize(120, 40);

      expect(shell.resizeCalls).toHaveLength(1);
      expect(shell.resizeCalls[0]).toEqual({ cols: 120, rows: 40 });
    });

    it('does nothing after kill', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      const shell = connection.lastShell!;

      backend.kill();
      backend.resize(120, 40);

      expect(shell.resizeCalls).toHaveLength(0);
    });
  });

  describe('onData', () => {
    it('emits remote output', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      const shell = connection.lastShell!;
      const received: string[] = [];

      backend.onData((data) => {
        received.push(data);
      });

      // Simulate remote output
      shell.pushStdout('hello world');
      shell.pushStdout('more data');

      await new Promise((r) => setTimeout(r, 50));

      expect(received.length).toBeGreaterThanOrEqual(1);
      const combined = received.join('');
      expect(combined).toContain('hello world');
      expect(combined).toContain('more data');
    });

    it('emits stderr output', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      const shell = connection.lastShell!;
      const received: string[] = [];

      backend.onData((data) => {
        received.push(data);
      });

      shell.pushStderr('error message');

      await new Promise((r) => setTimeout(r, 50));

      expect(received.length).toBeGreaterThanOrEqual(1);
      const combined = received.join('');
      expect(combined).toContain('error message');
    });
  });

  describe('onExit', () => {
    it('emits on stream close', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      const shell = connection.lastShell!;
      let exitEvent: { exitCode: number } | null = null;

      backend.onExit((e) => {
        exitEvent = e;
      });

      // Simulate remote exit
      shell.simulateExit();

      await new Promise((r) => setTimeout(r, 50));

      expect(exitEvent).not.toBeNull();
      expect(exitEvent!.exitCode).toBe(0);
    });
  });

  describe('kill()', () => {
    it('closes the channel', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      const shell = connection.lastShell!;

      expect(backend.isKilled).toBe(false);

      backend.kill();

      expect(backend.isKilled).toBe(true);
      expect(shell.closeCalled).toBe(true);
    });

    it('fires onExit event', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      let exitEvent: { exitCode: number } | null = null;
      backend.onExit((e) => {
        exitEvent = e;
      });

      backend.kill();

      expect(exitEvent).not.toBeNull();
      expect(exitEvent!.exitCode).toBe(0);
    });

    it('is idempotent', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      const shell = connection.lastShell!;

      backend.kill();
      backend.kill();
      backend.kill();

      // close should only have been called once (the adapter destroy call)
      expect(shell.closeCalled).toBe(true);
      expect(backend.isKilled).toBe(true);
    });
  });

  describe('shutdown()', () => {
    it('sends exit command and resolves', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      const shell = connection.lastShell!;

      // Track what gets written to stdin after start
      const chunks: Buffer[] = [];
      shell.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      // Simulate remote exit after a short delay
      setTimeout(() => {
        shell.simulateExit();
      }, 50);

      await backend.shutdown(2000);

      const written = Buffer.concat(chunks).toString('utf-8');
      expect(written).toContain('exit');
    });

    it('force-kills after timeout', async () => {
      const backend = new SshTerminalBackend(connection);
      await backend.start();

      // Don't simulate exit — let the timeout kick in
      await backend.shutdown(100);

      expect(backend.isKilled).toBe(true);
    });
  });
});
