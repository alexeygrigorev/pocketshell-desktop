/**
 * Unit tests for BootstrapManager.
 *
 * Uses a mocked SshConnection to simulate remote command execution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BootstrapManager } from '../../../../src/integrations/bootstrap/bootstrap-manager';
import type { SshConnection, ExecResult } from '../../../../src/ssh/connection/ssh-client';

// ---------------------------------------------------------------------------
// Mock SshConnection
// ---------------------------------------------------------------------------

/**
 * Build a mock SshConnection where every call to `exec` is routed through
 * the provided handler. The handler can return an ExecResult directly or
 * throw to simulate connection-level failures.
 */
function createMockConnection(
  handler: (command: string, timeout?: number) => ExecResult | Promise<ExecResult>,
): SshConnection {
  return {
    connected: true,
    exec: vi.fn((cmd: string, timeout?: number) => handler(cmd, timeout)),
    shell: vi.fn(),
    sftp: vi.fn(),
    disconnect: vi.fn(),
  };
}

/** Shorthand for a successful exec result. */
function ok(stdout: string, stderr = ''): ExecResult {
  return { stdout, stderr, exitCode: 0 };
}

/** Shorthand for a failing exec result. */
function fail(exitCode: number, stderr = ''): ExecResult {
  return { stdout: '', stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BootstrapManager', () => {
  let manager: BootstrapManager;
  let execHandler: ReturnType<typeof vi.fn>;

  function resetManager(
    handler: (command: string, timeout?: number) => ExecResult | Promise<ExecResult>,
  ): void {
    execHandler = vi.fn(handler);
    const conn = createMockConnection(execHandler);
    manager = new BootstrapManager(conn);
  }

  // -----------------------------------------------------------------------
  // detect()
  // -----------------------------------------------------------------------

  describe('detect', () => {
    it('returns installed status when pocketshell is present', async () => {
      resetManager((cmd) => {
        if (cmd.includes('which')) return ok('/usr/local/bin/pocketshell\n');
        if (cmd.includes('--version')) return ok('1.2.3\n');
        // fetchLatestVersion
        if (cmd.includes('get.pocketshell.dev/version')) return ok('1.3.0\n');
        return fail(1);
      });

      const status = await manager.detect();

      expect(status.isInstalled).toBe(true);
      expect(status.version).toBe('1.2.3');
      expect(status.binaryPath).toBe('/usr/local/bin/pocketshell');
      expect(status.needsUpdate).toBe(true);
      expect(status.latestVersion).toBe('1.3.0');
    });

    it('returns not-installed when pocketshell is absent', async () => {
      resetManager((cmd) => {
        if (cmd.includes('which')) return fail(1);
        if (cmd.includes('get.pocketshell.dev/version')) return ok('2.0.0\n');
        return fail(1);
      });

      const status = await manager.detect();

      expect(status.isInstalled).toBe(false);
      expect(status.needsUpdate).toBe(false);
      expect(status.latestVersion).toBe('2.0.0');
    });

    it('reports no update needed when versions match', async () => {
      resetManager((cmd) => {
        if (cmd.includes('which')) return ok('/usr/local/bin/pocketshell\n');
        if (cmd.includes('--version')) return ok('1.2.3\n');
        if (cmd.includes('get.pocketshell.dev/version')) return ok('1.2.3\n');
        return fail(1);
      });

      const status = await manager.detect();

      expect(status.isInstalled).toBe(true);
      expect(status.needsUpdate).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // install()
  // -----------------------------------------------------------------------

  describe('install', () => {
    it('succeeds via curl|sh when it works', async () => {
      let installAttempted = false;

      resetManager((cmd) => {
        // curl | sh install
        if (cmd.includes('get.pocketshell.dev') && !cmd.includes('version')) {
          installAttempted = true;
          return ok('');
        }
        // After install, detect the installed version
        if (cmd.includes('which') && installAttempted) return ok('/usr/local/bin/pocketshell\n');
        if (cmd.includes('--version') && installAttempted) return ok('1.3.0\n');
        // Before/during install, which may fail
        if (cmd.includes('which')) return fail(1);
        if (cmd.includes('--version')) return fail(1);
        return fail(1);
      });

      const result = await manager.install();

      expect(result.success).toBe(true);
      expect(result.version).toBe('1.3.0');
      expect(installAttempted).toBe(true);
    });

    it('falls back to pip when curl|sh fails', async () => {
      let pipAttempted = false;

      resetManager((cmd) => {
        // curl | sh fails
        if (cmd.includes('get.pocketshell.dev') && !cmd.includes('version') && !cmd.includes('pip')) {
          return fail(1, 'curl failed');
        }
        // pip install succeeds
        if (cmd.includes('pip install')) {
          pipAttempted = true;
          return ok('Successfully installed pocketshell-1.3.0');
        }
        // After install, detect the installed version
        if (cmd.includes('which')) return ok('/home/user/.local/bin/pocketshell\n');
        if (cmd.includes('--version')) return ok('1.3.0\n');
        return fail(1);
      });

      const result = await manager.install();

      expect(result.success).toBe(true);
      expect(pipAttempted).toBe(true);
    });

    it('returns error when all strategies fail', async () => {
      resetManager((cmd) => {
        // All install strategies fail
        if (cmd.includes('get.pocketshell.dev') && !cmd.includes('version') && !cmd.includes('pip')) {
          return fail(1, 'curl failed');
        }
        if (cmd.includes('pip install')) {
          return fail(1, 'pip failed');
        }
        if (cmd.includes('uname')) return ok('Linux x86_64');
        if (cmd.includes('curl') && cmd.includes('github.com')) return fail(1, 'download failed');
        // detectInstalled queries
        if (cmd.includes('which')) return fail(1);
        return fail(1);
      });

      const result = await manager.install();

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // upgrade()
  // -----------------------------------------------------------------------

  describe('upgrade', () => {
    it('upgrades from old version to new version', async () => {
      let upgraded = false;

      resetManager((cmd) => {
        // First detectInstalled (before upgrade)
        if (cmd.includes('which') && !upgraded) return ok('/usr/local/bin/pocketshell\n');
        if (cmd.includes('--version') && !upgraded) return ok('1.0.0\n');
        // fetchLatestVersion
        if (cmd.includes('get.pocketshell.dev/version')) return ok('2.0.0\n');
        // Install via curl|sh
        if (cmd.includes('get.pocketshell.dev') && !cmd.includes('version')) {
          upgraded = true;
          return ok('');
        }
        // Second detectInstalled (after install)
        if (cmd.includes('which') && upgraded) return ok('/usr/local/bin/pocketshell\n');
        if (cmd.includes('--version') && upgraded) return ok('2.0.0\n');
        return fail(1);
      });

      const result = await manager.upgrade();

      expect(result.success).toBe(true);
      expect(result.oldVersion).toBe('1.0.0');
      expect(result.newVersion).toBe('2.0.0');
    });

    it('returns error when pocketshell is not installed', async () => {
      resetManager((cmd) => {
        if (cmd.includes('which')) return fail(1);
        return fail(1);
      });

      const result = await manager.upgrade();

      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
    });

    it('returns error when install step fails', async () => {
      resetManager((cmd) => {
        // Detect finds existing install
        if (cmd.includes('which')) return ok('/usr/local/bin/pocketshell\n');
        if (cmd.includes('--version')) return ok('1.0.0\n');
        // fetchLatestVersion
        if (cmd.includes('get.pocketshell.dev/version')) return ok('2.0.0\n');
        // All install strategies fail
        if (cmd.includes('get.pocketshell.dev') && !cmd.includes('version')) return fail(1, 'curl fail');
        if (cmd.includes('pip install')) return fail(1, 'pip fail');
        if (cmd.includes('uname')) return ok('Linux x86_64');
        if (cmd.includes('github.com')) return fail(1, 'download fail');
        return fail(1);
      });

      const result = await manager.upgrade();

      expect(result.success).toBe(false);
      expect(result.oldVersion).toBe('1.0.0');
      expect(result.error).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // uninstall()
  // -----------------------------------------------------------------------

  describe('uninstall', () => {
    it('removes detected binary and attempts pip uninstall', async () => {
      const commands: string[] = [];

      resetManager((cmd) => {
        commands.push(cmd);
        if (cmd.includes('which')) return ok('/usr/local/bin/pocketshell\n');
        if (cmd.includes('--version')) return ok('1.0.0\n');
        // rm and pip uninstall
        return ok('');
      });

      await manager.uninstall();

      // Should have removed the detected binary
      expect(commands.some((c) => c.includes('rm -f'))).toBe(true);
      expect(commands.some((c) => c.includes('pip uninstall'))).toBe(true);
    });

    it('still attempts pip uninstall even when binary not found', async () => {
      const commands: string[] = [];

      resetManager((cmd) => {
        commands.push(cmd);
        if (cmd.includes('which')) return fail(1);
        return ok('');
      });

      await manager.uninstall();

      expect(commands.some((c) => c.includes('pip uninstall'))).toBe(true);
    });

    it('does not throw even when commands fail', async () => {
      resetManager((_cmd) => {
        throw new Error('connection lost');
      });

      // Should resolve without throwing
      await expect(manager.uninstall()).resolves.toBeUndefined();
    });
  });
});
