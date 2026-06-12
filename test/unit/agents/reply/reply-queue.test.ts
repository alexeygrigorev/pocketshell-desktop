/**
 * Unit tests for ReplyQueue.
 *
 * Verifies queuing behavior, sequential processing, and event emission.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplyQueue } from '../../../../src/agents/reply/reply-queue';
import { AgentMessenger } from '../../../../src/agents/reply/agent-messenger';
import type { ReplyResult } from '../../../../src/agents/reply/types';
import type { AgentReply } from '../../../../src/agents/reply/types';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockMessenger(): {
  messenger: AgentMessenger;
  sendMock: ReturnType<typeof vi.fn>;
} {
  const sendMock = vi.fn();
  const messenger = {
    send: sendMock,
  } as unknown as AgentMessenger;

  return { messenger, sendMock };
}

/** Create a successful ReplyResult. */
function successResult(agentResponse?: string): ReplyResult {
  return { success: true, agentResponse };
}

/** Create a failed ReplyResult. */
function failResult(error: string): ReplyResult {
  return { success: false, error };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReplyQueue', () => {
  let mockBundle: ReturnType<typeof createMockMessenger>;
  let queue: ReplyQueue;

  beforeEach(() => {
    mockBundle = createMockMessenger();
    queue = new ReplyQueue(mockBundle.messenger);
  });

  // -------------------------------------------------------------------------
  // Enqueue
  // -------------------------------------------------------------------------

  describe('enqueue', () => {
    it('immediately dispatches to messenger when idle', () => {
      // Make send hang so processing stays in flight
      mockBundle.sendMock.mockReturnValue(new Promise(() => {}));

      queue.enqueue('sess-1', 'claude', 'Hello');

      // First message was shifted from pending and handed to messenger
      expect(queue.isProcessing).toBe(true);
      expect(mockBundle.sendMock).toHaveBeenCalledOnce();
      expect(mockBundle.sendMock).toHaveBeenCalledWith('sess-1', 'claude', 'Hello');
    });

    it('queues additional messages when already processing', async () => {
      // First send takes a moment
      let resolveFirst: (value: ReplyResult) => void;
      const firstPromise = new Promise<ReplyResult>((resolve) => {
        resolveFirst = resolve;
      });
      mockBundle.sendMock.mockReturnValueOnce(firstPromise);
      mockBundle.sendMock.mockResolvedValue(successResult());

      queue.enqueue('sess-1', 'claude', 'First');
      queue.enqueue('sess-1', 'claude', 'Second');

      // First is being processed, second is pending
      expect(queue.isProcessing).toBe(true);
      expect(queue.pending.length).toBe(1);
      expect(queue.pending[0].message).toBe('Second');
      expect(queue.pending[0].timestamp).toBeGreaterThan(0);

      // Complete first send
      resolveFirst!(successResult());
      // Allow microtasks to flush
      await vi.waitFor(() => {
        expect(queue.isProcessing).toBe(false);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Sequential processing
  // -------------------------------------------------------------------------

  describe('processNext', () => {
    it('sends one message at a time', async () => {
      let resolveFirst: (value: ReplyResult) => void;
      const firstPromise = new Promise<ReplyResult>((resolve) => {
        resolveFirst = resolve;
      });
      mockBundle.sendMock.mockReturnValueOnce(firstPromise);
      mockBundle.sendMock.mockResolvedValue(successResult());

      queue.enqueue('sess-1', 'claude', 'A');
      queue.enqueue('sess-1', 'claude', 'B');

      // Only first send called so far
      expect(mockBundle.sendMock).toHaveBeenCalledOnce();
      expect(queue.isProcessing).toBe(true);

      // Complete first
      resolveFirst!(successResult());
      await vi.waitFor(() => {
        expect(mockBundle.sendMock).toHaveBeenCalledTimes(2);
      });
    });

    it('processes queued messages sequentially', async () => {
      mockBundle.sendMock.mockResolvedValue(successResult());

      queue.enqueue('sess-1', 'claude', 'A');
      queue.enqueue('sess-1', 'codex', 'B');
      queue.enqueue('sess-1', 'opencode', 'C');

      await vi.waitFor(() => {
        expect(queue.pending.length).toBe(0);
        expect(queue.isProcessing).toBe(false);
      });

      expect(mockBundle.sendMock).toHaveBeenCalledTimes(3);
      expect(mockBundle.sendMock).toHaveBeenNthCalledWith(1, 'sess-1', 'claude', 'A');
      expect(mockBundle.sendMock).toHaveBeenNthCalledWith(2, 'sess-1', 'codex', 'B');
      expect(mockBundle.sendMock).toHaveBeenNthCalledWith(3, 'sess-1', 'opencode', 'C');
    });

    it('handles failure and continues with next message', async () => {
      mockBundle.sendMock
        .mockResolvedValueOnce(failResult('Agent not responding'))
        .mockResolvedValueOnce(successResult());

      queue.enqueue('sess-1', 'claude', 'Failing');
      queue.enqueue('sess-1', 'claude', 'Succeeding');

      await vi.waitFor(() => {
        expect(queue.pending.length).toBe(0);
        expect(queue.isProcessing).toBe(false);
      });

      expect(mockBundle.sendMock).toHaveBeenCalledTimes(2);
    });

    it('does nothing when queue is empty', async () => {
      await queue.processNext();

      expect(mockBundle.sendMock).not.toHaveBeenCalled();
      expect(queue.isProcessing).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  describe('onReplySent', () => {
    it('fires on successful send', async () => {
      mockBundle.sendMock.mockResolvedValue(successResult('response text'));

      const sentReplies: AgentReply[] = [];
      queue.onReplySent.listen((reply) => sentReplies.push(reply));

      queue.enqueue('sess-1', 'claude', 'Hello');

      await vi.waitFor(() => {
        expect(sentReplies.length).toBe(1);
      });

      expect(sentReplies[0].sessionId).toBe('sess-1');
      expect(sentReplies[0].message).toBe('Hello');
    });
  });

  describe('onReplyFailed', () => {
    it('fires on send error', async () => {
      mockBundle.sendMock.mockResolvedValue(failResult('Agent crashed'));

      const failures: { reply: AgentReply; error: Error }[] = [];
      queue.onReplyFailed.listen((evt) => failures.push(evt));

      queue.enqueue('sess-1', 'codex', 'Hello');

      await vi.waitFor(() => {
        expect(failures.length).toBe(1);
      });

      expect(failures[0].reply.message).toBe('Hello');
      expect(failures[0].error.message).toContain('Agent crashed');
    });

    it('fires on send exception', async () => {
      mockBundle.sendMock.mockRejectedValue(new Error('Network error'));

      const failures: { reply: AgentReply; error: Error }[] = [];
      queue.onReplyFailed.listen((evt) => failures.push(evt));

      queue.enqueue('sess-1', 'claude', 'Hello');

      await vi.waitFor(() => {
        expect(failures.length).toBe(1);
      });

      expect(failures[0].error.message).toContain('Network error');
    });
  });
});
