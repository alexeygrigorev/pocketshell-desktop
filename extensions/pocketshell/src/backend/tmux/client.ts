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
import type { TmuxState, TmuxPane, TmuxSession } from './state';
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
// Bracketed paste (app parity: PocketShell Android BracketedPaste.kt)
// ---------------------------------------------------------------------------

/**
 * Bracketed-paste start/end markers, as terminal escape sequences.
 * `[200~` / `[201~` (DECSET 2004 paste framing).
 */
const BRACKETED_PASTE_START = '[200~';
const BRACKETED_PASTE_END = '[201~';
const HEX_DIGITS = '0123456789abcdef';

/**
 * Returns true if `text` contains a line feed (`\n`).
 *
 * Mirrors `BracketedPaste.containsLineBreak` from the Android app: multiline
 * input is routed through the bracketed-paste path so the receiving program
 * treats the whole block as ONE paste instead of executing line-by-line.
 * Lone `\r` (carriage return) does NOT count as a paragraph break here, just
 * like the app.
 */
export function containsLineBreak(text: string): boolean {
  return text.indexOf('\n') !== -1;
}

/**
 * Maximum body size, in source bytes, carried by a single `send-keys -H`
 * command. Mirrors `BracketedPaste.BODY_CHUNK_BYTES` from the Android app.
 *
 * tmux's control-mode command input buffer caps near ~16,344 bytes (tmux issue
 * #254); hex is ~3 chars/byte, so a single `send-keys -H <hex>` command can
 * only safely carry ~5 KB of raw text. Chunking the body at 1024 source bytes
 * keeps every command well under that ceiling, matching the app's transport.
 */
const BRACKETED_PASTE_BODY_CHUNK_BYTES = 1024;

/**
 * Hex-encode a byte range as space-separated lowercase pairs (e.g. `1b 5b 32`).
 * Matches `BracketedPaste.hex(bytes, offset, length)` from the Android app: no
 * leading or trailing separator, lowercase digits.
 */
function hexEncodeBytes(bytes: Buffer, offset: number, length: number): string {
  if (length <= 0) return '';
  let hex = '';
  for (let i = offset; i < offset + length; i++) {
    if (hex.length > 0) hex += ' ';
    const v = bytes[i];
    hex += HEX_DIGITS[(v >>> 4) & 0xf];
    hex += HEX_DIGITS[v & 0xf];
  }
  return hex;
}

/**
 * Build the single-frame hex payload for a bracketed-paste block, matching the
 * Android app's `BracketedPaste.hexPayload` byte-for-byte. Equivalent to joining
 * `buildBracketedPasteHexChunks(text)` with spaces. Empty input yields ''.
 */
export function buildBracketedPasteHex(text: string): string {
  const chunks = buildBracketedPasteHexChunks(text);
  return chunks.join(' ');
}

/**
 * Build the chunked hex payloads for a bracketed-paste block, matching the
 * Android app's `BracketedPaste.hexChunks` exactly (the transport the app uses
 * in `TmuxSessionViewModel.sendBracketedPaste`).
 *
 * Returns one hex string per `send-keys -H` command: the paste-start marker,
 * the body sliced into <= BRACKETED_PASTE_BODY_CHUNK_BYTES source-byte chunks
 * (after `\r\n` to `\n` normalisation), then the paste-end marker. Even a tiny
 * paste yields three entries (start, body, end); empty input yields [] (no
 * commands at all, so we never send bare markers). The concatenation of every
 * chunk's hex bytes equals `buildBracketedPasteHex(text)` -- i.e. the bytes
 * reaching the pane are identical to the single-frame form.
 */
export function buildBracketedPasteHexChunks(text: string): string[] {
  if (text.length === 0) return [];
  const normalised = text.replace(/\r\n/g, '\n');
  const startBytes = Buffer.from(BRACKETED_PASTE_START, 'utf-8');
  const endBytes = Buffer.from(BRACKETED_PASTE_END, 'utf-8');
  const bodyBytes = Buffer.from(normalised, 'utf-8');
  const chunkSize = BRACKETED_PASTE_BODY_CHUNK_BYTES;
  const chunks: string[] = [hexEncodeBytes(startBytes, 0, startBytes.length)];
  for (let offset = 0; offset < bodyBytes.length; offset += chunkSize) {
    const length = Math.min(chunkSize, bodyBytes.length - offset);
    chunks.push(hexEncodeBytes(bodyBytes, offset, length));
  }
  chunks.push(hexEncodeBytes(endBytes, 0, endBytes.length));
  return chunks;
}

