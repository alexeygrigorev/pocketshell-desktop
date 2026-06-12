/**
 * Reply Queue — queues and dispatches agent replies one at a time.
 *
 * Ensures only one outstanding message is in flight per queue at a time.
 * When an agent is busy processing a message, new replies are queued and
 * sent sequentially after the current one completes.
 */

import type { AgentReply, ReplyResult } from './types';
import type { AgentType } from './types';
import type { AgentMessenger } from './agent-messenger';
import { SimpleEvent, type Event } from './event';

// ---------------------------------------------------------------------------
// ReplyQueue
// ---------------------------------------------------------------------------

export class ReplyQueue {
  private _pending: AgentReply[] = [];
  private _isProcessing = false;

  private readonly _onReplySent = new SimpleEvent<AgentReply>();
  private readonly _onReplyFailed = new SimpleEvent<{
    reply: AgentReply;
    error: Error;
  }>();

  constructor(private messenger: AgentMessenger) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Pending messages waiting to be sent. */
  get pending(): ReadonlyArray<AgentReply> {
    return this._pending;
  }

  /** Whether a message is currently being sent. */
  get isProcessing(): boolean {
    return this._isProcessing;
  }

  /** Fired when a reply is sent successfully. */
  get onReplySent(): Event<AgentReply> {
    return this._onReplySent;
  }

  /** Fired when a reply fails to send. */
  get onReplyFailed(): Event<{ reply: AgentReply; error: Error }> {
    return this._onReplyFailed;
  }

  /**
   * Enqueue a reply for sending.
   *
   * If no message is currently in flight, sending starts immediately.
   * Otherwise the message is queued and will be sent when the current
   * one completes.
   */
  enqueue(sessionId: string, agentType: AgentType, message: string): void {
    const reply: AgentReply = {
      sessionId,
      agentType,
      message,
      timestamp: Date.now(),
    };

    this._pending.push(reply);

    // Kick off processing if idle
    if (!this._isProcessing) {
      this.processNext();
    }
  }

  /**
   * Send the next queued message.
   *
   * Called automatically after enqueue and after each message completes.
   * Does nothing if the queue is empty or if a message is already in flight.
   */
  async processNext(): Promise<void> {
    if (this._isProcessing || this._pending.length === 0) {
      return;
    }

    this._isProcessing = true;

    const reply = this._pending.shift()!;

    try {
      const result: ReplyResult = await this.messenger.send(
        reply.sessionId,
        reply.agentType,
        reply.message,
      );

      if (result.success) {
        this._onReplySent.emit(reply);
      } else {
        this._onReplyFailed.emit({
          reply,
          error: new Error(result.error ?? 'Unknown send failure'),
        });
      }
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error(String(err));
      this._onReplyFailed.emit({ reply, error });
    } finally {
      this._isProcessing = false;

      // Process remaining messages
      if (this._pending.length > 0) {
        this.processNext();
      }
    }
  }
}
