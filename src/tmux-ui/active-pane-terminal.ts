import { StringDecoder } from 'string_decoder';
import type { CommandResponse } from '../tmux/events';
import type { OutputSubscription } from '../tmux/client';
import type { TmuxPane, TmuxState } from '../tmux/state';
import type { TmuxActivePaneMetadata } from './types';

export interface ActivePaneTerminalClient {
  getState(): TmuxState;
  refreshState(): Promise<TmuxState>;
  onStateChange(callback: (state: TmuxState) => void): { unsubscribe(): void };
  onOutput(paneId: string, callback: (data: Uint8Array) => void): OutputSubscription;
  sendInput(paneId: string, data: string): Promise<CommandResponse>;
  sendKeyNames(paneId: string, keys: string[]): Promise<CommandResponse>;
  resizeClient(width: number, height: number): Promise<void>;
  resizePane(paneId: string, width: number, height: number): Promise<void>;
  selectPane(paneId: string, sessionId?: string, windowId?: string): Promise<CommandResponse>;
  sendCommand(command: string): Promise<CommandResponse>;
  detach(): Promise<void>;
  close(): Promise<void>;
}

type WriteCallback = (data: string) => void;

export class ActivePaneTerminalController {
  private outputSubscription: OutputSubscription | undefined;
  private outputDecoder: StringDecoder | undefined;
  private stateSubscription: { unsubscribe(): void } | undefined;
  private activePaneId: string | undefined;
  private disposed = false;

  constructor(
    private readonly client: ActivePaneTerminalClient,
    private readonly write: WriteCallback,
  ) {}

  async start(scrollbackLines: number): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.stateSubscription = this.client.onStateChange((state) => {
      this.updateState(state);
    });
    const state = await this.client.refreshState();
    this.updateState(state);
    await this.renderInitialPane(scrollbackLines);
  }

  handleInput(data: string): void {
    if (this.disposed || !this.activePaneId || data.length === 0) {
      return;
    }
    void this.client.sendInput(this.activePaneId, data);
  }

  setDimensions(width: number, height: number): void {
    if (this.disposed || !this.activePaneId) {
      return;
    }
    void this.client.resizeClient(width, height);
  }

  async detach(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposeSubscriptions();
    this.disposed = true;
    try {
      await this.client.detach();
    } catch {
      await this.client.close();
    }
  }

  getActivePaneId(): string | undefined {
    return this.activePaneId;
  }

  async selectPane(paneId: string, sessionId?: string, windowId?: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    const response = await this.client.selectPane(paneId, sessionId, windowId);
    if (response.isError) {
      throw new Error(response.output.join('\n') || `Failed to select pane ${paneId}`);
    }
    const state = await this.client.refreshState();
    this.updateState(state);
  }

  updateState(state: TmuxState): void {
    if (this.disposed) {
      return;
    }
    const pane = selectActivePane(state);
    const nextPaneId = pane?.id;
    if (nextPaneId === this.activePaneId) {
      return;
    }
    this.flushOutputDecoder();
    this.outputSubscription?.unsubscribe();
    this.outputSubscription = undefined;
    this.activePaneId = nextPaneId;

    if (nextPaneId) {
      this.outputDecoder = new StringDecoder('utf8');
      this.outputSubscription = this.client.onOutput(nextPaneId, (data) => {
        const decoded = this.outputDecoder?.write(Buffer.from(data)) ?? '';
        if (decoded.length > 0) {
          this.write(decoded);
        }
      });
    }
  }

  private async renderInitialPane(scrollbackLines: number): Promise<void> {
    if (!this.activePaneId) {
      this.write('\r\nNo active tmux pane.\r\n');
      return;
    }
    const response = await this.client.sendCommand(
      `capture-pane -p -e -S -${Math.max(0, scrollbackLines)} -t ${quoteTmuxArg(this.activePaneId)}`,
    );
    if (!response.isError && response.output.length > 0) {
      this.write(response.output.join('\r\n'));
      this.write('\r\n');
    }
  }

  private disposeSubscriptions(): void {
    this.flushOutputDecoder();
    this.outputSubscription?.unsubscribe();
    this.outputSubscription = undefined;
    this.stateSubscription?.unsubscribe();
    this.stateSubscription = undefined;
  }

  private flushOutputDecoder(): void {
    const remaining = this.outputDecoder?.end();
    this.outputDecoder = undefined;
    if (remaining && remaining.length > 0) {
      this.write(remaining);
    }
  }
}

export function selectActivePane(state: TmuxState): TmuxPane | undefined {
  const explicit = findPane(state, state.activePaneId);
  if (explicit) {
    return explicit;
  }

  const activeSession = state.activeSessionId ? state.sessions.get(state.activeSessionId) : undefined;
  const activeWindow = activeSession && state.activeWindowId
    ? activeSession.windows.get(state.activeWindowId)
    : undefined;
  if (activeWindow) {
    const pane = firstPane(activeWindow.paneOrder, activeWindow.panes);
    if (pane) {
      return pane;
    }
  }

  if (activeSession) {
    for (const windowId of activeSession.windowOrder) {
      const window = activeSession.windows.get(windowId);
      if (!window) {
        continue;
      }
      const pane = firstPane(window.paneOrder, window.panes);
      if (pane) {
        return pane;
      }
    }
  }

  for (const session of state.sessions.values()) {
    for (const windowId of session.windowOrder) {
      const window = session.windows.get(windowId);
      if (!window) {
        continue;
      }
      const pane = firstPane(window.paneOrder, window.panes);
      if (pane) {
        return pane;
      }
    }
  }
  return undefined;
}

export function activePaneMetadata(state: TmuxState): TmuxActivePaneMetadata | undefined {
  const pane = selectActivePane(state);
  if (!pane) {
    return undefined;
  }
  return {
    id: pane.id,
    sessionId: pane.sessionId,
    windowId: pane.windowId,
    tty: pane.tty,
    cwd: pane.cwd,
    size: {
      width: pane.width,
      height: pane.height,
    },
    process: {
      currentCommand: pane.currentCommand,
      pid: pane.pid,
    },
  };
}

function findPane(state: TmuxState, paneId: string | null): TmuxPane | undefined {
  if (!paneId) {
    return undefined;
  }
  for (const session of state.sessions.values()) {
    for (const window of session.windows.values()) {
      const pane = window.panes.get(paneId);
      if (pane) {
        return pane;
      }
    }
  }
  return undefined;
}

function firstPane(order: string[], panes: Map<string, TmuxPane>): TmuxPane | undefined {
  for (const paneId of order) {
    const pane = panes.get(paneId);
    if (pane) {
      return pane;
    }
  }
  return panes.values().next().value;
}

function quoteTmuxArg(input: string): string {
  return `"${input.replace(/[\\"$]/g, (ch) => `\\${ch}`)}"`;
}
