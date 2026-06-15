/**
 * Unit tests for EnvClient.
 *
 * Uses mocked SshConnection to verify command construction
 * and output parsing without requiring a real SSH connection.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  EnvClient,
  detectSecret,
  envCopyDestinations,
  safeEnvValue,
  shellQuote,
} from '../../../../src/integrations/env/env-client';
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
  describe('safeEnvValue', () => {
    it('masks secret values for display', () => {
      expect(safeEnvValue({ key: 'API_KEY', value: 'actual-secret', isSecret: true })).toBe('***');
      expect(safeEnvValue({ key: 'DATABASE_URL', value: 'sqlite:///test.db', isSecret: false })).toBe('sqlite:///test.db');
    });
  });

  describe('shellQuote', () => {
    it('quotes values used in command generation', () => {
      expect(shellQuote("/home/alice/git/client's-api")).toBe("'/home/alice/git/client'\\''s-api'");
    });
  });

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

    it('uses folder path as scope when provided', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env list', {
          stdout: 'FOO=bar\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      await client.list('/home/alice/git/api');

      expect(conn.exec).toHaveBeenCalledWith(
        "pocketshell env list --scope '/home/alice/git/api'",
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

    it('sends get command with folder scope', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env get', {
          stdout: 'secret-value\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      const value = await client.get('API_KEY', '/home/alice/git/api');

      expect(value).toBe('secret-value');
      expect(conn.exec).toHaveBeenCalledWith(
        "pocketshell env get 'API_KEY' --scope '/home/alice/git/api'",
      );
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

    it('escapes key, value, and folder scope in set command', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env set', {
          stdout: 'ok\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      await client.set("CLIENT'S_KEY", "don't leak", "/home/alice/git/client's-api");

      expect(conn.exec).toHaveBeenCalledWith(
        "pocketshell env set 'CLIENT'\\''S_KEY' 'don'\\''t leak' --scope '/home/alice/git/client'\\''s-api'",
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

    it('sends unset command with folder scope', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell env unset', {
          stdout: 'ok\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new EnvClient(conn);
      await client.unset('MY_VAR', '/home/alice/git/api');

      expect(conn.exec).toHaveBeenCalledWith(
        "pocketshell env unset 'MY_VAR' --scope '/home/alice/git/api'",
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

  describe('copy', () => {
    it('offers copy destinations only from known enabled folders', () => {
      const destinations = envCopyDestinations([
        { label: 'api', path: '/home/alice/git/api', enabled: true },
        { label: 'web', path: '/home/alice/git/web', enabled: true },
        { label: 'disabled', path: '/home/alice/git/disabled', enabled: false },
      ], '/home/alice/git/api');

      expect(destinations).toEqual([
        { label: 'web', path: '/home/alice/git/web', enabled: true },
      ]);
    });

    it('copies selected keys between known folder scopes using real values', async () => {
      const commands: string[] = [];
      const conn = {
        connected: true,
        exec: vi.fn(async (command: string): Promise<ExecResult> => {
          commands.push(command);
          if (command === "pocketshell env list --scope '/home/alice/git/api'") {
            return {
              stdout: 'API_KEY=***\nDATABASE_URL=sqlite:///api.db\nSKIP_ME=unused\n',
              stderr: '',
              exitCode: 0,
            };
          }
          if (command === "pocketshell env get 'API_KEY' --scope '/home/alice/git/api'") {
            return { stdout: 'real-secret\n', stderr: '', exitCode: 0 };
          }
          if (command === "pocketshell env get 'DATABASE_URL' --scope '/home/alice/git/api'") {
            return { stdout: 'sqlite:///api.db\n', stderr: '', exitCode: 0 };
          }
          if (command.startsWith('pocketshell env set ')) {
            return { stdout: 'ok\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: `unexpected command: ${command}`, exitCode: 1 };
        }),
        shell: vi.fn(),
        sftp: vi.fn(),
        disconnect: vi.fn(),
      } as unknown as SshConnection;

      const client = new EnvClient(conn);
      const result = await client.copy(
        '/home/alice/git/api',
        '/home/alice/git/web',
        ['API_KEY', 'DATABASE_URL'],
      );

      expect(result).toEqual({ copied: ['API_KEY', 'DATABASE_URL'], skipped: [] });
      expect(commands).toEqual([
        "pocketshell env list --scope '/home/alice/git/api'",
        "pocketshell env get 'API_KEY' --scope '/home/alice/git/api'",
        "pocketshell env set 'API_KEY' 'real-secret' --scope '/home/alice/git/web'",
        "pocketshell env get 'DATABASE_URL' --scope '/home/alice/git/api'",
        "pocketshell env set 'DATABASE_URL' 'sqlite:///api.db' --scope '/home/alice/git/web'",
      ]);
    });

    it('rejects copying within the same folder scope', async () => {
      const conn = createMockConnection(new Map());
      const client = new EnvClient(conn);

      await expect(client.copy('/home/alice/git/api', '/home/alice/git/api')).rejects.toThrow(
        'Source and destination folders must be different',
      );
      expect(conn.exec).not.toHaveBeenCalled();
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
