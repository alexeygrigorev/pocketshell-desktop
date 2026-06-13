/**
 * Types for agent conversation model.
 *
 * Represents parsed conversation logs from various agent sessions
 * (Claude, Codex, OpenCode) as a uniform data model.
 */

// ---------------------------------------------------------------------------
// AgentType
// ---------------------------------------------------------------------------

/**
 * Supported AI coding agent types.
 *
 * Defined here as a string-literal union so the conversation module is
 * self-contained within the extension backend (the historical AgentType enum
 * lived in the desktop-app `src/agents/types.ts`, which is not part of the
 * extension). String-literal values are preserved exactly: 'claude' | 'codex'
 * | 'opencode'.
 */
export type AgentType = 'claude' | 'codex' | 'opencode';

// ---------------------------------------------------------------------------
// Conversation message
// ---------------------------------------------------------------------------

/**
 * A single message in an agent conversation.
 *
 * Covers user prompts, assistant replies, system messages, and tool
 * call/result pairs.
 */
export interface ConversationMessage {
  /** Unique message id within the session. */
  id: string;

  /** Who produced this message. */
  role: 'user' | 'assistant' | 'system' | 'tool';

  /** Text content of the message. */
  content: string;

  /** Unix timestamp (ms) when the message was produced. */
  timestamp: number;

  /** Token count if available from the log. */
  tokenCount?: number;

  /** Tool name — only set when role is 'tool'. */
  toolName?: string;

  /** Tool call arguments — only set when role is 'tool' (tool_use). */
  toolInput?: any;

  /** Tool result text — only set when role is 'tool' (tool_result). */
  toolOutput?: string;

  /** True if this is a partial / still-streaming message. */
  isStreaming?: boolean;
}

// ---------------------------------------------------------------------------
// Conversation session
// ---------------------------------------------------------------------------

/** Metadata about a session available before reading the full log. */
export interface SessionInfo {
  /** Unique session identifier. */
  id: string;

  /** Which agent produced this session. */
  agentType: AgentType;

  /** Remote file path of the session log. */
  path: string;

  /** File size in bytes. */
  size: number;

  /** Unix timestamp (ms) of last modification. */
  modifiedAt: number;
}

/**
 * A fully parsed agent conversation session.
 *
 * Contains all messages and aggregate metadata.
 */
export interface ConversationSession {
  /** Unique session identifier. */
  id: string;

  /** Which agent produced this session. */
  agentType: AgentType;

  /** Unix timestamp (ms) when the session started. */
  startedAt: number;

  /** Unix timestamp (ms) when the session ended, if known. */
  endedAt?: number;

  /** Total number of messages. */
  messageCount: number;

  /** Total tokens used, if available. */
  totalTokens?: number;

  /** Model name, if available from the log. */
  model?: string;

  /** All parsed messages in chronological order. */
  messages: ConversationMessage[];
}
