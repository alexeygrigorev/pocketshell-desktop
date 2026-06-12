/**
 * Agent Messenger — sends messages to running AI coding agent sessions.
 *
 * Supports Claude, Codex, and OpenCode via agent-specific send strategies.
 * Each strategy dispatches the message through the appropriate mechanism
 * over an SSH connection.
 */

import type { SshConnection, ExecResult } from '../../ssh/connection/ssh-client';
import type { AgentType, ReplyResult } from './types';

// ---------------------------------------------------------------------------
// AgentMessenger
// ---------------------------------------------------------------------------

export class AgentMessenger {
  constructor(private connection: SshConnection) {}

  /**
   * Send a message to a running agent session.
   *
   * Dispatches to the appropriate agent-specific strategy.
   *
   * @throws Error if the message is empty
   */
  async send(
    sessionId: string,
    agentType: AgentType,
    message: string,
  ): Promise<ReplyResult> {
    // Validate message
    if (!message || message.trim().length === 0) {
      return { success: false, error: 'Message must not be empty' };
    }

    if (!this.connection.connected) {
      return { success: false, error: 'SSH connection is not active' };
    }

    try {
      switch (agentType) {
        case 'claude':
          return await this.sendToClaude(sessionId, message);
        case 'codex':
          return await this.sendToCodex(sessionId, message);
        case 'opencode':
          return await this.sendToOpenCode(sessionId, message);
        default:
          return {
            success: false,
            error: `Unsupported agent type: ${agentType}`,
          };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMsg };
    }
  }

  // -------------------------------------------------------------------------
  // Agent-specific strategies
  // -------------------------------------------------------------------------

  /**
   * Send a message to Claude via `claude --resume <sessionId>` piped through stdin.
   *
   * Claude CLI accepts input on stdin when resumed. We pipe the message
   * using `printf` to safely pass the message text.
   */
  private async sendToClaude(
    sessionId: string,
    message: string,
  ): Promise<ReplyResult> {
    const escapedMessage = escapeShell(message);
    const command = `printf '%s' '${escapedMessage}' | claude --resume ${escapeShell(sessionId)} --no-input`;

    const result: ExecResult = await this.connection.exec(command, 30_000);

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr.trim() || `claude exited with code ${result.exitCode}`,
      };
    }

    return {
      success: true,
      agentResponse: result.stdout.trim() || undefined,
    };
  }

  /**
   * Send a message to Codex by writing to its input file.
   *
   * Codex watches a per-session input file for incoming messages.
   * The message is appended to `~/.codex/sessions/<sessionId>/input`.
   */
  private async sendToCodex(
    sessionId: string,
    message: string,
  ): Promise<ReplyResult> {
    const escapedSessionId = escapeShell(sessionId);
    const escapedMessage = escapeShell(message);
    const command =
      `mkdir -p ~/.codex/sessions/${escapedSessionId} && ` +
      `printf '%s\\n' '${escapedMessage}' > ~/.codex/sessions/${escapedSessionId}/input`;

    const result: ExecResult = await this.connection.exec(command, 15_000);

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr.trim() || `codex write failed with code ${result.exitCode}`,
      };
    }

    return { success: true };
  }

  /**
   * Send a message to OpenCode by writing to its input pipe.
   *
   * OpenCode uses a named pipe (FIFO) at `/tmp/opencode-${sessionId}.input`
   * for receiving messages. We write to it non-blockingly.
   */
  private async sendToOpenCode(
    sessionId: string,
    message: string,
  ): Promise<ReplyResult> {
    const escapedSessionId = escapeShell(sessionId);
    const escapedMessage = escapeShell(message);
    const command =
      `printf '%s\\n' '${escapedMessage}' > /tmp/opencode-${escapedSessionId}.input`;

    const result: ExecResult = await this.connection.exec(command, 15_000);

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr.trim() || `opencode write failed with code ${result.exitCode}`,
      };
    }

    return { success: true };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion in a single-quoted shell argument.
 *
 * Within single quotes, the only character that needs escaping is the
 * single quote itself. We replace `'` with `'\''`.
 */
function escapeShell(str: string): string {
  return str.replace(/'/g, "'\\''");
}
