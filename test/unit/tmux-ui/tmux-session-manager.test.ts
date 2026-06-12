/**
 * TmuxSessionManager unit tests
 *
 * Uses mocked TmuxClient and TerminalManager to verify:
 *   - start/stop lifecycle
 *   - session/window/pane operations
 *   - state synchronization
 *   - pane-to-terminal mapping
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TmuxSessionManager } from '../../../src/tmux-ui/tmux-session-manager';
import { emptyState, applyEvent, upsertPane } from '../../../src/tmux/state';
import type { TmuxState } from '../../../src/tmux/state';
import type { ControlEvent, CommandResponse } from '../../../src/tmux/events';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a successful CommandResponse. */
function okResponse(output: string[] = [], number = 1): CommandResponse {
  return { number, output, isError: false };
}

/** Create an error CommandResponse. */
function errorResponse(output: string[] = ['error'], number = 1): CommandResponse {
  return { number, output, isError: true };
}

/** Build a TmuxState with one session, one window, one pane. */
function buildSimpleState(
  sessionId = '$0',
  windowId = '@0',
  paneId = '%0',
  sessionName = 'main',
): TmuxState {
  let state = emptyState();
  state = applyEvent(state, { type: 'session-changed', sessionId, name: sessionName });
  state = applyEvent(state, { type: 'window-add', sessionId, windowId, name: '' });
  state = upsertPane(state, {
    id: paneId, sessionId, windowId,
    width: 80, height: 24, title: 'bash', mode: 'normal',
  });
  state = { ...state, activeSessionId: sessionId, activeWindowId: windowId, activePaneId: paneId };
  return state;
}

// ---------------------------------------------------------------------------
// Mock SshChannel
// ---------------------------------------------------------------------------

class MockSshChannel {
  written: Buffer[] = [];
  closed = false;

  async write(data: Buffer): Promise<void> {
    this.written.push(data);
  }