function buildSendInputCommand(paneId: string, data: string): string {
  const target = quoteTmuxArg(paneId);
  const commands: string[] = [];
  let literal = '';

  const flushLiteral = () => {
    if (literal.length === 0) {
      return;
    }
    commands.push(`send-keys -t ${target} -l ${quoteTmuxArg(literal)}`);
    literal = '';
  };

  for (const ch of data) {
    switch (ch) {
      case '\r':
      case '\n':
        flushLiteral();
        commands.push(`send-keys -t ${target} Enter`);
        break;
      case '\t':
        flushLiteral();
        commands.push(`send-keys -t ${target} Tab`);
        break;
      case '\x7f':
        flushLiteral();
        commands.push(`send-keys -t ${target} BSpace`);
        break;
      case '\x1b':
        flushLiteral();
        commands.push(`send-keys -t ${target} Escape`);
        break;
      default:
        literal += ch;
        break;
    }
  }
  flushLiteral();

  return commands.length > 0 ? commands.join(' ; ') : `send-keys -t ${target} -l ""`;
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
   * Send validated tmux key names to a pane.
   */
  async sendKeyNames(paneId: string, keys: string[]): Promise<CommandResponse> {
    if (keys.length === 0) {
      return { number: 0, output: [], isError: false };
    }
    for (const key of keys) {
      if (!isSafeTmuxKeyName(key)) {
        throw new Error(`Unsafe tmux key name: ${key}`);
      }
    }
    return this.enqueueCommand(`send-keys -t ${quoteTmuxArg(paneId)} ${keys.join(' ')}`);
  }

  /**
   * Send literal text to a pane/session/window target, followed by Enter.
   */
  async sendKeysLiteral(target: string, text: string): Promise<CommandResponse> {
    return this.enqueueCommand(`send-keys -t ${quoteTmuxArg(target)} -l ${quoteTmuxArg(text)} ; send-keys -t ${quoteTmuxArg(target)} Enter`);
  }

  /**
   * Send terminal input bytes as literal data to a pane.
   */
  async sendInput(paneId: string, data: string): Promise<CommandResponse> {
    return this.enqueueCommand(buildSendInputCommand(paneId, data));
  }

  /**
   * Send multiline `text` to a pane as a bracketed-paste block (app parity:
   * `ShareViewModel.pasteIntoSession` / `BracketedPaste.hexChunks`).
   *
   * The framed bytes (`\e[200~` + normalised content + `\e[201~`) are injected
   * via `send-keys -H <hex>`, which is the only `send-keys` flavour that can
   * carry a literal 0x0A byte. Empty / whitespace-only text is a no-op so we
   * never send bare paste markers.
   *
   * The body is chunked at `BRACKETED_PASTE_BODY_CHUNK_BYTES` (1024) source
   * bytes and the start marker, each body chunk, and end marker are emitted as
   * SEPARATE `send-keys -H -t <pane> <hex>` commands -- exactly the app's
   * transport (`TmuxSessionViewModel.sendBracketedPaste`). A single >5 KB paste
   * would otherwise exceed tmux's control-mode command buffer (tmux issue #254,
   * "command too long"). If any chunk is rejected (`isError`), the error
   * response is returned immediately and no further chunks are sent, so the
   * caller's `throwIfError` surfaces the failure and the composer keeps the
   * unsent draft (app parity: `throwIfTmuxError`).
   */
  async sendBracketedPaste(paneId: string, text: string): Promise<CommandResponse> {
    const chunks = buildBracketedPasteHexChunks(text);
    if (chunks.length === 0) {
      return { number: 0, output: [], isError: false };
    }
    const target = quoteTmuxArg(paneId);
    let response: CommandResponse = { number: 0, output: [], isError: false };
    for (const hex of chunks) {
      response = await this.enqueueCommand(`send-keys -H -t ${target} ${hex}`);
      if (response.isError) {
        return response;
      }
    }
    return response;
  }

  /**
   * Report the attached client size to tmux.
   */
  async resizeClient(width: number, height: number): Promise<void> {
    await this.enqueueCommand(`refresh-client -C ${width}x${height}`);
  }

  /**
   * Resize a pane.
   * Reference: section 12
   */
  async resizePane(paneId: string, width: number, height: number): Promise<void> {
    await this.enqueueCommand(`resize-pane -t ${quoteTmuxArg(paneId)} -x ${width} -y ${height}`);
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
    const format = '#{pane_id}\\t#{window_id}\\t#{session_id}\\t#{pane_width}\\t#{pane_height}\\t#{pane_title}\\t#{pane_in_mode}\\t#{pane_current_path}\\t#{session_name}\\t#{window_name}\\t#{session_activity}\\t#{window_activity}\\t#{window_active}\\t#{pane_active}\\t#{pane_tty}\\t#{pane_current_command}\\t#{pane_pid}';
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
   * Select a pane and make it the active pane in its window/session.
   */
  async selectPane(paneId: string, sessionId?: string, windowId?: string): Promise<CommandResponse> {
    const commands: string[] = [];
    if (sessionId) {
      commands.push(`switch-client -t ${quoteTmuxArg(sessionId)}`);
    }
    if (windowId) {
      commands.push(`select-window -t ${quoteTmuxArg(windowId)}`);
    }
    commands.push(`select-pane -t ${quoteTmuxArg(paneId)}`);
    return this.enqueueCommand(commands.join(' ; '));
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
    const prevState = this.state;
    if (!response.isError && response.output.length > 0) {
      this.state = parsePaneList(this.state, response.output);
    }
    if (this.state !== prevState) {
      for (const cb of this.stateChangeCallbacks) {
        try { cb(this.state); } catch { /* ignore */ }
      }
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
  const seenSessionIds = new Set<string>();
  const activeWindowBySession = new Map<string, string>();
  const activePaneByWindow = new Map<string, string>();
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 7) continue;

    const [
      paneId,
      windowId,
      sessionId,
      widthStr,
      heightStr,
      title,
      inMode,
      cwd,
      sessionName,
      windowName,
      ,
      ,
      windowActive,
      paneActive,
      tty,
      currentCommand,
      pidStr,
    ] = parts;
    if (!paneId.startsWith('%')) continue;
    if (!windowId.startsWith('@')) continue;
    if (!sessionId.startsWith('$')) continue;
    seenSessionIds.add(sessionId);

    const width = parseInt(widthStr, 10) || 80;
    const height = parseInt(heightStr, 10) || 24;
    const mode = inMode === '1' ? 'copy-mode' : 'normal';
    const pid = parseOptionalInt(pidStr);

    current = ensureSessionWindow(current, {
      sessionId,
      sessionName: sessionName || sessionId,
      windowId,
      windowName: windowName || windowId,
      windowActive: windowActive === '1',
    });

    const pane: TmuxPane = {
      id: paneId,
      sessionId,
      windowId,
      width,
      height,
      title,
      mode,
      cwd: cwd || undefined,
      tty: tty || undefined,
      currentCommand: currentCommand || undefined,
      pid,
    };

    current = upsertPane(current, pane);
    if (windowActive === '1') {
      activeWindowBySession.set(sessionId, windowId);
    }
    if (paneActive === '1') {
      activePaneByWindow.set(`${sessionId}\0${windowId}`, paneId);
    }
  }

  const activeSessionId = current.activeSessionId && seenSessionIds.has(current.activeSessionId)
    ? current.activeSessionId
    : seenSessionIds.values().next().value ?? current.activeSessionId;
  const activeWindowId = activeSessionId
    ? activeWindowBySession.get(activeSessionId) ?? current.activeWindowId
    : current.activeWindowId;
  const activePaneId = activeSessionId && activeWindowId
    ? activePaneByWindow.get(`${activeSessionId}\0${activeWindowId}`) ?? current.activePaneId
    : current.activePaneId;

  return {
    ...current,
    activeSessionId,
    activeWindowId,
    activePaneId,
  };
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSafeTmuxKeyName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function ensureSessionWindow(
  state: TmuxState,
  options: {
    sessionId: string;
    sessionName: string;
    windowId: string;
    windowName: string;
    windowActive: boolean;
  },
): TmuxState {
  const sessions = new Map(state.sessions);
  const existingSession = sessions.get(options.sessionId);
  const session: TmuxSession = existingSession ?? {
    id: options.sessionId,
    name: options.sessionName,
    windows: new Map(),
    windowOrder: [],
  };

  const windows = new Map(session.windows);
  const existingWindow = windows.get(options.windowId);
  if (existingWindow) {
    windows.set(options.windowId, {
      ...existingWindow,
      name: options.windowName,
      active: options.windowActive,
    });
  } else {
    windows.set(options.windowId, {
      id: options.windowId,
      sessionId: options.sessionId,
      name: options.windowName,
      active: options.windowActive,
      layout: '',
      panes: new Map(),
      paneOrder: [],
    });
  }

  const windowOrder = session.windowOrder.includes(options.windowId)
    ? session.windowOrder
    : [...session.windowOrder, options.windowId];

  sessions.set(options.sessionId, {
    ...session,
    name: options.sessionName,
    windows,
    windowOrder,
  });

  return { ...state, sessions };
}
