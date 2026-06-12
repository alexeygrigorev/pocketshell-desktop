/**
 * Unit tests for HookManager.
 *
 * Uses mocked SshConnection to verify that pocketshell hooks commands
 * are constructed correctly and output is parsed properly.
 */

import { describe, it, expect, vi } from 'vitest';
import { HookManager } from '../../../../src/agents/hooks/hook-manager';
import { HookType, type AgentType, type HookStatus } from '../../../../src/agents/hooks/types';
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

describe('HookManager', () => {
  const repoPath = '/home/testuser/git/test-project';

  describe('status', () => {
    it('returns hook config for repo', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks status', {
          stdout: 'claude: installed\ncodex: not installed\nopencode: error\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      const config = await manager.status(repoPath);

      expect(config.repoPath).toBe(repoPath);
      expect(config.hooks.length).toBeGreaterThan(0);

      // Should have entries for all 5 hook types x 3 agents = 15 hooks
      expect(config.hooks).toHaveLength(15);

      // Check claude hooks are installed
      const claudePreCommit = config.hooks.find(
        h => h.type === HookType.PreCommit && h.agentType === 'claude',
      );
      expect(claudePreCommit).toBeDefined();
      expect(claudePreCommit!.status).toBe('installed');
      expect(claudePreCommit!.isEnabled).toBe(true);
      expect(claudePreCommit!.scriptPath).toContain('.git/hooks/pre-commit');

      // Check codex hooks are not installed
      const codexPreCommit = config.hooks.find(
        h => h.type === HookType.PreCommit && h.agentType === 'codex',
      );
      expect(codexPreCommit).toBeDefined();
      expect(codexPreCommit!.status).toBe('not-installed');
      expect(codexPreCommit!.isEnabled).toBe(false);
      expect(codexPreCommit!.scriptPath).toBeUndefined();

      // Check opencode hooks are in error state
      const opencodePostMerge = config.hooks.find(
        h => h.type === HookType.PostMerge && h.agentType === 'opencode',
      );
      expect(opencodePostMerge).toBeDefined();
      expect(opencodePostMerge!.status).toBe('error');
      expect(opencodePostMerge!.isEnabled).toBe(false);
    });

    it('runs command in the repo directory', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks status', {
          stdout: 'claude: installed\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      await manager.status(repoPath);

      expect(conn.exec).toHaveBeenCalledWith(
        expect.stringContaining(`cd '${repoPath}'`),
      );
      expect(conn.exec).toHaveBeenCalledWith(
        expect.stringContaining('pocketshell hooks status'),
      );
    });

    it('handles missing repo gracefully', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks status', {
          stdout: '',
          stderr: 'fatal: not a git repository',
          exitCode: 128,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      const config = await manager.status('/nonexistent/path');

      expect(config.repoPath).toBe('/nonexistent/path');
      expect(config.hooks.length).toBeGreaterThan(0);

      // All hooks should be in error state
      for (const hook of config.hooks) {
        expect(hook.status).toBe('error');
        expect(hook.isEnabled).toBe(false);
      }
    });

    it('handles conflict status', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks status', {
          stdout: 'claude: conflict\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      const config = await manager.status(repoPath);

      const claudeHooks = config.hooks.filter(h => h.agentType === 'claude');
      for (const hook of claudeHooks) {
        expect(hook.status).toBe('conflict');
      }
    });

    it('handles not-installed with hyphen variant', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks status', {
          stdout: 'codex: not-installed\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      const config = await manager.status(repoPath);

      const codexHooks = config.hooks.filter(h => h.agentType === 'codex');
      for (const hook of codexHooks) {
        expect(hook.status).toBe('not-installed');
      }
    });
  });

  describe('install', () => {
    it('runs pocketshell hooks install with agent type', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks install', {
          stdout: 'Hooks installed for claude\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      await manager.install(repoPath, HookType.PreCommit, 'claude');

      expect(conn.exec).toHaveBeenCalledWith(
        expect.stringContaining('pocketshell hooks install claude'),
      );
      expect(conn.exec).toHaveBeenCalledWith(
        expect.stringContaining(`cd '${repoPath}'`),
      );
    });

    it('throws on non-zero exit code', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks install', {
          stdout: '',
          stderr: 'Error: agent not found',
          exitCode: 1,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      await expect(
        manager.install(repoPath, HookType.PreCommit, 'codex'),
      ).rejects.toThrow('pocketshell hooks install failed');
    });
  });

  describe('uninstall', () => {
    it('runs pocketshell hooks uninstall', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks uninstall', {
          stdout: 'Hooks removed\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      await manager.uninstall(repoPath, HookType.PreCommit);

      expect(conn.exec).toHaveBeenCalledWith(
        expect.stringContaining('pocketshell hooks uninstall'),
      );
      expect(conn.exec).toHaveBeenCalledWith(
        expect.stringContaining(`cd '${repoPath}'`),
      );
    });

    it('throws on non-zero exit code', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks uninstall', {
          stdout: '',
          stderr: 'Error: no hooks installed',
          exitCode: 1,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      await expect(
        manager.uninstall(repoPath, HookType.PostCommit),
      ).rejects.toThrow('pocketshell hooks uninstall failed');
    });
  });

  describe('enable', () => {
    it('runs pocketshell hooks install --enable', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks install --enable', {
          stdout: 'Hooks enabled\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      await manager.enable(repoPath, HookType.PrePush);

      expect(conn.exec).toHaveBeenCalledWith(
        expect.stringContaining('pocketshell hooks install --enable'),
      );
      expect(conn.exec).toHaveBeenCalledWith(
        expect.stringContaining(`cd '${repoPath}'`),
      );
    });

    it('throws on non-zero exit code', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks install --enable', {
          stdout: '',
          stderr: 'Error: hook not installed',
          exitCode: 1,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      await expect(
        manager.enable(repoPath, HookType.PrePush),
      ).rejects.toThrow('pocketshell hooks enable failed');
    });
  });

  describe('disable', () => {
    it('runs pocketshell hooks install --disable', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks install --disable', {
          stdout: 'Hooks disabled\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      await manager.disable(repoPath, HookType.CommitMsg);

      expect(conn.exec).toHaveBeenCalledWith(
        expect.stringContaining('pocketshell hooks install --disable'),
      );
      expect(conn.exec).toHaveBeenCalledWith(
        expect.stringContaining(`cd '${repoPath}'`),
      );
    });

    it('throws on non-zero exit code', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell hooks install --disable', {
          stdout: '',
          stderr: 'Error: hook not installed',
          exitCode: 1,
        }],
      ]);

      const conn = createMockConnection(responses);
      const manager = new HookManager(conn);
      await expect(
        manager.disable(repoPath, HookType.CommitMsg),
      ).rejects.toThrow('pocketshell hooks disable failed');
    });
  });
});
