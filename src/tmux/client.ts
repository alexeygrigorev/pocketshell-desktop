/**
 * tmux -CC Control Mode Client
 *
 * Ported from PocketShell Android: TmuxClient.kt
 * Reference: docs/tmux-protocol-reference.md sections 8, 9, 10, 12
 *
 * High-level client: connect, sendCommand, output subscription, state tracking.
 */

import { EventEmitter } from 'events';
import { TmuxEventStream, type StreamReader } from './stream';
import type { ControlEvent, CommandResponse, CaptureWithCursor } from './events';
import type { TmuxState, TmuxPane } from './state';
import { emptyState, applyEvent, upsertPane } from './state';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SshChannel {
  write(data: Buffer): Promise<void>;
  getStdoutReader(): StreamReader;
  close(): Promise<void>;
}

export interface TmuxClientOptions {
  sessionName: string;
  startDir?: string;
  initialCommand?: string;
  createIfMissing?: boolean;
  commandTimeoutMs?: number;
}

export interface OutputSubscription {
  unsubscribe(): void;
}

type OutputCallback = (data: Uint8Array) => void;
type StateChangeCallback = (state: TmuxState) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_NAME = 'pocketshell';
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

function escapeSingleQuoted(input: string): string {
  return input.replace(/'/g, "'\\''");
}

function quoteTmuxArg(input: string): string {
  return `"${input.replace(/[\\"$]/g, (ch) => `\\${ch}`)}"`;
}

// ---------------------------------------------------------------------------
// TmuxClient
// ---------------------------------------------------------------------------

/**
 * High-level tmux -CC control mode client.
 *
 * Reference: sections 8, 10
 */
export class TmuxClient extends EventEmitter {
  private channel: SshChannel | null = null;
  private stream: TmuxEventStream | null = null;
  private state: TmuxState = emptyState();
  private outputSubs: Map<string, Set<OutputCallback>> = new Map();
  private stateChangeCallbacks: Set<StateChangeCallback> = new Set();
  private commandQueue: Promise<CommandResponse> = Promise.resolve(
    { number: 0, output: [], isError: true } as CommandResponse
  );
  private connected = false;
  private commandTimeoutMs: number;

  constructor(private options: TmuxClientOptions) {
    super();
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle (section 10)
  // -----------------------------------------------------------------------

  /**
   * Start tmux -CC over an SSH channel.
   * Reference: section 8.1
   */
  async connect(channel: SshChannel): Promise<void> {
    if (this.connected) throw new Error('Already connected');

    this.channel = channel;

    // Set up the event stream
    const reader = channel.getStdoutReader();
    this.stream = new TmuxEventStream(reader);

    // Subscribe to events BEFORE writing spawn command (section 8.1)
    this.stream.on('event', (event: ControlEvent) => this.handleEvent(event));

    // Build spawn command
    const sessionName = this.options.sessionName || DEFAULT_SESSION_NAME;
    const escapedName = escapeSingleQuoted(sessionName);
    let cmd = `tmux -CC new-session -A -s '${escapedName}'`;
    if (this.options.startDir) {
      cmd += ` -c '${escapeSingleQuoted(this.options.startDir)}'`;
    }
    if (this.options.initialCommand) {
      cmd += ` '${escapeSingleQuoted(this.options.initialCommand)}'`;
    }
    cmd += '\n';

    // Start reader loop (before writing, to avoid missing notifications)
    void this.stream.run();

    // Write spawn command
    await this.channel.write(Buffer.from(cmd, 'utf-8'));

    this.connected = true;
  }

  /**
   * Clean detach from tmux.
   * Reference: section 8.8
   */
  async detach(): Promise<void> {
    if (!this.connected || !this.stream) return;

    try {
      const halfTimeout = Math.floor(this.commandTimeoutMs / 2);
      await this.withTimeout(
        this.sendCommandRaw('detach-client'),
        halfTimeout,
      );
    } catch {
      // Best effort — proceed to close
    }

    await this.close();
  }

  /**
   * Force close the client.
   */
  async close(): Promise<void> {
    this.connected = false;

    if (this.stream) {
      this.stream.stop();
      this.stream = null;
    }

    if (this.channel) {
      try {
        await this.channel.close();
      } catch {
        // Ignore close errors
      }
      this.channel = null;
    }
  }

  // -----------------------------------------------------------------------
  // Commands (section 8.3)
  // -----------------------------------------------------------------------

  /**
   * Send a command to tmux and wait for the response.
   * Commands are serialized — one outstanding at a time.
   */
  async sendCommand(command: string): Promise<CommandResponse> {
    return this.enqueueCommand(command);
  }

  /**
   * Send keystrokes to a pane.
   * Reference: section 12
   */
  async sendKeys(paneId: string, keys: string): Promise<CommandResponse> {
    return this.enqueueCommand(`send-keys -t ${paneId} ${keys}`);
  }

  /**
   * Send literal text to a pane/session/window target, followed by Enter.
   */
  async sendKeysLiteral(target: string, text: string): Promise<CommandResponse> {
    return this.enqueueCommand(`send-keys -t ${quoteTmuxArg(target)} -l ${quoteTmuxArg(text)} ; send-keys -t ${quoteTmuxArg(target)} Enter`);
  }

  /**
   * Resize a pane.
   * Reference: section 12
   */
  async resizePane(_paneId: string, width: number, height: number): Promise<void> {
    // Report client size
    await this.enqueueCommand(`refresh-client -C ${width}x${height}`);
  }

  /**
   * List all sessions.
   */
  async listSessions(): Promise<CommandResponse> {
    return this.enqueueCommand('list-sessions');
  }

  /**
   * List windows in current session.
   */
  async listWindows(): Promise<CommandResponse> {
    return this.enqueueCommand('list-windows');
  }

  /**
   * List all panes with format fields.
   * Reference: section 12
   */
  async listPanes(): Promise<CommandResponse> {
    const format = '#{pane_id}\\t#{window_id}\\t#{session_id}\\t#{pane_width}\\t#{pane_height}\\t#{pane_title}\\t#{pane_in_mode}\\t#{pane_current_path}\\t#{session_name}\\t#{window_name}\\t#{session_activity}\\t#{window_activity}';
    return this.enqueueCommand(`list-panes -a -F '${format}'`);
  }

  /**
   * Create a new session.
   */
  async newSession(name: string, startDir?: string): Promise<CommandResponse> {
    let cmd = `new-session -d -s '${escapeSingleQuoted(name)}'`;
    if (startDir) {
      cmd += ` -c '${escapeSingleQuoted(startDir)}'`;
    }
    return this.enqueueCommand(cmd);
  }

  /**
   * Kill a session.
   */
  async killSession(name: string): Promise<CommandResponse> {
    return this.enqueueCommand(`kill-session -t ${quoteTmuxArg(name)}`);
  }

  /**
   * Rename a session.
   */
  async renameSession(sessionId: string, newName: string): Promise<CommandResponse> {
    return this.enqueueCommand(`rename-session -t ${quoteTmuxArg(sessionId)} ${quoteTmuxArg(newName)}`);
  }

  /**
   * Create a new window.
   */
  async newWindow(sessionId?: string, name?: string, startDir?: string): Promise<CommandResponse> {
    let cmd = 'new-window';
    if (sessionId) cmd += ` -t ${quoteTmuxArg(sessionId)}`;
    if (name) cmd += ` -n ${quoteTmuxArg(name)}`;
    if (startDir) cmd += ` -c ${quoteTmuxArg(startDir)}`;
    return this.enqueueCommand(cmd);
  }

  /**
   * Create a new window and print the new pane id.
   */
  async newWindowWithPaneId(sessionId?: string, name?: string, startDir?: string): Promise<CommandResponse> {
    let cmd = 'new-window -P -F "#{pane_id}"';
    if (sessionId) cmd += ` -t ${quoteTmuxArg(sessionId)}`;
    if (name) cmd += ` -n ${quoteTmuxArg(name)}`;
    if (startDir) cmd += ` -c ${quoteTmuxArg(startDir)}`;
    return this.enqueueCommand(cmd);
  }

  /**
   * Kill a window.
   */
  async killWindow(windowId: string): Promise<CommandResponse> {
    return this.enqueueCommand(`kill-window -t ${windowId}`);
  }

  /**
   * Split a pane.
   */
  async splitWindow(paneId: string, horizontal = false): Promise<CommandResponse> {
    let cmd = `split-window -t ${paneId}`;
    if (horizontal) cmd += ' -h';
    return this.enqueueCommand(cmd);
  }

  /**
   * Kill a pane.
   */
  async killPane(paneId: string): Promise<CommandResponse> {
    return this.enqueueCommand(`kill-pane -t ${paneId}`);
  }

  /**
   * Capture pane content with cursor position.
   * Reference: section 8.5
   */
  async captureWithCursor(
    paneId: string,
    scrollbackLines: number,
  ): Promise<CaptureWithCursor> {
    const captureCmd = `capture-pane -p -e -S -${scrollbackLines} -t ${paneId}`;
    const cursorCmd = `display-message -p -t ${paneId} '#{cursor_x},#{cursor_y}'`;

    // Send chained command
    const response = await this.enqueueCommand(`${captureCmd} ; ${cursorCmd}`);

    // For chained commands, tmux produces separate %begin/%end blocks.
    // The stream collects all payload. For this API we'd need to handle
    // the two-block correlation. For now, return the single response.
    // Full two-block support requires sendChainedCommands (section 8.4).
    return {
      capture: response,
      cursorReply: null,
    };
  }

  /**
   * Select a window.
   */
  async selectWindow(windowId: string): Promise<CommandResponse> {
    return this.enqueueCommand(`select-window -t ${windowId}`);
  }

  /**
   * Set window size policy.
   * Reference: section 8.7
   */
  async setWindowSizePolicy(sessionId: string): Promise<CommandResponse> {
    return this.enqueueCommand(
      `set-window-option -t '${escapeSingleQuoted(sessionId)}' window-size latest`,
    );
  }

  // -----------------------------------------------------------------------
  // State queries
  // -----------------------------------------------------------------------

  /**
   * Get the current tmux state snapshot.
   */
  getState(): TmuxState {
    return this.state;
  }

  /**
   * Refresh the state model by querying tmux for pane info.
   */
  async refreshState(): Promise<TmuxState> {
    const response = await this.listPanes();
    if (!response.isError && response.output.length > 0) {
      this.state = parsePaneList(this.state, response.output);
    }
    return this.state;
  }

  // -----------------------------------------------------------------------
  // Output subscriptions (section 9)
  // -----------------------------------------------------------------------

  /**
   * Subscribe to raw output for a specific pane.
   */
  onOutput(paneId: string, callback: OutputCallback): OutputSubscription {
    if (!this.outputSubs.has(paneId)) {
      this.outputSubs.set(paneId, new Set());
    }
    this.outputSubs.get(paneId)!.add(callback);

    return {
      unsubscribe: () => {
        const subs = this.outputSubs.get(paneId);
        if (subs) {
          subs.delete(callback);
          if (subs.size === 0) {
            this.outputSubs.delete(paneId);
          }
        }
      },
    };
  }

  /**
   * Subscribe to state changes.
   */
  onStateChange(callback: StateChangeCallback): { unsubscribe: () => void } {
    this.stateChangeCallbacks.add(callback);
    return {
      unsubscribe: () => {
        this.stateChangeCallbacks.delete(callback);
      },
    };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private handleEvent(event: ControlEvent): void {
    // Route output events to per-pane subscribers
    if (event.type === 'output') {
      const subs = this.outputSubs.get(event.paneId);
      if (subs) {
        for (const cb of subs) {
          try { cb(event.data); } catch { /* ignore subscriber errors */ }
        }
      }
    }

    // Update state model
    const prevState = this.state;
    this.state = applyEvent(this.state, event);

    // Notify state change subscribers if state changed
    if (this.state !== prevState) {
      for (const cb of this.stateChangeCallbacks) {
        try { cb(this.state); } catch { /* ignore */ }
      }
    }

    // Emit globally
    this.emit('event', event);
  }

  /**
   * Serialize command sending — one outstanding at a time.
   * Reference: section 8.3
   */
  private enqueueCommand(command: string): Promise<CommandResponse> {
    const prev = this.commandQueue;
    this.commandQueue = prev.then(async () => {
      return this.sendCommandRaw(command);
    });
    return this.commandQueue;
  }

  private async sendCommandRaw(command: string): Promise<CommandResponse> {
    if (!this.stream || !this.channel) {
      throw new Error('Not connected');
    }

    const promise = this.stream.enqueueCommand();
    await this.channel.write(Buffer.from(command + '\n', 'utf-8'));
    return this.withTimeout(promise, this.commandTimeoutMs);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command timed out after ${ms}ms`));
      }, ms);

      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Pane list parser
// ---------------------------------------------------------------------------

/**
 * Parse output from `list-panes -a -F '...'` into state updates.
 */
function parsePaneList(state: TmuxState, lines: string[]): TmuxState {
  let current = state;
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 7) continue;

    const [paneId, windowId, sessionId, widthStr, heightStr, title, inMode, cwd] = parts;
    if (!paneId.startsWith('%')) continue;
    if (!windowId.startsWith('@')) continue;
    if (!sessionId.startsWith('$')) continue;

    const width = parseInt(widthStr, 10) || 80;
    const height = parseInt(heightStr, 10) || 24;
    const mode = inMode === '1' ? 'copy-mode' : 'normal';

    const pane: TmuxPane = {
      id: paneId,
      sessionId,
      windowId,
      width,
      height,
      title,
      mode,
      cwd: cwd || undefined,
    };

    current = upsertPane(current, pane);
  }
  return current;
}
