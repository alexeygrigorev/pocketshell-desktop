import { describe, it, expect } from 'vitest';
import { ActivePaneTerminalController, selectActivePane, type ActivePaneTerminalClient } from '../../../src/tmux-ui/active-pane-terminal';
import { emptyState, applyEvent, upsertPane } from '../../../src/tmux/state';
import type { TmuxState } from '../../../src/tmux/state';
import type { CommandResponse } from '../../../src/tmux/events';

function ok(output: string[] = []): CommandResponse {
  return { number: 1, output, isError: false };
}

function buildState(activePaneId: string): TmuxState {
  let state = emptyState();
  state = applyEvent(state, { type: 'session-changed', sessionId: '$0', name: 'main' });
  state = applyEvent(state, { type: 'window-add', sessionId: '$0', windowId: '@0', name: 'dev' });
  state = upsertPane(state, {
    id: '%1',
    sessionId: '$0',
    windowId: '@0',
    width: 80,
    height: 24,
    title: 'one',
    mode: 'normal',
  });
  state = upsertPane(state, {
    id: '%2',
    sessionId: '$0',
    windowId: '@0',
    width: 80,
    height: 24,
    title: 'two',
    mode: 'normal',
  });
  return { ...state, activeSessionId: '$0', activeWindowId: '@0', activePaneId };
}

class MockClient implements ActivePaneTerminalClient {
  state = buildState('%1');
  detached = false;
  closed = false;
  inputs: { paneId: string; data: string }[] = [];
  resizes: { paneId: string; width: number; height: number }[] = [];
  selectedPanes: { paneId: string; sessionId?: string; windowId?: string }[] = [];
  commands: string[] = [];
  private stateCallbacks = new Set<(state: TmuxState) => void>();
  private outputCallbacks = new Map<string, Set<(data: Uint8Array) => void>>();

  getState(): TmuxState {
    return this.state;
  }

  async refreshState(): Promise<TmuxState> {
    return this.state;
  }

  onStateChange(callback: (state: TmuxState) => void): { unsubscribe(): void } {
    this.stateCallbacks.add(callback);
    return { unsubscribe: () => this.stateCallbacks.delete(callback) };
  }

  onOutput(paneId: string, callback: (data: Uint8Array) => void): { unsubscribe(): void } {
    let callbacks = this.outputCallbacks.get(paneId);
    if (!callbacks) {
      callbacks = new Set();
      this.outputCallbacks.set(paneId, callbacks);
    }
    callbacks.add(callback);
    return {
      unsubscribe: () => {
        callbacks?.delete(callback);
      },
    };
  }

  async sendInput(paneId: string, data: string): Promise<CommandResponse> {
    this.inputs.push({ paneId, data });
    return ok();
  }

  async resizePane(paneId: string, width: number, height: number): Promise<void> {
    this.resizes.push({ paneId, width, height });
  }

  async selectPane(paneId: string, sessionId?: string, windowId?: string): Promise<CommandResponse> {
    this.selectedPanes.push({ paneId, sessionId, windowId });
    this.state = buildState(paneId);
    return ok();
  }

  async sendCommand(command: string): Promise<CommandResponse> {
    this.commands.push(command);
    return ok(['initial']);
  }

  async detach(): Promise<void> {
    this.detached = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emitOutput(paneId: string, data: string): void {
    this.emitOutputBytes(paneId, Buffer.from(data, 'utf-8'));
  }

  emitOutputBytes(paneId: string, data: Uint8Array): void {
    for (const callback of this.outputCallbacks.get(paneId) ?? []) {
      callback(data);
    }
  }

  emitState(state: TmuxState): void {
    this.state = state;
    for (const callback of this.stateCallbacks) {
      callback(state);
    }
  }
}

describe('ActivePaneTerminalController', () => {
  it('selects the explicit active pane', () => {
    const pane = selectActivePane(buildState('%2'));
    expect(pane?.id).toBe('%2');
  });

  it('falls back to the first pane in the active window', () => {
    const state = { ...buildState('%2'), activePaneId: null };
    const pane = selectActivePane(state);
    expect(pane?.id).toBe('%1');
  });

  it('renders initial capture and streams only the current active pane', async () => {
    const client = new MockClient();
    const writes: string[] = [];
    const controller = new ActivePaneTerminalController(client, (data) => writes.push(data));

    await controller.start(24);
    expect(client.commands[0]).toBe('capture-pane -p -e -S -24 -t "%1"');
    expect(writes).toEqual(['initial', '\r\n']);

    client.emitOutput('%1', 'one');
    client.emitOutput('%2', 'two');
    expect(writes).toEqual(['initial', '\r\n', 'one']);

    client.emitState(buildState('%2'));
    client.emitOutput('%1', 'old');
    client.emitOutput('%2', 'new');
    expect(controller.getActivePaneId()).toBe('%2');
    expect(writes).toEqual(['initial', '\r\n', 'one', 'new']);
  });

  it('decodes multibyte UTF-8 split across output chunks', async () => {
    const client = new MockClient();
    const writes: string[] = [];
    const controller = new ActivePaneTerminalController(client, (data) => writes.push(data));
    const encoded = Buffer.from('€', 'utf-8');

    await controller.start(24);
    client.emitOutputBytes('%1', encoded.subarray(0, 2));
    expect(writes).toEqual(['initial', '\r\n']);

    client.emitOutputBytes('%1', encoded.subarray(2));
    expect(writes).toEqual(['initial', '\r\n', '€']);
  });

  it('sends input and resize to the active pane', async () => {
    const client = new MockClient();
    const controller = new ActivePaneTerminalController(client, () => {});

    await controller.start(10);
    controller.handleInput('ls\r');
    controller.setDimensions(120, 40);

    expect(client.inputs).toEqual([{ paneId: '%1', data: 'ls\r' }]);
    expect(client.resizes).toEqual([{ paneId: '%1', width: 120, height: 40 }]);
  });

  it('selects a pane through tmux and switches streamed output', async () => {
    const client = new MockClient();
    const writes: string[] = [];
    const controller = new ActivePaneTerminalController(client, (data) => writes.push(data));

    await controller.start(10);
    await controller.selectPane('%2', '$0', '@0');
    client.emitOutput('%1', 'old');
    client.emitOutput('%2', 'new');

    expect(client.selectedPanes).toEqual([{ paneId: '%2', sessionId: '$0', windowId: '@0' }]);
    expect(controller.getActivePaneId()).toBe('%2');
    expect(writes).toEqual(['initial', '\r\n', 'new']);
  });

  it('detaches without closing the tmux session explicitly', async () => {
    const client = new MockClient();
    const writes: string[] = [];
    const controller = new ActivePaneTerminalController(client, (data) => writes.push(data));

    await controller.start(10);
    await controller.detach();
    client.emitOutput('%1', 'after');

    expect(client.detached).toBe(true);
    expect(client.closed).toBe(false);
    expect(writes).toEqual(['initial', '\r\n']);
  });
});
