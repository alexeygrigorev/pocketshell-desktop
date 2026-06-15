/**
 * Unit tests for GitClient.
 *
 * Uses mocked SshConnection to verify command construction
 * and output parsing without requiring a real SSH connection.
 */

import { describe, it, expect, vi } from 'vitest';
import { GitClient, GitNotRepositoryError } from '../../../src/git/git-client';
import type { SshConnection, ExecResult } from '../../../src/ssh/connection/ssh-client';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockConnection(
  responses: Map<string, ExecResult>,
): SshConnection {
  return {
    connected: true,
    exec: vi.fn(async (command: string): Promise<ExecResult> => {
      // Find a matching response by checking if the command contains the key
      for (const [key, result] of responses) {
        if (command.includes(key)) {
          return result;
        }
      }
      // Default response
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

describe('GitClient', () => {
  describe('status', () => {
    it('parses clean status output', async () => {
      const responses = new Map<string, ExecResult>([
        ['git status', {
          stdout: [
            '# branch.oid abc123',
            '# branch.head main',
            '# branch.ab +0 -0',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const status = await client.status('/home/user/repo');

      expect(status.branch).toBe('main');
      expect(status.isClean).toBe(true);
      expect(status.staged).toEqual([]);
      expect(status.unstaged).toEqual([]);
    });

    it('parses dirty status output', async () => {
      const responses = new Map<string, ExecResult>([
        ['git status', {
          stdout: [
            '# branch.oid abc123',
            '# branch.head feature',
            '# branch.ab +2 -1',
            '1 .M N... 100644 100644 100644 abc def file.txt',
            '? new-file.txt',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const status = await client.status('/home/user/repo');

      expect(status.branch).toBe('feature');
      expect(status.isClean).toBe(false);
      expect(status.unstaged).toEqual([
        { path: 'file.txt', status: 'modified' },
      ]);
      expect(status.untracked).toEqual(['new-file.txt']);
      expect(status.ahead).toBe(2);
      expect(status.behind).toBe(1);
    });

    it('throws on non-zero exit code', async () => {
      const responses = new Map<string, ExecResult>([
        ['git status', {
          stdout: '',
          stderr: 'fatal: not a git repository',
          exitCode: 128,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      await expect(client.status('/tmp')).rejects.toThrow('git status failed');
    });
  });

  describe('log', () => {
    it('returns commits', async () => {
      const responses = new Map<string, ExecResult>([
        ['git log', {
          stdout: [
            'ENDCOMMIT\x00',
            'fullhash123\x00',
            'short1\x00',
            'Alice\x00',
            'alice@test.com\x00',
            '2026-01-01T00:00:00Z\x00',
            'First commit\x00',
            '\x00',
          ].join(''),
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const commits = await client.log('/home/user/repo');

      expect(commits).toHaveLength(1);
      expect(commits[0].hash).toBe('fullhash123');
      expect(commits[0].shortHash).toBe('short1');
      expect(commits[0].author).toBe('Alice');
      expect(commits[0].subject).toBe('First commit');
      expect(conn.exec).toHaveBeenCalledWith(
        expect.stringContaining('--numstat'),
      );
    });

    it('returns empty array for empty log', async () => {
      const responses = new Map<string, ExecResult>([
        ['git log', {
          stdout: '',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const commits = await client.log('/home/user/repo');

      expect(commits).toEqual([]);
    });

    it('classifies non-repository log errors', async () => {
      const responses = new Map<string, ExecResult>([
        ['git log', {
          stdout: '',
          stderr: 'fatal: not a git repository (or any of the parent directories): .git',
          exitCode: 128,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);

      await expect(client.log('/tmp')).rejects.toBeInstanceOf(GitNotRepositoryError);
    });
  });

  describe('branches', () => {
    it('lists branches correctly', async () => {
      const responses = new Map<string, ExecResult>([
        ['git branch', {
          stdout: [
            '* main       7a3b2c1 [origin/main] Fix bug',
            '  feature    a1b2c3d [origin/feature] Add feature',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const branches = await client.branches('/home/user/repo');

      expect(branches).toHaveLength(2);
      expect(branches[0].name).toBe('main');
      expect(branches[0].isCurrent).toBe(true);
      expect(branches[0].tracking).toBe('origin/main');
      expect(branches[1].name).toBe('feature');
      expect(branches[1].isCurrent).toBe(false);
    });
  });

  describe('currentBranch', () => {
    it('returns branch name', async () => {
      const responses = new Map<string, ExecResult>([
        ['rev-parse', {
          stdout: 'main\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const branch = await client.currentBranch('/home/user/repo');

      expect(branch).toBe('main');
    });

    it('throws on non-zero exit code', async () => {
      const responses = new Map<string, ExecResult>([
        ['rev-parse', {
          stdout: '',
          stderr: 'fatal: not a git repository',
          exitCode: 128,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      await expect(
        client.currentBranch('/tmp'),
      ).rejects.toThrow('git current-branch failed');
    });
  });

  describe('clone', () => {
    it('runs git clone', async () => {
      const responses = new Map<string, ExecResult>([
        ['git clone', {
          stdout: 'Cloning into repo...',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      await client.clone('https://github.com/user/repo.git', '/home/user/repo');

      expect(conn.exec).toHaveBeenCalledWith(
        "git clone 'https://github.com/user/repo.git' '/home/user/repo'",
      );
    });
  });

  describe('checkout', () => {
    it('runs git checkout', async () => {
      const responses = new Map<string, ExecResult>([
        ['git checkout', {
          stdout: "Switched to branch 'feature'",
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      await client.checkout('/home/user/repo', 'feature');

      expect(conn.exec).toHaveBeenCalledWith(
        "cd '/home/user/repo' && git checkout 'feature'",
      );
    });
  });

  describe('show', () => {
    it('shows file at ref', async () => {
      const responses = new Map<string, ExecResult>([
        ['git show', {
          stdout: 'file contents here',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const content = await client.show('/home/user/repo', 'main', 'README.md');

      expect(content).toBe('file contents here');
    });
  });

  describe('blame', () => {
    it('runs git blame and parses output', async () => {
      const output = [
        'a1b2c3d4e5f6789012345678901234567890abcd 1 1 1',
        'author John Doe',
        'author-time 1705312200',
        '\tHello, world!',
      ].join('\n');

      const responses = new Map<string, ExecResult>([
        ['git blame', {
          stdout: output,
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const lines = await client.blame('/home/user/repo', 'file.txt');

      expect(lines).toHaveLength(1);
      expect(lines[0].author).toBe('John Doe');
      expect(lines[0].content).toBe('Hello, world!');
    });
  });

  describe('diff', () => {
    it('runs git diff', async () => {
      const responses = new Map<string, ExecResult>([
        ['git diff', {
          stdout: 'diff --git a/file b/file\n+added line',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const diff = await client.diff('/home/user/repo');

      expect(diff).toContain('added line');
    });

    it('runs cached diff with file', async () => {
      const responses = new Map<string, ExecResult>([
        ['git diff', {
          stdout: 'cached diff output',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const diff = await client.diff('/home/user/repo', {
        file: 'readme.md',
        cached: true,
      });

      expect(diff).toBe('cached diff output');
      expect(conn.exec).toHaveBeenCalledWith(
        expect.stringContaining('--cached'),
      );
    });
  });

  describe('fetch', () => {
    it('runs git fetch', async () => {
      const responses = new Map<string, ExecResult>([
        ['git fetch', {
          stdout: '',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      await client.fetch('/home/user/repo');

      expect(conn.exec).toHaveBeenCalledWith(
        "cd '/home/user/repo' && git fetch",
      );
    });

    it('runs git fetch with remote', async () => {
      const responses = new Map<string, ExecResult>([
        ['git fetch', {
          stdout: '',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      await client.fetch('/home/user/repo', 'origin');

      expect(conn.exec).toHaveBeenCalledWith(
        "cd '/home/user/repo' && git fetch 'origin'",
      );
    });
  });

  describe('pull', () => {
    it('parses pull output', async () => {
      const responses = new Map<string, ExecResult>([
        ['git pull', {
          stdout: [
            'Updating abc..def',
            'Fast-forward',
            ' file1.txt | 3 ++-',
            ' file2.txt | 10 +++++++++-',
            ' 2 files changed, 12 insertions(+), 1 deletion(-)',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const result = await client.pull('/home/user/repo');

      expect(result.updated).toContain('file1.txt');
      expect(result.updated).toContain('file2.txt');
      expect(result.insertions).toBe(12);
      expect(result.deletions).toBe(1);
    });
  });

  describe('exec', () => {
    it('runs command without cwd', async () => {
      const responses = new Map<string, ExecResult>([
        ['git version', {
          stdout: 'git version 2.40.0',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const result = await client.exec('git version');

      expect(result.stdout).toBe('git version 2.40.0');
      expect(conn.exec).toHaveBeenCalledWith('git version');
    });

    it('runs command with cwd', async () => {
      const responses = new Map<string, ExecResult>([
        ['git status', {
          stdout: 'output',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new GitClient(conn);
      const result = await client.exec('git status', '/repo');

      expect(conn.exec).toHaveBeenCalledWith(
        "cd '/repo' && git status",
      );
    });
  });
});