  getStdoutReader() {
    return {
      read: async (): Promise<Buffer | null> => null,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// Mock TmuxClient
// ---------------------------------------------------------------------------

type StateChangeCallback = (state: TmuxState) => void;

class MockTmuxClient {
  private _state: TmuxState = emptyState();
  private stateChangeCallbacks = new Set<StateChangeCallback>();
  private eventListeners = new Map<string, Function[]>();
  connected = false;
  detached = false;
  commands: { command: string; response: CommandResponse }[] = [];

  /** Set the state that getState() returns. */
  setState(state: TmuxState): void {
    this._state = state;
  }

  /** Simulate a state change notification to all subscribers. */
  simulateStateChange(newState: TmuxState): void {
    const prevState = this._state;
    this._state = newState;
    for (const cb of this.stateChangeCallbacks) {
      cb(newState);
    }
  }

  getState(): TmuxState {
    return this._state;
  }

  async connect(channel: any): Promise<void> {
    this.connected = true;
    // Simulate initial state push (like real TmuxClient does after connect)
    if (this._state.sessions.size > 0) {
      // Defer to allow the subscription to be set up
      await new Promise(resolve => setTimeout(resolve, 0));
      for (const cb of this.stateChangeCallbacks) {
        cb(this._state);
      }
    }
  }

  async detach(): Promise<void> {
    this.detached = true;
    this.connected = false;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  async sendCommand(command: string): Promise<CommandResponse> {
    return this.handleCommand(command);
  }

  async newSession(name: string, startDir?: string): Promise<CommandResponse> {
    return this.handleCommand(`new-session -d -s '${name}'`);
  }

  async killSession(name: string): Promise<CommandResponse> {
    return this.handleCommand(`kill-session -t '${name}'`);
  }

  async renameSession(sessionId: string, newName: string): Promise<CommandResponse> {
    return this.handleCommand(`rename-session -t ${sessionId} '${newName}'`);
  }

  async newWindow(sessionId?: string, name?: string): Promise<CommandResponse> {
    let cmd = 'new-window';
    if (sessionId) cmd += ` -t ${sessionId}`;
    if (name) cmd += ` -n '${name}'`;
    return this.handleCommand(cmd);
  }

  async killWindow(windowId: string): Promise<CommandResponse> {
    return this.handleCommand(`kill-window -t ${windowId}`);
  }

  async selectWindow(windowId: string): Promise<CommandResponse> {
    return this.handleCommand(`select-window -t ${windowId}`);
  }

  async splitWindow(paneId: string, horizontal = false): Promise<CommandResponse> {
    let cmd = `split-window -t ${paneId}`;
    if (horizontal) cmd += ' -h';
    return this.handleCommand(cmd);
  }

  async killPane(paneId: string): Promise<CommandResponse> {
    return this.handleCommand(`kill-pane -t ${paneId}`);
  }

  async captureWithCursor(paneId: string, scrollback: number): Promise<any> {
    return {
      capture: okResponse(['line 1', 'line 2']),
      cursorReply: null,
    };
  }

  async refreshState(): Promise<TmuxState> {
    return this._state;
  }

  onStateChange(callback: StateChangeCallback): { unsubscribe(): void } {
    this.stateChangeCallbacks.add(callback);
    return {
      unsubscribe: () => {
        this.stateChangeCallbacks.delete(callback);
      },
    };
  }

  on(event: string, callback: Function): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(callback);
  }

  /** Register a command response for testing. */
  enqueueCommandResponse(command: string, response: CommandResponse): void {
    this.commands.push({ command, response });
  }

  private handleCommand(command: string): CommandResponse {
    // Check for queued responses
    for (let i = 0; i < this.commands.length; i++) {
      if (command.includes(this.commands[i].command) || this.commands[i].command === command) {
        const entry = this.commands.splice(i, 1)[0];
        return entry.response;
      }
    }
    // Default: success
    return okResponse();
  }
}

// ---------------------------------------------------------------------------
// Mock TerminalManager
// ---------------------------------------------------------------------------

let nextTerminalId = 1;

class MockTerminalManager {
  private terminals = new Map<string, { id: string; name: string; isActive: boolean; killed: boolean }>();

  async createTerminal(hostId: number, connection: any, options?: any): Promise<any> {
    const id = `ssh-term-${nextTerminalId++}`;
    const terminal = {
      id,
      backend: {},
      hostId,
      name: options?.name ?? `Terminal ${id}`,
      createdAt: Date.now(),
      isActive: true,
      killed: false,
    };
    this.terminals.set(id, terminal);
    return terminal;
  }

  getTerminal(id: string): any {
    return this.terminals.get(id);
  }

  closeTerminal(id: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.isActive = false;
      terminal.killed = true;
      this.terminals.delete(id);
    }
  }

  closeAll(): void {
    for (const terminal of this.terminals.values()) {
      terminal.isActive = false;
      terminal.killed = true;
    }
    this.terminals.clear();
  }

  listTerminals(): any[] {
    return Array.from(this.terminals.values());
  }

  get count(): number {
    return this.terminals.size;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TmuxSessionManager', () => {
  let tmuxClient: MockTmuxClient;
  let terminalManager: MockTerminalManager;
  let manager: TmuxSessionManager;
  let channel: MockSshChannel;

  beforeEach(() => {
    nextTerminalId = 1;
    tmuxClient = new MockTmuxClient();
    terminalManager = new MockTerminalManager();
    manager = new TmuxSessionManager(tmuxClient as any, terminalManager as any);
    channel = new MockSshChannel();
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe('start()', () => {
    it('initializes tmux client and starts state tracking', async () => {
      const state = buildSimpleState();
      tmuxClient.setState(state);

      await manager.start(channel, 1);

      expect(tmuxClient.connected).toBe(true);
      expect(manager.getState()).toBe(state);
    });

    it('throws if already started', async () => {
      await manager.start(channel, 1);

      await expect(manager.start(channel, 1)).rejects.toThrow('already started');
    });

    it('receives state updates after start', async () => {
      await manager.start(channel, 1);

      const newState = buildSimpleState('$1', '@5', '%10', 'new-session');
      const states: TmuxState[] = [];
      manager.onStateChange(s => states.push(s));

      tmuxClient.simulateStateChange(newState);

      expect(states).toHaveLength(1);
      expect(manager.getState()).toBe(newState);
    });
  });

  describe('stop()', () => {
    it('detaches from tmux and clears state', async () => {
      await manager.start(channel, 1);
      tmuxClient.simulateStateChange(buildSimpleState());

      await manager.stop();

      expect(tmuxClient.detached).toBe(true);
      expect(manager.getState().sessions.size).toBe(0);
    });

    it('is a no-op if not started', async () => {
      await expect(manager.stop()).resolves.toBeUndefined();
    });

    it('unsubscribes from state changes', async () => {
      await manager.start(channel, 1);

      const states: TmuxState[] = [];
      manager.onStateChange(s => states.push(s));

      await manager.stop();

      // Simulate a state change after stop — should not reach our callback
      tmuxClient.simulateStateChange(buildSimpleState());

      expect(states).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // State subscription
  // -----------------------------------------------------------------------

  describe('onStateChange()', () => {
    it('notifies subscribers on state change', async () => {
      await manager.start(channel, 1);

      const states: TmuxState[] = [];
      const unsub = manager.onStateChange(s => states.push(s));

      const newState = buildSimpleState();
      tmuxClient.simulateStateChange(newState);

      expect(states).toHaveLength(1);
      expect(states[0]).toBe(newState);

      unsub();
    });

    it('unsubscribe stops notifications', async () => {
      await manager.start(channel, 1);

      const states: TmuxState[] = [];
      const unsub = manager.onStateChange(s => states.push(s));

      unsub();

      tmuxClient.simulateStateChange(buildSimpleState());
      expect(states).toHaveLength(0);
    });

    it('supports multiple subscribers', async () => {
      await manager.start(channel, 1);

      const s1: TmuxState[] = [];
      const s2: TmuxState[] = [];
      manager.onStateChange(s => s1.push(s));
      manager.onStateChange(s => s2.push(s));

      tmuxClient.simulateStateChange(buildSimpleState());

      expect(s1).toHaveLength(1);
      expect(s2).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Session operations
  // -----------------------------------------------------------------------

  describe('createSession()', () => {
    it('calls new-session and updates state', async () => {
      await manager.start(channel, 1);

      // Set up the state that will be returned after refreshState
      const expectedState = buildSimpleState('$1', '@5', '%10', 'test-session');
      tmuxClient.setState(expectedState);

      const session = await manager.createSession('test-session');

      expect(session.name).toBe('test-session');
    });

    it('throws on error response', async () => {
      await manager.start(channel, 1);
      tmuxClient.enqueueCommandResponse('new-session', errorResponse(['session exists']));

      await expect(manager.createSession('test')).rejects.toThrow('Failed to create session');
    });
  });

  describe('killSession()', () => {
    it('kills the session and cleans up terminals', async () => {
      await manager.start(channel, 1);

      const state = buildSimpleState();
      tmuxClient.simulateStateChange(state);

      // Create a terminal for the pane
      await manager.createPaneTerminal('%0', {} as any);

      expect(terminalManager.getTerminal('ssh-term-1')).toBeDefined();

      await manager.killSession('$0');

      // Terminal should be cleaned up
      expect(terminalManager.getTerminal('ssh-term-1')).toBeUndefined();
    });
  });

  describe('renameSession()', () => {
    it('renames a session', async () => {
      await manager.start(channel, 1);

      await expect(manager.renameSession('$0', 'new-name')).resolves.toBeUndefined();
    });

    it('throws on error', async () => {
      await manager.start(channel, 1);
      tmuxClient.enqueueCommandResponse('rename-session', errorResponse());

      await expect(manager.renameSession('$0', 'x')).rejects.toThrow('Failed to rename session');
    });
  });

  describe('switchSession()', () => {
    it('switches to a different session', async () => {
      await manager.start(channel, 1);

      await expect(manager.switchSession('$1')).resolves.toBeUndefined();
    });

    it('throws on error', async () => {
      await manager.start(channel, 1);
      tmuxClient.enqueueCommandResponse('switch-client', errorResponse());

      await expect(manager.switchSession('$99')).rejects.toThrow('Failed to switch session');
    });
  });

  // -----------------------------------------------------------------------
  // Window operations
  // -----------------------------------------------------------------------

  describe('createWindow()', () => {
    it('creates a window in the specified session', async () => {
      await manager.start(channel, 1);

      // Set up state after window creation
      let state = buildSimpleState('$0', '@0', '%0');
      state = applyEvent(state, { type: 'window-add', sessionId: '$0', windowId: '@1', name: 'new' });
      state = upsertPane(state, {
        id: '%1', sessionId: '$0', windowId: '@1',
        width: 80, height: 24, title: 'bash', mode: 'normal',
      });
      tmuxClient.setState(state);

      const win = await manager.createWindow('$0', 'new');

      expect(win.id).toBe('@1');
    });

    it('throws on error', async () => {
      await manager.start(channel, 1);
      tmuxClient.enqueueCommandResponse('new-window', errorResponse());

      await expect(manager.createWindow('$0')).rejects.toThrow('Failed to create window');
    });
  });

  describe('killWindow()', () => {
    it('kills a window and cleans up pane terminals', async () => {
      await manager.start(channel, 1);

      const state = buildSimpleState();
      tmuxClient.simulateStateChange(state);

      // Create terminal for the pane in this window
      await manager.createPaneTerminal('%0', {} as any);
      expect(terminalManager.getTerminal('ssh-term-1')).toBeDefined();

      await manager.killWindow('@0');

      expect(terminalManager.getTerminal('ssh-term-1')).toBeUndefined();
    });
  });

  describe('renameWindow()', () => {
    it('renames a window', async () => {
      await manager.start(channel, 1);

      await expect(manager.renameWindow('@0', 'renamed')).resolves.toBeUndefined();
    });

    it('throws on error', async () => {
      await manager.start(channel, 1);
      tmuxClient.enqueueCommandResponse('rename-window', errorResponse());

      await expect(manager.renameWindow('@0', 'x')).rejects.toThrow('Failed to rename window');
    });
  });

  describe('switchWindow()', () => {
    it('switches to a different window', async () => {
      await manager.start(channel, 1);

      await expect(manager.switchWindow('@1')).resolves.toBeUndefined();
    });

    it('throws on error', async () => {
      await manager.start(channel, 1);
      tmuxClient.enqueueCommandResponse('select-window', errorResponse());

      await expect(manager.switchWindow('@99')).rejects.toThrow('Failed to switch window');
    });
  });

  // -----------------------------------------------------------------------
  // Pane operations
  // -----------------------------------------------------------------------

  describe('splitPane()', () => {
    it('splits a pane and discovers the new pane', async () => {
      await manager.start(channel, 1);

      // Initial state with one pane
      const initialState = buildSimpleState('$0', '@0', '%0');
      tmuxClient.simulateStateChange(initialState);

      // After split: state with two panes
      let splitState = buildSimpleState('$0', '@0', '%0');
      splitState = upsertPane(splitState, {
        id: '%1', sessionId: '$0', windowId: '@0',
        width: 40, height: 24, title: 'bash', mode: 'normal',
      });
      tmuxClient.setState(splitState);

      const pane = await manager.splitPane('@0', 'vertical');

      expect(pane.id).toBe('%1');
    });

    it('throws if no pane in window to split', async () => {
      await manager.start(channel, 1);

      // Empty state — no panes
      tmuxClient.simulateStateChange(emptyState());

      await expect(manager.splitPane('@0')).rejects.toThrow('No pane found in window');
    });

    it('throws on error response', async () => {
      await manager.start(channel, 1);

      const state = buildSimpleState();
      tmuxClient.simulateStateChange(state);
      tmuxClient.enqueueCommandResponse('split-window', errorResponse());

      await expect(manager.splitPane('@0')).rejects.toThrow('Failed to split pane');
    });
  });

  describe('killPane()', () => {
    it('kills a pane and removes its terminal', async () => {
      await manager.start(channel, 1);

      const state = buildSimpleState();
      tmuxClient.simulateStateChange(state);

      // Create a terminal for the pane
      await manager.createPaneTerminal('%0', {} as any);
      expect(terminalManager.getTerminal('ssh-term-1')).toBeDefined();

      await manager.killPane('%0');

      expect(terminalManager.getTerminal('ssh-term-1')).toBeUndefined();
    });
  });

  describe('getPaneTerminal()', () => {
    it('returns undefined when no terminal for pane', async () => {
      await manager.start(channel, 1);

      expect(manager.getPaneTerminal('%0')).toBeUndefined();
    });

    it('returns terminal after creation', async () => {
      await manager.start(channel, 1);

      const state = buildSimpleState();
      tmuxClient.simulateStateChange(state);

      await manager.createPaneTerminal('%0', {} as any);

      const terminal = manager.getPaneTerminal('%0');
      expect(terminal).toBeDefined();
      expect(terminal.id).toBe('ssh-term-1');
    });
  });

  describe('capturePane()', () => {
    it('captures pane content', async () => {
      await manager.start(channel, 1);

      const content = await manager.capturePane('%0');
      expect(content).toBe('line 1\nline 2');
    });
  });

  // -----------------------------------------------------------------------
  // Pane-terminal mapping
  // -----------------------------------------------------------------------

  describe('pane-terminal mapping', () => {
    it('maps pane ID to terminal ID', async () => {
      await manager.start(channel, 1);
      tmuxClient.simulateStateChange(buildSimpleState());

      await manager.createPaneTerminal('%0', {} as any);

      const map = manager.getPaneTerminalMap();
      expect(map.get('%0')).toBe('ssh-term-1');
    });

    it('removes mapping when pane is killed', async () => {
      await manager.start(channel, 1);
      tmuxClient.simulateStateChange(buildSimpleState());

      await manager.createPaneTerminal('%0', {} as any);
      expect(manager.getPaneTerminalMap().has('%0')).toBe(true);

      await manager.killPane('%0');
      expect(manager.getPaneTerminalMap().has('%0')).toBe(false);
    });

    it('cleans up all mappings on stop', async () => {
      await manager.start(channel, 1);
      tmuxClient.simulateStateChange(buildSimpleState());

      await manager.createPaneTerminal('%0', {} as any);

      await manager.stop();

      expect(manager.getPaneTerminalMap().size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // State synchronization
  // -----------------------------------------------------------------------

  describe('state stays in sync with client events', () => {
    it('detects pane removal via state change', async () => {
      await manager.start(channel, 1);

      const state = buildSimpleState();
      tmuxClient.simulateStateChange(state);

      // Create terminal
      await manager.createPaneTerminal('%0', {} as any);
      expect(terminalManager.count).toBe(1);

      // Simulate pane removal — state without the pane
      const stateWithoutPane = { ...state };
      const session = state.sessions.get('$0')!;
      const win = session.windows.get('@0')!;
      const newPanes = new Map(win.panes);
      newPanes.delete('%0');
      const newState: TmuxState = {
        ...state,
        sessions: new Map([
          ['$0', {
            ...session,
            windows: new Map([
              ['@0', { ...win, panes: newPanes, paneOrder: [] }],
            ]),
          }],
        ]),
      };

      tmuxClient.simulateStateChange(newState);

      // Terminal should be cleaned up
      expect(terminalManager.count).toBe(0);
      expect(manager.getPaneTerminalMap().has('%0')).toBe(false);
    });

    it('detects pane addition via state change', async () => {
      await manager.start(channel, 1);

      const state = buildSimpleState();
      tmuxClient.simulateStateChange(state);

      // State with an additional pane (but no terminal for it yet)
      let newState = upsertPane(state, {
        id: '%1', sessionId: '$0', windowId: '@0',
        width: 40, height: 24, title: 'vim', mode: 'normal',
      });

      tmuxClient.simulateStateChange(newState);

      // No terminal auto-created (lazy), but state should reflect the new pane
      const allState = manager.getState();
      const session = allState.sessions.get('$0');
      const win = session?.windows.get('@0');
      expect(win?.panes.has('%1')).toBe(true);
    });
  });
});
