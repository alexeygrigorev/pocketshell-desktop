/**
 * Unit tests for EnvClient.
 *
 * Uses mocked SshConnection to verify command construction
 * and output parsing without requiring a real SSH connection.
 */

import { describe, it, expect, vi } from 'vitest';
import { EnvClient, detectSecret } from '../../../../src/integrations/env/env-client';
import type { SshConnection, ExecResult } from '../../../../src/ssh/connection/ssh-client';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockConnection(
  responses: Map<string, ExecResult>,
): SshConnection {
  return {
    connected: true,
    exec: vi.fn(async (command: string): Promise<ExecResult> => {
      for (const [key, result] of responses) {
        if (command.includes(key)) {
          return result;
        }
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    shell: vi.fn(),
    sftp: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as SshConnection;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnvClient', () => {
  describe('list', () => {
    it('returns parsed env vars', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env list', {
          stdout: 'API_KEY=***\nDATABASE_URL=sqlite:///test.db\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      const vars = await client.list();

      expect(vars).toHaveLength(2);
      expect(vars[0].key).toBe('API_KEY');
      expect(vars[0].value).toBe('***');
      expect(vars[0].isSecret).toBe(true);
      expect(vars[1].key).toBe('DATABASE_URL');
      expect(vars[1].value).toBe('sqlite:///test.db');
      expect(vars[1].isSecret).toBe(false);
    });

    it('appends scope when provided', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env list', {
          stdout: 'FOO=bar\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      await client.list('project');

      expect(conn.exec).toHaveBeenCalledWith(
        "pocketshell env list --scope 'project'",
      );
    });

    it('throws on non-zero exit code', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env list', {
          stdout: '',
          stderr: 'error: failed to list env vars',
          exitCode: 1,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      await expect(client.list()).rejects.toThrow('pocketshell env list failed');
    });

    it('handles empty output', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env list', {
          stdout: '',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      const vars = await client.list();

      expect(vars).toEqual([]);
    });
  });

  describe('get', () => {
    it('returns variable value', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env get', {
          stdout: 'sqlite:///test.db\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      const value = await client.get('DATABASE_URL');

      expect(value).toBe('sqlite:///test.db');
    });

    it('returns undefined when variable not found', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env get', {
          stdout: '',
          stderr: 'not found',
          exitCode: 1,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      const value = await client.get('NONEXISTENT');

      expect(value).toBeUndefined();
    });
  });

  describe('set', () => {
    it('sends set command', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env set', {
          stdout: 'ok\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      await client.set('MY_VAR', 'my_value');

      expect(conn.exec).toHaveBeenCalledWith(
        "pocketshell env set 'MY_VAR' 'my_value'",
      );
    });

    it('sends set command with scope', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env set', {
          stdout: 'ok\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      await client.set('MY_VAR', 'my_value', 'project');

      expect(conn.exec).toHaveBeenCalledWith(
        "pocketshell env set 'MY_VAR' 'my_value' --scope 'project'",
      );
    });

    it('throws on non-zero exit code', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env set', {
          stdout: '',
          stderr: 'error: invalid key',
          exitCode: 1,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      await expect(client.set('BAD!', 'value')).rejects.toThrow('pocketshell env set failed');
    });
  });

  describe('unset', () => {
    it('sends unset command', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env unset', {
          stdout: 'ok\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      await client.unset('MY_VAR');

      expect(conn.exec).toHaveBeenCalledWith(
        "pocketshell env unset 'MY_VAR'",
      );
    });

    it('sends unset command with scope', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env unset', {
          stdout: 'ok\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      await client.unset('MY_VAR', 'session');

      expect(conn.exec).toHaveBeenCalledWith(
        "pocketshell env unset 'MY_VAR' --scope 'session'",
      );
    });

    it('throws on non-zero exit code', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env unset', {
          stdout: '',
          stderr: 'error: not found',
          exitCode: 1,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      await expect(client.unset('NONEXISTENT')).rejects.toThrow('pocketshell env unset failed');
    });
  });

  describe('detectSecret', () => {
    it('detects KEY in variable name', () => {
      expect(detectSecret('API_KEY', 'abc123')).toBe(true);
      expect(detectSecret('SSH_KEY', 'value')).toBe(true);
      expect(detectSecret('PRIVATE_KEY_FILE', '/path')).toBe(true);
    });

    it('detects SECRET in variable name', () => {
      expect(detectSecret('CLIENT_SECRET', 'abc')).toBe(true);
      expect(detectSecret('SECRET_TOKEN', 'val')).toBe(true);
    });

    it('detects TOKEN in variable name', () => {
      expect(detectSecret('ACCESS_TOKEN', 'tok')).toBe(true);
      expect(detectSecret('REFRESH_TOKEN', 'tok')).toBe(true);
    });

    it('detects PASSWORD in variable name', () => {
      expect(detectSecret('DB_PASSWORD', 'pass')).toBe(true);
      expect(detectSecret('PASSWORD', 'secret')).toBe(true);
    });

    it('detects API in variable name', () => {
      expect(detectSecret('API_KEY', 'key')).toBe(true);
      expect(detectSecret('API_ENDPOINT', 'url')).toBe(true);
    });

    it('returns false for non-secret variable names', () => {
      expect(detectSecret('DATABASE_URL', 'sqlite:///test.db')).toBe(false);
      expect(detectSecret('NODE_ENV', 'production')).toBe(false);
      expect(detectSecret('PORT', '3000')).toBe(false);
      expect(detectSecret('HOME', '/home/user')).toBe(false);
    });
  });
});
