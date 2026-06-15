/**
 * Unit tests for PocketShellRepos adapter.
 *
 * Uses mocked SshConnection to verify pocketshell repos subcommands.
 */

import { describe, it, expect, vi } from 'vitest';
import { PocketShellRepos } from '../../../src/git/pocketshell-repos';
import type { SshConnection, ExecResult } from '../../../src/ssh/connection/ssh-client';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

interface MockCall {
  command: string;
}

function createMockConnection(
  handler: (command: string) => ExecResult,
): { connection: SshConnection; calls: MockCall[] } {
  const calls: MockCall[] = [];

  const connection: SshConnection = {
    connected: true,
    exec: vi.fn(async (command: string): Promise<ExecResult> => {
      calls.push({ command });
      return handler(command);
    }),
    shell: vi.fn(),
    sftp: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as SshConnection;

  return { connection, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PocketShellRepos', () => {
  describe('list', () => {
    it('returns repos from pocketshell repos list', async () => {
      const { connection, calls } = createMockConnection((cmd) => {
        if (cmd.includes('pocketshell repos list')) {
          return {
            stdout: '/home/testuser/git/repo1\n/home/testuser/git/repo2\n',
            stderr: '',
            exitCode: 0,
          };
        }
        if (cmd.includes('rev-parse')) {
          return {
            stdout: 'main\n',
            stderr: '',
            exitCode: 0,
          };
        }
        if (cmd.includes('git status')) {
          return {
            stdout: '# branch.oid abc\n# branch.head main\n# branch.ab +0 -0\n',
            stderr: '',
            exitCode: 0,
          };
        }
        if (cmd.includes('remote get-url')) {
          return {
            stdout: '',
            stderr: 'fatal: no such remote',
            exitCode: 128,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const repos = new PocketShellRepos(connection);
      const result = await repos.list();

      expect(result).toHaveLength(2);
      expect(result[0].path).toBe('/home/testuser/git/repo1');
      expect(result[0].name).toBe('repo1');
      expect(result[0].headBranch).toBe('main');
      expect(result[0].isDirty).toBe(false);
      expect(result[1].path).toBe('/home/testuser/git/repo2');
      expect(result[1].name).toBe('repo2');

      // Verify pocketshell repos list was called
      const listCall = calls.find((c) =>
        c.command.includes('pocketshell repos list'),
      );
      expect(listCall).toBeDefined();
    });

    it('returns empty array when no repos', async () => {
      const { connection } = createMockConnection(() => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      const repos = new PocketShellRepos(connection);
      const result = await repos.list();

      expect(result).toEqual([]);
    });

    it('throws when pocketshell repos list fails', async () => {
      const { connection } = createMockConnection(() => ({
        stdout: '',
        stderr: 'pocketshell: unknown command',
        exitCode: 1,
      }));

      const repos = new PocketShellRepos(connection);
      await expect(repos.list()).rejects.toThrow('pocketshell repos list failed');
    });

    it('merges remote GitHub repos with local cloned repos', async () => {
      const { connection, calls } = createMockConnection((cmd) => {
        if (cmd === 'pocketshell repos list --remote --json') {
          return {
            stdout: JSON.stringify([
              {
                owner: 'alice',
                name: 'api',
                full_name: 'alice/api',
                local: null,
                remote: {
                  default_branch: 'main',
                  html_url: 'https://github.com/alice/api',
                  ssh_url: 'git@github.com:alice/api.git',
                  updated_at: '2026-01-02T00:00:00Z',
                },
              },
              {
                owner: 'alice',
                name: 'web',
                full_name: 'alice/web',
                local: null,
                remote: { default_branch: 'main', updated_at: '2026-01-03T00:00:00Z' },
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (cmd === 'pocketshell repos list --local --json') {
          return {
            stdout: JSON.stringify([
              {
                owner: 'alice',
                name: 'api',
                full_name: 'alice/api',
                local: { path: '/home/alice/git/api', head: 'main' },
                remote: null,
              },
              {
                owner: null,
                name: 'internal',
                full_name: null,
                local: { path: '/home/alice/git/internal', head: 'main' },
                remote: null,
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const result = await new PocketShellRepos(connection).browse();

      expect(result).toEqual([
        expect.objectContaining({
          fullName: 'alice/api',
          cloned: true,
          path: '/home/alice/git/api',
        }),
        expect.objectContaining({
          fullName: 'internal',
          cloned: true,
          path: '/home/alice/git/internal',
        }),
        expect.objectContaining({
          fullName: 'alice/web',
          cloned: false,
          path: undefined,
        }),
      ]);
      expect(calls.map((call) => call.command)).toContain('pocketshell repos list --remote --json');
      expect(calls.map((call) => call.command)).toContain('pocketshell repos list --local --json');
    });
  });

  describe('clone and open', () => {
    it('clones into the selected root and returns the printed path', async () => {
      const { connection, calls } = createMockConnection((cmd) => {
        if (cmd.includes('pocketshell repos clone')) {
          return {
            stdout: '/home/alice/src/api\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const path = await new PocketShellRepos(connection).clone(
        'alice/api',
        "/home/alice/my repos",
      );

      expect(path).toBe('/home/alice/src/api');
      expect(calls[0].command).toBe(
        "pocketshell repos clone 'alice/api' --root '/home/alice/my repos' --protocol ssh",
      );
    });

    it('opens an existing clone by repository full name', async () => {
      const { connection, calls } = createMockConnection((cmd) => {
        if (cmd.includes('pocketshell repos open')) {
          return {
            stdout: '/home/alice/git/api\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const path = await new PocketShellRepos(connection).open('alice/api');

      expect(path).toBe('/home/alice/git/api');
      expect(calls[0].command).toBe("pocketshell repos open 'alice/api'");
    });
  });

  describe('register', () => {
    it('runs pocketshell repos add with path', async () => {
      const { connection, calls } = createMockConnection(() => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      const repos = new PocketShellRepos(connection);
      await repos.register('/home/user/my-repo');

      const addCall = calls.find((c) =>
        c.command.includes('pocketshell repos add'),
      );
      expect(addCall).toBeDefined();
      expect(addCall!.command).toContain("'/home/user/my-repo'");
    });

    it('throws when add fails', async () => {
      const { connection } = createMockConnection((cmd) => {
        if (cmd.includes('repos add')) {
          return { stdout: '', stderr: 'Error: not a git repo', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const repos = new PocketShellRepos(connection);
      await expect(
        repos.register('/tmp/not-a-repo'),
      ).rejects.toThrow('pocketshell repos add failed');
    });
  });

  describe('unregister', () => {
    it('runs pocketshell repos remove with path', async () => {
      const { connection, calls } = createMockConnection(() => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      const repos = new PocketShellRepos(connection);
      await repos.unregister('/home/user/my-repo');

      const removeCall = calls.find((c) =>
        c.command.includes('pocketshell repos remove'),
      );
      expect(removeCall).toBeDefined();
      expect(removeCall!.command).toContain("'/home/user/my-repo'");
    });

    it('throws when remove fails', async () => {
      const { connection } = createMockConnection((cmd) => {
        if (cmd.includes('repos remove')) {
          return { stdout: '', stderr: 'Error: not found', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const repos = new PocketShellRepos(connection);
      await expect(
        repos.unregister('/nonexistent'),
      ).rejects.toThrow('pocketshell repos remove failed');
    });
  });

  describe('status', () => {
    it('returns repo info for a path', async () => {
      const { connection } = createMockConnection((cmd) => {
        if (cmd.includes('rev-parse')) {
          return { stdout: 'main\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('git status')) {
          return {
            stdout: '# branch.oid abc\n# branch.head main\n# branch.ab +0 -0\n',
            stderr: '',
            exitCode: 0,
          };
        }
        if (cmd.includes('remote get-url')) {
          return {
            stdout: 'https://github.com/user/repo.git\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const repos = new PocketShellRepos(connection);
      const info = await repos.status('/home/user/repo');

      expect(info.path).toBe('/home/user/repo');
      expect(info.name).toBe('repo');
      expect(info.headBranch).toBe('main');
      expect(info.isDirty).toBe(false);
      expect(info.remoteUrl).toBe('https://github.com/user/repo.git');
    });
  });
});
