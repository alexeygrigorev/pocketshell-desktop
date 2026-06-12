/**
 * SessionReader — reads agent conversation logs from a remote host.
 *
 * Uses an SshConnection to:
 * - List available session log files
 * - Read and parse full session logs
 * - Tail a session for new messages (polling-based)
 */

import { SshConnection } from '../../ssh/connection/ssh-client';
import {
  AgentType,
  ConversationMessage,
  ConversationSession,
  SessionInfo,
} from './types';
import { parseSession } from './parsers';

// ---------------------------------------------------------------------------
// Remote path conventions
// ---------------------------------------------------------------------------

/** Base directory for agent session logs on the remote host. */
const SESSION_BASE_DIR = '/tmp/pocketshell/sessions';

/** Directory per agent type. */
function agentDir(agentType: AgentType): string {
  return `${SESSION_BASE_DIR}/${agentType}`;
}

/** Glob pattern to find session files. */
function agentGlob(agentType: AgentType): string {
  return `${agentDir(agentType)}/*.jsonl`;
}

// ---------------------------------------------------------------------------
// SessionReader
// ---------------------------------------------------------------------------

/**
 * Reads agent conversation sessions from a remote SSH host.
 */
export class SessionReader {
  private connection: SshConnection;
  private pollingTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(connection: SshConnection) {
    this.connection = connection;
  }

  /**
   * List available sessions on the remote host, optionally filtered by agent type.
   *
   * Uses `stat` on each matching file to get size and modification time.
   */
  async listSessions(agentType?: AgentType): Promise<SessionInfo[]> {
    const types: AgentType[] = agentType
      ? [agentType]
      : ['claude', 'codex', 'opencode'];

    const sessions: SessionInfo[] = [];

    for (const at of types) {
      const dir = agentDir(at);

      // List files in the agent directory
      const listResult = await this.connection.exec(
        `find '${dir}' -name '*.jsonl' -print0 2>/dev/null | xargs -0 -r stat -c '%n|%s|%Y' 2>/dev/null`,
      );

      if (listResult.exitCode !== 0 || !listResult.stdout.trim()) {
        continue;
      }

      for (const line of listResult.stdout.trim().split('\n')) {
        const parts = line.split('|');
        if (parts.length < 3) continue;

        const path = parts[0];
        const size = parseInt(parts[1], 10);
        const modifiedAt = parseInt(parts[2], 10) * 1000; // stat %Y is seconds

        // Derive session id from filename
        const filename = path.split('/').pop() ?? path;
        const id = filename.replace(/\.jsonl$/, '');

        sessions.push({
          id,
          agentType: at,
          path,
          size: Number.isNaN(size) ? 0 : size,
          modifiedAt: Number.isNaN(modifiedAt) ? 0 : modifiedAt,
        });
      }
    }

    // Sort by most recently modified
    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);

    return sessions;
  }

  /**
   * Read and parse a full session log.
   *
   * @param sessionId  The session id (from listSessions).
   * @param agentType  The agent type — needed to locate the file and select the parser.
   *                   If omitted, searches all agent directories.
   */
  async readSession(sessionId: string, agentType?: AgentType): Promise<ConversationSession> {
    // If agent type is known, read directly
    if (agentType) {
      return this.readSessionFile(sessionId, agentType);
    }

    // Otherwise try each type
    for (const at of ['claude', 'codex', 'opencode'] as AgentType[]) {
      try {
        return await this.readSessionFile(sessionId, at);
      } catch {
        // File not found for this type — try next
        continue;
      }
    }

    throw new Error(`Session not found: ${sessionId}`);
  }

  /**
   * Tail a session log for new messages.
   *
   * Uses polling to check for new content appended to the session file.
   *
   * @param sessionId  The session id.
   * @param agentType  The agent type.
   * @param callback   Called for each new message.
   * @param pollMs     Polling interval in milliseconds (default 2000).
   * @returns A stop function — call it to stop polling.
   */
  async tailSession(
    sessionId: string,
    agentType: AgentType,
    callback: (msg: ConversationMessage) => void,
    pollMs: number = 2000,
  ): Promise<() => void> {
    const path = `${agentDir(agentType)}/${sessionId}.jsonl`;

    // Track how many bytes we've already seen
    let offset = 0;

    // Read current size to skip already-existing content
    const statResult = await this.connection.exec(`stat -c '%s' '${path}' 2>/dev/null`);
    if (statResult.exitCode === 0 && statResult.stdout.trim()) {
      offset = parseInt(statResult.stdout.trim(), 10) || 0;
    }

    const timerKey = `${agentType}:${sessionId}`;

    const interval = setInterval(async () => {
      try {
        // Read only new bytes appended since last check
        const result = await this.connection.exec(
          `dd if='${path}' bs=1 skip='${offset}' 2>/dev/null`,
        );

        if (result.exitCode === 0 && result.stdout) {
          const newContent = result.stdout;
          const newSize = offset + newContent.length;

          if (newContent.trim()) {
            // Parse the new lines
            const newSession = parseSession(agentType, newContent);

            for (const msg of newSession.messages) {
              callback(msg);
            }
          }

          offset = newSize;
        }
      } catch {
        // Connection error during polling — skip this round
      }
    }, pollMs);

    this.pollingTimers.set(timerKey, interval);

    // Return a stop function
    return () => {
      const t = this.pollingTimers.get(timerKey);
      if (t) {
        clearInterval(t);
        this.pollingTimers.delete(timerKey);
      }
    };
  }

  /** Dispose all active polling timers. */
  dispose(): void {
    for (const timer of this.pollingTimers.values()) {
      clearInterval(timer);
    }
    this.pollingTimers.clear();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async readSessionFile(
    sessionId: string,
    agentType: AgentType,
  ): Promise<ConversationSession> {
    const path = `${agentDir(agentType)}/${sessionId}.jsonl`;

    const result = await this.connection.exec(`cat '${path}'`);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to read session file: ${path} (exit ${result.exitCode})`);
    }

    const session = parseSession(agentType, result.stdout);
    session.id = sessionId;

    return session;
  }
}
