import * as vscode from 'vscode';
import { TmuxClient, containsLineBreak } from '../../backend/tmux/client';

/**
 * Decide whether `sendTextToPane` should send `text` as a bracketed paste.
 *
 * App parity (`ShareViewModel.pasteIntoSession`): only multiline PASTE text
 * (`submit:false` + contains `\n`) takes the bracketed-paste route.
 * `submit:true` (run_command / reply / composer submit — explicit "execute
 * this" semantics) and single-line `submit:false` both stay on the legacy
 * `sendInput` path and are byte-unchanged. Pure so it can be unit-tested
 * without a vscode / SSH harness.
 */
export function shouldPasteAsBracketed(submit: boolean, text: string): boolean {
  return !submit && containsLineBreak(text);
}
import { SshShellBridge } from '../../backend/tmux/ssh-shell-bridge';
import { ActivePaneTerminalController, activePaneMetadata, paneMetadata } from '../../backend/tmux-ui/active-pane-terminal';
import type { ControlEvent } from '../../backend/tmux';
import type { TmuxActivePaneMetadata } from '../../backend/tmux-ui/types';
import type { SshConnection } from '../../backend/ssh/connection/ssh-client';

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export class TmuxSessionPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  private controller: ActivePaneTerminalController | undefined;
  private client: TmuxClient | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  readonly onDidClose: vscode.Event<number> = this.closeEmitter.event;
  readonly onDidChangeState: vscode.Event<void> = this.stateEmitter.event;

  constructor(
    private readonly connection: SshConnection,
    private readonly sessionName: string,
    private readonly startDir?: string,
  ) {}

  async open(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
    const columns = initialDimensions?.columns ?? DEFAULT_COLUMNS;
    const rows = initialDimensions?.rows ?? DEFAULT_ROWS;

    try {
      const shell = await this.connection.shell({ cols: columns, rows });
      const channel = new SshShellBridge(shell);
      const client = new TmuxClient({ sessionName: this.sessionName, startDir: this.startDir });
      this.client = client;
      client.on('event', (event: ControlEvent) => {
        this.handleTmuxEvent(event);
      });

      await client.connect(channel);

      const controller = new ActivePaneTerminalController(client, (data) => {
        this.writeEmitter.fire(data);
      });
      this.controller = controller;
      await controller.start(rows);
    } catch (err) {
      this.writeEmitter.fire(`\r\n\x1b[31mFailed to open tmux session: ${err}\x1b[0m\r\n`);
      this.markClosed(1);
    }
  }

  close(): void {
    const controller = this.controller;
    if (!this.markClosed(0)) {
      return;
    }
    void controller?.detach();
  }

  handleInput(data: string): void {
    this.controller?.handleInput(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.controller?.setDimensions(dimensions.columns, dimensions.rows);
  }

  getState() {
    return this.client?.getState();
  }

  async refreshState(): Promise<void> {
    await this.client?.refreshState();
    this.stateEmitter.fire();
  }

  async selectPane(paneId: string, sessionId?: string, windowId?: string): Promise<void> {
    if (!this.controller) {
      throw new Error('tmux terminal is not ready yet');
    }
    await this.controller.selectPane(paneId, sessionId, windowId);
    this.stateEmitter.fire();
  }

  async newWindow(sessionId: string, name?: string, cwd?: string): Promise<void> {
    const response = await this.requireClient().newWindow(sessionId, name, cwd);
    this.throwIfError(response, 'create window');
    await this.refreshState();
  }

  async splitPane(paneId: string, direction: 'horizontal' | 'vertical'): Promise<void> {
    const response = await this.requireClient().splitWindow(paneId, direction === 'horizontal');
    this.throwIfError(response, 'split pane');
    await this.refreshState();
  }

  async splitActivePane(direction: 'horizontal' | 'vertical'): Promise<void> {
    const pane = this.requireActivePane();
    await this.splitPane(pane.id, direction);
  }

  async resizePane(paneId: string, width: number, height: number): Promise<void> {
    await this.requireClient().resizePane(paneId, width, height);
    await this.refreshState();
  }

  async resizeActivePane(width: number, height: number): Promise<void> {
    const pane = this.requireActivePane();
    await this.resizePane(pane.id, width, height);
  }

  async sendTextToPane(paneId: string, text: string, submit = false): Promise<void> {
    const client = this.requireClient();
    const response = shouldPasteAsBracketed(submit, text)
      ? await client.sendBracketedPaste(paneId, text)
      : await client.sendInput(paneId, submit ? `${text}\r` : text);
    this.throwIfError(response, 'send text to pane');
  }

  async sendTextToActivePane(text: string, submit = false): Promise<void> {
    const pane = this.requireActivePane();
    await this.sendTextToPane(pane.id, text, submit);
  }

  async sendKeysToPane(paneId: string, keys: string[]): Promise<void> {
    const response = await this.requireClient().sendKeyNames(paneId, keys);
    this.throwIfError(response, 'send keys to pane');
  }

  async sendKeysToActivePane(keys: string[]): Promise<void> {
    const pane = this.requireActivePane();
    await this.sendKeysToPane(pane.id, keys);
  }

  async capturePane(paneId: string, scrollbackLines = 200): Promise<string> {
    const result = await this.requireClient().captureWithCursor(paneId, Math.max(0, scrollbackLines));
    this.throwIfError(result.capture, 'capture pane');
    return result.capture.output.join('\n');
  }

  async captureActivePane(scrollbackLines = 200): Promise<string> {
    const pane = this.requireActivePane();
    return this.capturePane(pane.id, scrollbackLines);
  }

  getActivePaneMetadata(): TmuxActivePaneMetadata | undefined {
    const state = this.client?.getState();
    return state ? activePaneMetadata(state) : undefined;
  }

  getPaneMetadata(paneId: string): TmuxActivePaneMetadata | undefined {
    const state = this.client?.getState();
    return state ? paneMetadata(state, paneId) : undefined;
  }

  getConnection(): SshConnection {
    return this.connection;
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const response = await this.requireClient().renameSession(sessionId, name);
    this.throwIfError(response, 'rename session');
    await this.refreshState();
  }

  async renameWindow(windowId: string, name: string): Promise<void> {
    const response = await this.requireClient().sendCommand(`rename-window -t ${quoteTmuxArg(windowId)} ${quoteTmuxArg(name)}`);
    this.throwIfError(response, 'rename window');
    await this.refreshState();
  }

  async killSession(sessionId: string): Promise<void> {
    const response = await this.requireClient().killSession(sessionId);
    this.throwIfError(response, 'kill session');
    await this.refreshState();
  }

  async killWindow(windowId: string): Promise<void> {
    const response = await this.requireClient().killWindow(windowId);
    this.throwIfError(response, 'kill window');
    await this.refreshState();
  }

  async killPane(paneId: string): Promise<void> {
    const response = await this.requireClient().killPane(paneId);
    this.throwIfError(response, 'kill pane');
    await this.refreshState();
  }

  async detach(): Promise<void> {
    const controller = this.controller;
    await controller?.detach();
    this.markClosed(0);
  }

  private handleTmuxEvent(event: ControlEvent): void {
    if (event.type === 'client-detached' || event.type === 'exit') {
      this.markClosed(0);
      return;
    }
    if (event.type !== 'output' && event.type !== 'begin' && event.type !== 'end' && event.type !== 'error') {
      this.scheduleStateRefresh();
    }
  }

  private scheduleStateRefresh(): void {
    if (!this.client || this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.client?.refreshState().then(() => this.stateEmitter.fire());
    }, 50);
  }

  private requireClient(): TmuxClient {
    if (!this.client) {
      throw new Error('tmux terminal is not ready yet');
    }
    return this.client;
  }

  private requireActivePane(): TmuxActivePaneMetadata {
    const metadata = this.getActivePaneMetadata();
    if (!metadata) {
      throw new Error('No active tmux pane');
    }
    return metadata;
  }

  private throwIfError(response: { isError: boolean; output: string[] }, action: string): void {
    if (response.isError) {
      throw new Error(`Failed to ${action}: ${response.output.join('\n')}`);
    }
  }

  private markClosed(exitCode: number): boolean {
    if (this.closed) {
      return false;
    }
    this.closed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.controller = undefined;
    this.stateEmitter.dispose();
    this.closeEmitter.fire(exitCode);
    return true;
  }
}

function quoteTmuxArg(input: string): string {
  return `"${input.replace(/[\\"$]/g, (ch) => `\\${ch}`)}"`;
}
