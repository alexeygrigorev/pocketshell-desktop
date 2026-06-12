/**
 * Unit tests for PocketshellAgentDetector.
 *
 * Uses a mocked SshConnection to test pocketshell-based agent detection
 * and fallback behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PocketshellAgentDetector } from '../../../src/agents/pocketshell-detector';
import { AgentType } from '../../../src/agents/types';
import type { SshConnection, ExecResult } from '../../../src/ssh/connection/ssh-client';

// ---------------------------------------------------------------------------
// Mock SshConnection builder
// ---------------------------------------------------------------------------

/**
 * Builds a mock SshConnection that returns configurable results for each command.
 *
 * Command matching is prefix-based: the first command whose key is a prefix
 * of the actual command wins.
 */
function createMockConnection(
  commandMap: Map<string, ExecResult>,
): SshConnection {
  return {
    connected: true,
    async exec(command: string, _timeout?: number): Promise<ExecResult> {
      // Exact match first
      const exact = commandMap.get(command);
      if (exact) return exact;

      // Prefix match
      for (const [prefix, result] of commandMap) {
        if (command.startsWith(prefix)) {
          return result;
        }
      }

      // Default: command not found
      return { stdout: '', stderr: 'command not found', exitCode: 127 };
    },
    async shell() {
      throw new Error('Not implemented in mock');
    },
    async sftp() {
      throw new Error('Not implemented in mock');
    },
    disconnect() {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PocketshellAgentDetector', () => {
  describe('pocketshell available — parses agent-log output', () => {
    it('detects agents via pocketshell agent-log', async () => {
      const commands = new Map<string, ExecResult>([
        // pocketshell is available
        ['which pocketshell 2>/dev/null', { stdout: '/usr/local/bin/pocketshell\n', stderr: '', exitCode: 0 }],
        // agent-log results
        ['pocketshell agent-log --json --engine claude', {
          stdout: '{"count":42,"engine":"claude","path":"/home/testuser/.claude/projects/-workspace-pocketshell/pocketshell-claude.jsonl","session":""}\n',
          stderr: '',
          exitCode: 0,
        }],
        ['pocketshell agent-log --json --engine codex', {
          stdout: '{"count":10,"engine":"codex","path":"/home/testuser/.codex/sessions/2026/05/22/pocketshell-codex.jsonl","session":""}\n',
          stderr: '',
          exitCode: 0,
        }],
        ['pocketshell agent-log --json --engine opencode', {
          stdout: '{"count":5,"engine":"opencode","path":"/home/testuser/.local/share/opencode/pocketshell-rows.jsonl","session":""}\n',
          stderr: '',
          exitCode: 0,
        }],
        // version enrichment
        ['claude --version 2>/dev/null', { stdout: 'Claude Code 1.0.3\n', stderr: '', exitCode: 0 }],
        ['codex --version 2>/dev/null', { stdout: 'codex 0.1.0\n', stderr: '', exitCode: 0 }],
        ['opencode --version 2>/dev/null', { stdout: 'opencode v0.2.1-dev\n', stderr: '', exitCode: 0 }],
        // binary path enrichment
        ['which claude 2>/dev/null', { stdout: '/usr/local/bin/claude\n', stderr: '', exitCode: 0 }],
        ['which codex 2>/dev/null', { stdout: '/usr/local/bin/codex\n', stderr: '', exitCode: 0 }],
        ['which opencode 2>/dev/null', { stdout: '/usr/local/bin/opencode\n', stderr: '', exitCode: 0 }],
      ]);

      const detector = new PocketshellAgentDetector(createMockConnection(commands));
      const results = await detector.detect();

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.isInstalled)).toBe(true);

      const claude = results.find((r) => r.type === AgentType.Claude)!;
      expect(claude.name).toBe('Claude Code');
      expect(claude.version).toBe('1.0.3');
      expect(claude.binaryPath).toBe('/usr/local/bin/claude');

      const codex = results.find((r) => r.type === AgentType.Codex)!;
      expect(codex.version).toBe('0.1.0');

      const opencode = results.find((r) => r.type === AgentType.OpenCode)!;
      expect(opencode.version).toBe('0.2.1-dev');
    });

    it('reports agent as not installed when pocketshell agent-log fails', async () => {
      const commands = new Map<string, ExecResult>([
        ['which pocketshell 2>/dev/null', { stdout: '/usr/local/bin/pocketshell\n', stderr: '', exitCode: 0 }],
        // Claude succeeds
        ['pocketshell agent-log --json --engine claude', {
          stdout: '{"count":1,"engine":"claude","path":"/some/path","session":""}\n',
          stderr: '',
          exitCode: 0,
        }],
        // Codex fails (not in map → exit code 127)
        // OpenCode fails
        // version enrichment for claude
        ['claude --version 2>/dev/null', { stdout: 'Claude Code 2.0.0\n', stderr: '', exitCode: 0 }],
        ['which claude 2>/dev/null', { stdout: '/usr/bin/claude\n', stderr: '', exitCode: 0 }],
      ]);

      const detector = new PocketshellAgentDetector(createMockConnection(commands));
      const results = await detector.detect();

      expect(results).toHaveLength(3);

      const installed = results.filter((r) => r.isInstalled);
      expect(installed).toHaveLength(1);
      expect(installed[0].type).toBe(AgentType.Claude);

      const notInstalled = results.filter((r) => !r.isInstalled);
      expect(notInstalled).toHaveLength(2);
      expect(notInstalled.map((r) => r.type).sort()).toEqual([AgentType.Codex, AgentType.OpenCode]);
    });
  });

  describe('pocketshell not available — falls back to manual detection', () => {
    it('falls back to AgentDetector when pocketshell is absent', async () => {
      const commands = new Map<string, ExecResult>([
        // which pocketshell fails
        ['which claude 2>/dev/null', { stdout: '/usr/local/bin/claude\n', stderr: '', exitCode: 0 }],
        ['claude --version 2>/dev/null', { stdout: 'Claude Code 1.0.3\n', stderr: '', exitCode: 0 }],
        // codex and opencode: not in map
      ]);

      const detector = new PocketshellAgentDetector(createMockConnection(commands));
      const results = await detector.detect();

      // Fallback uses AgentDetector: claude detected, codex/opencode not
      expect(results).toHaveLength(3);

      const claude = results.find((r) => r.type === AgentType.Claude)!;
      expect(claude.isInstalled).toBe(true);
      expect(claude.version).toBe('1.0.3');

      const notInstalled = results.filter((r) => !r.isInstalled);
      expect(notInstalled).toHaveLength(2);
    });

    it('returns all not-installed when nothing is available', async () => {
      // Empty command map — everything fails
      const commands = new Map<string, ExecResult>();
      const detector = new PocketshellAgentDetector(createMockConnection(commands));
      const results = await detector.detect();

      expect(results).toHaveLength(3);
      expect(results.every((r) => !r.isInstalled)).toBe(true);
    });
  });

  describe('exec errors', () => {
    it('handles connection errors gracefully', async () => {
      const brokenConnection: SshConnection = {
        connected: true,
        async exec() {
          throw new Error('Connection lost');
        },
        async shell() { throw new Error('Not implemented'); },
        async sftp() { throw new Error('Not implemented'); },
        disconnect() {},
      };

      const detector = new PocketshellAgentDetector(brokenConnection);
      const results = await detector.detect();

      // All agents should be reported as not-installed
      expect(results).toHaveLength(3);
      expect(results.every((r) => !r.isInstalled)).toBe(true);
    });
  });
});
