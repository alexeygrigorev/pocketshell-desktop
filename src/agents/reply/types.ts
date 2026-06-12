/**
 * Reply types for the agent messaging system.
 *
 * These types support sending messages to running AI coding agents
 * (claude, codex, opencode) from the conversation view.
 */

// ---------------------------------------------------------------------------
// Agent type
// ---------------------------------------------------------------------------

/** Supported AI coding agent types. */
export type AgentType = 'claude' | 'codex' | 'opencode';

// ---------------------------------------------------------------------------
// Reply types
// ---------------------------------------------------------------------------

/** A reply message to be sent to a running agent session. */
export interface AgentReply {
  /** The agent session to send the message to. */
  sessionId: string;

  /** Which agent type to send to. */
  agentType: AgentType;

  /** The message content. */
  message: string;

  /** Epoch ms timestamp when the reply was created. */
  timestamp: number;
}

/** Result of attempting to send a reply to an agent. */
export interface ReplyResult {
  /** Whether the message was sent successfully. */
  success: boolean;

  /** Error message if the send failed. */
  error?: string;

  /** Immediate response from the agent, if any. */
  agentResponse?: string;
}
