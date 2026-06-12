/**
 * Unit tests for UsageClient.
 *
 * Uses a mocked SshConnection to verify command execution and
 * output parsing without a real SSH connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageClient } from '../../../../src/integrations/usage/usage-client';
import type { SshConnection, ExecResult } from '../../../../src/ssh/connection/ssh-client';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockConnection(execResult?: ExecResult): SshConnection {
  const exec = vi.fn().mockResolvedValue(
    execResult ?? {
      stdout: JSON.stringify({
        providers: [
          {
            provider: 'anthropic',
            tokens_used: 15000,
            tokens_limit: 100000,
            requests_used: 45,
            requests_limit: 500,
            cost_usd: 1.23,
            period: '2026-06',
          },
          {
            provider: 'openai',
            tokens_used: 8000,
            tokens_limit: 50000,
            requests_used: 20,
            requests_limit: 200,
            cost_usd: 0.87,
            period: '2026-06',
          },
        ],
        total_cost_usd: 2.10,
        currency: 'USD',
      }),
      stderr: '',
      exitCode: 0,
    },
  );

  return {
    connected: true,
    exec,
    shell: vi.fn(),
    sftp: vi.fn(),
    disconnect: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UsageClient', () => {
  let mockConnection: ReturnType<typeof createMockConnection>;
  let client: UsageClient;

  beforeEach(() => {
    mockConnection = createMockConnection();
    client = new UsageClient(mockConnection);
  });

  describe('getUsage', () => {
    it('returns usage summary', async () => {
      const summary = await client.getUsage();

      expect(summary.providers).toHaveLength(2);
      expect(summary.totalCostUsd).toBeCloseTo(2.10);
      expect(summary.currency).toBe('USD');
    });

    it('executes pocketshell usage --json', async () => {
      await client.getUsage();

      expect(mockConnection.exec).toHaveBeenCalledWith('pocketshell usage --json');
    });

    it('throws on non-zero exit code', async () => {
      mockConnection.exec = vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'command not found: pocketshell',
        exitCode: 127,
      });

      await expect(client.getUsage()).rejects.toThrow(
        'pocketshell usage failed (exit 127)',
      );
    });

    it('parses provider details correctly', async () => {
      const summary = await client.getUsage();
      const anthropic = summary.providers[0];

      expect(anthropic.provider).toBe('anthropic');
      expect(anthropic.tokensUsed).toBe(15000);
      expect(anthropic.tokensLimit).toBe(100000);
      expect(anthropic.requestsUsed).toBe(45);
      expect(anthropic.requestsLimit).toBe(500);
      expect(anthropic.costUsd).toBeCloseTo(1.23);
      expect(anthropic.period).toBe('2026-06');
      expect(anthropic.updatedAt).toBeGreaterThan(0);
    });
  });

  describe('getProviderUsage', () => {
    it('returns specific provider by name', async () => {
      const usage = await client.getProviderUsage('openai');

      expect(usage.provider).toBe('openai');
      expect(usage.tokensUsed).toBe(8000);
      expect(usage.tokensLimit).toBe(50000);
    });

    it('matches provider name case-insensitively', async () => {
      const usage = await client.getProviderUsage('Anthropic');

      expect(usage.provider).toBe('anthropic');
    });

    it('throws if provider not found', async () => {
      await expect(client.getProviderUsage('groq')).rejects.toThrow(
        "Provider 'groq' not found",
      );
    });

    it('lists available providers in error message', async () => {
      await expect(client.getProviderUsage('groq')).rejects.toThrow(
        'anthropic, openai',
      );
    });
  });
});
