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

    it('reports a clear message when the remote pocketshell CLI is not installed', async () => {
      const { connection } = createMockConnection(() => ({
        stdout: '',
        stderr: 'bash: pocketshell: command not found',
        exitCode: 127,
      }));

      const repos = new PocketShellRepos(connection);
      await expect(repos.list()).rejects.toThrow(
        /'pocketshell' CLI is not installed or not on PATH on the remote host/,
      );
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

  // -------------------------------------------------------------------------
  // Remote exec wiring: pin the exact `pocketshell repos ...` command string
  // issued over the SSH connection. These prove the GitHub-integration flows
  // run over the remote connection (issue #83), not locally.
  // -------------------------------------------------------------------------

  describe('remote exec wiring', () => {
    it('listRemote issues pocketshell repos list --remote --json over the connection', async () => {
      const { connection, calls } = createMockConnection((cmd) => {
        if (cmd === 'pocketshell repos list --remote --json') {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      await new PocketShellRepos(connection).listRemote();

      expect(calls).toEqual([{ command: 'pocketshell repos list --remote --json' }]);
    });

    it('listRemote forwards limit as a remote --limit argument', async () => {
      const { connection, calls } = createMockConnection((cmd) => {
        if (cmd.startsWith('pocketshell repos list --remote')) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      await new PocketShellRepos(connection).listRemote({ limit: 42 });

      expect(calls[0].command).toBe('pocketshell repos list --remote --json --limit 42');
    });

    it('listLocal issues pocketshell repos list --local --json over the connection', async () => {
      const { connection, calls } = createMockConnection((cmd) => {
        if (cmd === 'pocketshell repos list --local --json') {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      await new PocketShellRepos(connection).listLocal();

      expect(calls).toEqual([{ command: 'pocketshell repos list --local --json' }]);
    });

    it('listLocal forwards root as a quoted remote --root argument', async () => {
      const { connection, calls } = createMockConnection((cmd) => {
        if (cmd.startsWith('pocketshell repos list --local')) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      await new PocketShellRepos(connection).listLocal({ root: '/srv/with space' });

      expect(calls[0].command).toBe("pocketshell repos list --local --json --root '/srv/with space'");
    });

    it('clone issues pocketshell repos clone over the connection with ssh protocol', async () => {
      const { connection, calls } = createMockConnection((cmd) => {
        if (cmd.startsWith('pocketshell repos clone')) {
          return { stdout: '/srv/src/api\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const path = await new PocketShellRepos(connection).clone('alice/api', '/srv/src');

      expect(path).toBe('/srv/src/api');
      expect(calls[0].command).toBe(
        "pocketshell repos clone 'alice/api' --root '/srv/src' --protocol ssh",
      );
    });

    it('open issues pocketshell repos open over the connection', async () => {
      const { connection, calls } = createMockConnection((cmd) => {
        if (cmd.startsWith('pocketshell repos open')) {
          return { stdout: '/home/alice/git/api\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const path = await new PocketShellRepos(connection).open('alice/api');

      expect(path).toBe('/home/alice/git/api');
      expect(calls[0].command).toBe("pocketshell repos open 'alice/api'");
    });

    it('list issues a single pocketshell repos list (no flags) over the connection', async () => {
      const { connection, calls } = createMockConnection(() => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      await new PocketShellRepos(connection).list();

      const listCall = calls.find((c) => c.command === 'pocketshell repos list');
      expect(listCall).toBeDefined();
      // No flag-bearing variant should leak in for the plain list call.
      expect(calls.some((c) => c.command.includes('--remote') || c.command.includes('--local'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Robustness: actionable errors for the common remote failure modes.
  // -------------------------------------------------------------------------

  describe('remote failure messages', () => {
    it('listRemote reports missing pocketshell CLI', async () => {
      const { connection } = createMockConnection(() => ({
        stdout: '',
        stderr: 'sh: pocketshell: not found',
        exitCode: 127,
      }));

      await expect(new PocketShellRepos(connection).listRemote()).rejects.toThrow(
        /'pocketshell' CLI is not installed or not on PATH on the remote host/,
      );
    });

    it('listRemote reports missing gh CLI', async () => {
      const { connection } = createMockConnection(() => ({
        stdout: '',
        stderr: 'gh: command not found',
        exitCode: 1,
      }));

      await expect(new PocketShellRepos(connection).listRemote()).rejects.toThrow(
        /GitHub CLI \('gh'\) is not installed on the remote host/,
      );
    });

    // Regression: a thin remote `pocketshell` wrapper may propagate exit 127
    // when its child `gh` is absent. The user must see the gh-missing message,
    // NOT the pocketshell-missing one.
    it('listRemote reports missing gh CLI even when the wrapper propagates exit 127', async () => {
      const { connection } = createMockConnection(() => ({
        stdout: '',
        stderr: 'gh: command not found',
        exitCode: 127,
      }));

      const promise = new PocketShellRepos(connection).listRemote();
      await expect(promise).rejects.toThrow(
        /GitHub CLI \('gh'\) is not installed on the remote host/,
      );
      await expect(promise).rejects.not.toThrow(
        /'pocketshell' CLI is not installed/,
      );
    });

    it('listRemote reports gh not authenticated', async () => {
      const { connection } = createMockConnection(() => ({
        stdout: '',
        stderr: 'error: you are not logged in. Run gh auth login.',
        exitCode: 1,
      }));

      await expect(new PocketShellRepos(connection).listRemote()).rejects.toThrow(
        /GitHub is not authenticated on the remote host/,
      );
    });

    it('clone surfaces a normal failure message for other errors', async () => {
      const { connection } = createMockConnection(() => ({
        stdout: '',
        stderr: 'repository not found',
        exitCode: 1,
      }));

      await expect(
        new PocketShellRepos(connection).clone('alice/missing', '/srv/src'),
      ).rejects.toThrow('pocketshell repos clone failed: repository not found');
    });

    it('throws on an empty clone path even with exit code 0', async () => {
      const { connection } = createMockConnection(() => ({
        stdout: '   \n  ',
        stderr: '',
        exitCode: 0,
      }));

      await expect(
        new PocketShellRepos(connection).clone('alice/empty', '/srv/src'),
      ).rejects.toThrow('pocketshell repos returned an empty path');
    });
  });
});
