/**
 * Unit tests for AgentMessenger.
 *
 * Uses a mocked SshConnection to verify agent-specific send strategies
 * and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentMessenger } from '../../../../src/agents/reply/agent-messenger';
import type { SshConnection } from '../../../../src/ssh/connection/ssh-client';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockConnection(): {
  connection: SshConnection;
  execMock: ReturnType<typeof vi.fn>;
} {
  const execMock = vi.fn();
  const connection: SshConnection = {
    connected: true,
    exec: execMock,
    shell: vi.fn(),
    sftp: vi.fn(),
    disconnect: vi.fn(),
  };
  return { connection, execMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentMessenger', () => {
  let mockBundle: ReturnType<typeof createMockConnection>;
  let messenger: AgentMessenger;

  beforeEach(() => {
    mockBundle = createMockConnection();
    messenger = new AgentMessenger(mockBundle.connection);
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it('rejects empty messages', async () => {
    const result = await messenger.send('session-1', 'claude', '');
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('rejects whitespace-only messages', async () => {
    const result = await messenger.send('session-1', 'claude', '   ');
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });

  // -------------------------------------------------------------------------
  // Claude
  // -------------------------------------------------------------------------

  describe('claude', () => {
    it('sends message via stdin pipe to claude --resume', async () => {
      mockBundle.execMock.mockResolvedValue({
        stdout: 'Claude response text',
        stderr: '',
        exitCode: 0,
      });

      const result = await messenger.send('sess-abc', 'claude', 'Fix the bug');

      expect(result.success).toBe(true);
      expect(result.agentResponse).toBe('Claude response text');
      expect(mockBundle.execMock).toHaveBeenCalledOnce();

      const command: string = mockBundle.execMock.mock.calls[0][0];
      expect(command).toContain('claude --resume');
      expect(command).toContain('sess-abc');
    });

    it('handles claude command failure', async () => {
      mockBundle.execMock.mockResolvedValue({
        stdout: '',
        stderr: 'Session not found',
        exitCode: 1,
      });

      const result = await messenger.send('sess-bad', 'claude', 'Hello');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Session not found');
    });
  });

  // -------------------------------------------------------------------------
  // Codex
  // -------------------------------------------------------------------------

  describe('codex', () => {
    it('sends message by writing to codex input file', async () => {
      mockBundle.execMock.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await messenger.send('sess-cx1', 'codex', 'Run tests');

      expect(result.success).toBe(true);
      expect(mockBundle.execMock).toHaveBeenCalledOnce();

      const command: string = mockBundle.execMock.mock.calls[0][0];
      expect(command).toContain('.codex/sessions/sess-cx1/input');
    });

    it('handles codex write failure', async () => {
      mockBundle.execMock.mockResolvedValue({
        stdout: '',
        stderr: 'Permission denied',
        exitCode: 1,
      });

      const result = await messenger.send('sess-cx1', 'codex', 'Hello');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });
  });

  // -------------------------------------------------------------------------
  // OpenCode
  // -------------------------------------------------------------------------

  describe('opencode', () => {
    it('sends message by writing to opencode input pipe', async () => {
      mockBundle.execMock.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await messenger.send('sess-oc1', 'opencode', 'Explain code');

      expect(result.success).toBe(true);
      expect(mockBundle.execMock).toHaveBeenCalledOnce();

      const command: string = mockBundle.execMock.mock.calls[0][0];
      expect(command).toContain('/tmp/opencode-sess-oc1.input');
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('handles send failure gracefully', async () => {
      mockBundle.execMock.mockRejectedValue(new Error('Connection lost'));

      const result = await messenger.send('sess-1', 'claude', 'Hello');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection lost');
    });

    it('returns error when SSH connection is not active', async () => {
      const disconnectedBundle = createMockConnection();
      (disconnectedBundle.connection as any).connected = false;

      const disconnectedMessenger = new AgentMessenger(disconnectedBundle.connection);
      const result = await disconnectedMessenger.send('sess-1', 'claude', 'Hello');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not active');
      expect(disconnectedBundle.execMock).not.toHaveBeenCalled();
    });
  });
});
