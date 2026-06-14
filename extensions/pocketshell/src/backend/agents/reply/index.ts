/**
 * Reply module for PocketShell Desktop.
 *
 * Exposes the AgentMessenger (sends messages to running AI coding agents
 * over SSH) and the ReplyQueue (serializes outgoing replies one at a time).
 */

export { AgentMessenger } from './agent-messenger';
export { ReplyQueue } from './reply-queue';
export { SimpleEvent } from './event';
export type { Event } from './event';
export type { AgentType, AgentReply, ReplyResult } from './types';
