/**
 * Unit tests for TerminalManager.
 *
 * Uses the same mock SshConnection pattern as ssh-terminal-backend.test.ts
 * to verify:
 *   - createTerminal creates and tracks terminals
 *   - listTerminals returns all terminals
 *   - getTerminal returns by ID
 *   - closeTerminal removes a terminal
 *   - closeAll cleans up everything
 *   - duplicate IDs are prevented (unique IDs assigned)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TerminalManager, resetIdCounter } from '../../../src/terminal/terminal-manager';
import type { SshConnection, SshShell } from '../../../src/ssh/connection/ssh-client';
import * as stream from 'stream';

// ---------------------------------------------------------------------------
// Mock SshShell (minimal, for connection.shell())
// ---------------------------------------------------------------------------

class MockSshShell implements SshShell {
  stdin = new stream.PassThrough();
  stdout = new stream.PassThrough();
  stderr = new stream.PassThrough();
  closeCalled = false;

  resizePty(): void {}

  close(): void {
    this.closeCalled = true;
    this.stdout.destroy();
    this.stderr.destroy();
    this.stdin.end();
  }
}

// ---------------------------------------------------------------------------
// Mock SshConnection
// ---------------------------------------------------------------------------

class MockSshConnection implements SshConnection {
  private _connected = true;
  shells: MockSshShell[] = [];

  get connected(): boolean {
    return this._connected;
  }

  async exec(): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    throw new Error('Not implemented in mock');
  }

  async shell(): Promise<SshShell> {
    const shell = new MockSshShell();
    this.shells.push(shell);
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

describe('TerminalManager', () => {
  let manager: TerminalManager;
  let connection: MockSshConnection;

  beforeEach(() => {
    resetIdCounter();
    manager = new TerminalManager();
    connection = new MockSshConnection();
  });

  describe('createTerminal()', () => {
    it('creates a terminal and returns handle', async () => {
      const terminal = await manager.createTerminal(1, connection);

      expect(terminal.id).toBe('ssh-term-1');
      expect(terminal.hostId).toBe(1);
      expect(terminal.name).toBe('Terminal ssh-term-1');
      expect(terminal.isActive).toBe(true);
      expect(terminal.createdAt).toBeGreaterThan(0);
      expect(terminal.backend).toBeDefined();
      expect(terminal.backend.isStarted).toBe(true);
    });

    it('uses custom name from options', async () => {
      const terminal = await manager.createTerminal(1, connection, {
        name: 'My Terminal',
      });

      expect(terminal.name).toBe('My Terminal');
    });

    it('increments IDs for multiple terminals', async () => {
      const t1 = await manager.createTerminal(1, connection);
      const t2 = await manager.createTerminal(1, connection);
      const t3 = await manager.createTerminal(2, connection);

      expect(t1.id).toBe('ssh-term-1');
      expect(t2.id).toBe('ssh-term-2');
      expect(t3.id).toBe('ssh-term-3');
    });

    it('opens a shell on the connection', async () => {
      await manager.createTerminal(1, connection);
      await manager.createTerminal(1, connection);

      expect(connection.shells).toHaveLength(2);
    });
  });

  describe('listTerminals()', () => {
    it('returns empty array initially', () => {
      expect(manager.listTerminals()).toEqual([]);
    });

    it('returns all created terminals', async () => {
      await manager.createTerminal(1, connection);
      await manager.createTerminal(2, connection);

      const list = manager.listTerminals();
      expect(list).toHaveLength(2);
      expect(list.map((t) => t.hostId).sort()).toEqual([1, 2]);
    });
  });

  describe('getTerminal()', () => {
    it('returns undefined for unknown ID', () => {
      expect(manager.getTerminal('nonexistent')).toBeUndefined();
    });

    it('returns terminal by ID', async () => {
      const created = await manager.createTerminal(1, connection);
      const found = manager.getTerminal(created.id);

      expect(found).toBe(created);
    });
  });

  describe('closeTerminal()', () => {
    it('removes a terminal by ID', async () => {
      const t1 = await manager.createTerminal(1, connection);
      const t2 = await manager.createTerminal(1, connection);

      manager.closeTerminal(t1.id);

      expect(manager.getTerminal(t1.id)).toBeUndefined();
      expect(manager.getTerminal(t2.id)).toBeDefined();
      expect(manager.listTerminals()).toHaveLength(1);
    });

    it('kills the backend', async () => {
      const terminal = await manager.createTerminal(1, connection);

      expect(terminal.backend.isKilled).toBe(false);

      manager.closeTerminal(terminal.id);

      expect(terminal.backend.isKilled).toBe(true);
      expect(terminal.isActive).toBe(false);
    });

    it('is a no-op for unknown ID', () => {
      expect(() => manager.closeTerminal('nonexistent')).not.toThrow();
    });

    it('is a no-op if already closed', async () => {
      const terminal = await manager.createTerminal(1, connection);

      manager.closeTerminal(terminal.id);
      manager.closeTerminal(terminal.id);

      // Should not throw, terminal is gone
      expect(manager.getTerminal(terminal.id)).toBeUndefined();
    });
  });

  describe('closeAll()', () => {
    it('closes and removes all terminals', async () => {
      const t1 = await manager.createTerminal(1, connection);
      const t2 = await manager.createTerminal(2, connection);
      const t3 = await manager.createTerminal(1, connection);

      manager.closeAll();

      expect(manager.listTerminals()).toHaveLength(0);
      expect(t1.backend.isKilled).toBe(true);
      expect(t2.backend.isKilled).toBe(true);
      expect(t3.backend.isKilled).toBe(true);
    });

    it('works when no terminals exist', () => {
      expect(() => manager.closeAll()).not.toThrow();
    });
  });

  describe('count', () => {
    it('tracks the number of terminals', async () => {
      expect(manager.count).toBe(0);

      await manager.createTerminal(1, connection);
      expect(manager.count).toBe(1);

      await manager.createTerminal(1, connection);
      expect(manager.count).toBe(2);

      const list = manager.listTerminals();
      manager.closeTerminal(list[0].id);
      expect(manager.count).toBe(1);

      manager.closeAll();
      expect(manager.count).toBe(0);
    });
  });

  describe('unique IDs', () => {
    it('each terminal gets a unique ID', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const terminal = await manager.createTerminal(1, connection);
        ids.add(terminal.id);
      }

      expect(ids.size).toBe(10);
    });
  });
});
