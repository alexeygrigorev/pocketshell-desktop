/**
 * Unit tests for AgentDetector.
 *
 * Uses a mocked SshConnection to test agent detection logic without
 * requiring an actual SSH connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentDetector, parseVersion } from '../../../src/agents/agent-detector';
import { AgentType } from '../../../src/agents/types';
import type { SshConnection, ExecResult } from '../../../src/ssh/connection/ssh-client';

// ---------------------------------------------------------------------------
// Mock SshConnection
// ---------------------------------------------------------------------------

/** Command -> result mapping for the mock. */
type CommandResults = Map<string, ExecResult | ((cmd: string) => ExecResult)>;

function createMockConnection(commands: CommandResults): SshConnection {
  return {
    connected: true,
    async exec(command: string, _timeout?: number): Promise<ExecResult> {
      const mapped = commands.get(command);
      if (!mapped) {
        return { stdout: '', stderr: 'command not found', exitCode: 127 };
      }
      if (typeof mapped === 'function') {
        return mapped(command);
      }
      return mapped;
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

describe('AgentDetector', () => {
  describe('detectOne', () => {
    it('detects Claude from which + version output', async () => {
      const commands = new Map<string, ExecResult>([
        ['which claude 2>/dev/null', { stdout: '/usr/local/bin/claude\n', stderr: '', exitCode: 0 }],
        ['claude --version 2>/dev/null', { stdout: 'Claude Code 1.0.3\n', stderr: '', exitCode: 0 }],
      ]);

      const detector = new AgentDetector(createMockConnection(commands));
      const result = await detector.detectOne(AgentType.Claude);

      expect(result).not.toBeNull();
      expect(result!.type).toBe(AgentType.Claude);
      expect(result!.name).toBe('Claude Code');
      expect(result!.binaryPath).toBe('/usr/local/bin/claude');
      expect(result!.version).toBe('1.0.3');
      expect(result!.isInstalled).toBe(true);
      expect(result!.detectedAt).toBeGreaterThan(0);
    });

    it('detects Codex from which + version output', async () => {
      const commands = new Map<string, ExecResult>([
        ['which codex 2>/dev/null', { stdout: '/home/user/.local/bin/codex\n', stderr: '', exitCode: 0 }],
        ['codex --version 2>/dev/null', { stdout: 'codex 0.1.0\n', stderr: '', exitCode: 0 }],
      ]);

      const detector = new AgentDetector(createMockConnection(commands));
      const result = await detector.detectOne(AgentType.Codex);

      expect(result).not.toBeNull();
      expect(result!.type).toBe(AgentType.Codex);
      expect(result!.name).toBe('Codex');
      expect(result!.binaryPath).toBe('/home/user/.local/bin/codex');
      expect(result!.version).toBe('0.1.0');
      expect(result!.isInstalled).toBe(true);
    });

    it('detects OpenCode from which + version output', async () => {
      const commands = new Map<string, ExecResult>([
        ['which opencode 2>/dev/null', { stdout: '/usr/bin/opencode\n', stderr: '', exitCode: 0 }],
        ['opencode --version 2>/dev/null', { stdout: 'opencode v0.2.1-dev\n', stderr: '', exitCode: 0 }],
      ]);

      const detector = new AgentDetector(createMockConnection(commands));
      const result = await detector.detectOne(AgentType.OpenCode);

      expect(result).not.toBeNull();
      expect(result!.type).toBe(AgentType.OpenCode);
      expect(result!.name).toBe('OpenCode');
      expect(result!.binaryPath).toBe('/usr/bin/opencode');
      expect(result!.version).toBe('0.2.1-dev');
      expect(result!.isInstalled).toBe(true);
    });

    it('returns not-installed for missing agents', async () => {
      // No commands mapped — which returns exit code 127
      const commands = new Map<string, ExecResult>();

      const detector = new AgentDetector(createMockConnection(commands));
      const result = await detector.detectOne(AgentType.Claude);

      expect(result).not.toBeNull();
      expect(result!.type).toBe(AgentType.Claude);
      expect(result!.isInstalled).toBe(false);
      expect(result!.binaryPath).toBeUndefined();
      expect(result!.version).toBeUndefined();
    });

    it('returns null for AgentType.Unknown', async () => {
      const commands = new Map<string, ExecResult>();
      const detector = new AgentDetector(createMockConnection(commands));
      const result = await detector.detectOne(AgentType.Unknown);

      expect(result).toBeNull();
    });

    it('handles exec error gracefully', async () => {
      const brokenConnection: SshConnection = {
        connected: true,
        async exec() {
          throw new Error('Connection lost');
        },
        async shell() { throw new Error('Not implemented'); },
        async sftp() { throw new Error('Not implemented'); },
        disconnect() {},
      };

      const detector = new AgentDetector(brokenConnection);
      const result = await detector.detectOne(AgentType.Claude);

      expect(result).not.toBeNull();
      expect(result!.isInstalled).toBe(false);
    });
  });

  describe('detectAll', () => {
    it('detects all installed agents', async () => {
      const commands = new Map<string, ExecResult>([
        ['which claude 2>/dev/null', { stdout: '/usr/local/bin/claude\n', stderr: '', exitCode: 0 }],
        ['claude --version 2>/dev/null', { stdout: 'Claude Code 1.0.3\n', stderr: '', exitCode: 0 }],
        ['which codex 2>/dev/null', { stdout: '/usr/local/bin/codex\n', stderr: '', exitCode: 0 }],
        ['codex --version 2>/dev/null', { stdout: 'codex 0.1.0\n', stderr: '', exitCode: 0 }],
        ['which opencode 2>/dev/null', { stdout: '/usr/local/bin/opencode\n', stderr: '', exitCode: 0 }],
        ['opencode --version 2>/dev/null', { stdout: 'opencode 0.5.0\n', stderr: '', exitCode: 0 }],
      ]);

      const detector = new AgentDetector(createMockConnection(commands));
      const results = await detector.detectAll();

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.isInstalled)).toBe(true);

      const types = results.map((r) => r.type).sort();
      expect(types).toEqual([AgentType.Claude, AgentType.Codex, AgentType.OpenCode]);
    });

    it('returns partial results when only some agents are installed', async () => {
      const commands = new Map<string, ExecResult>([
        ['which claude 2>/dev/null', { stdout: '/usr/local/bin/claude\n', stderr: '', exitCode: 0 }],
        ['claude --version 2>/dev/null', { stdout: 'Claude Code 2.0.0\n', stderr: '', exitCode: 0 }],
        // codex and opencode: not mapped → which fails
      ]);

      const detector = new AgentDetector(createMockConnection(commands));
      const results = await detector.detectAll();

      expect(results).toHaveLength(3);

      const installed = results.filter((r) => r.isInstalled);
      expect(installed).toHaveLength(1);
      expect(installed[0].type).toBe(AgentType.Claude);

      const notInstalled = results.filter((r) => !r.isInstalled);
      expect(notInstalled).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// parseVersion tests
// ---------------------------------------------------------------------------

describe('parseVersion', () => {
  it('extracts version from "Claude Code 1.0.3"', () => {
    const result = parseVersion({ stdout: 'Claude Code 1.0.3\n', stderr: '', exitCode: 0 });
    expect(result).toBe('1.0.3');
  });

  it('extracts version from "codex 0.1.0"', () => {
    const result = parseVersion({ stdout: 'codex 0.1.0', stderr: '', exitCode: 0 });
    expect(result).toBe('0.1.0');
  });

  it('extracts version from "opencode v0.2.1-dev"', () => {
    const result = parseVersion({ stdout: 'opencode v0.2.1-dev', stderr: '', exitCode: 0 });
    expect(result).toBe('0.2.1-dev');
  });

  it('extracts version from bare "1.2.3"', () => {
    const result = parseVersion({ stdout: '1.2.3', stderr: '', exitCode: 0 });
    expect(result).toBe('1.2.3');
  });

  it('extracts version from "version: 1.2.3"', () => {
    const result = parseVersion({ stdout: 'version: 1.2.3', stderr: '', exitCode: 0 });
    expect(result).toBe('1.2.3');
  });

  it('extracts version from multi-line output', () => {
    const result = parseVersion({
      stdout: 'Some Agent Name\nVersion: 3.14.159\nBuild: abc123\n',
      stderr: '',
      exitCode: 0,
    });
    expect(result).toBe('3.14.159');
  });

  it('returns undefined for empty output', () => {
    const result = parseVersion({ stdout: '', stderr: '', exitCode: 0 });
    expect(result).toBeUndefined();
  });

  it('returns undefined for output without a version pattern', () => {
    const result = parseVersion({ stdout: 'no version info here', stderr: '', exitCode: 0 });
    expect(result).toBeUndefined();
  });

  it('handles malformed version output gracefully', () => {
    const result = parseVersion({ stdout: 'lol!@#$', stderr: '', exitCode: 0 });
    expect(result).toBeUndefined();
  });

  it('extracts version from fixture-style output', () => {
    const result = parseVersion({ stdout: 'Claude Code fixture 0.0.0\n', stderr: '', exitCode: 0 });
    expect(result).toBe('0.0.0');
  });
});
