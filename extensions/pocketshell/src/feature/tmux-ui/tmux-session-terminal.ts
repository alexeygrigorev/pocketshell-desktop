import * as vscode from 'vscode';
import { TmuxClient } from '../../backend/tmux/client';
import { SshShellBridge } from '../../backend/tmux/ssh-shell-bridge';
import { ActivePaneTerminalController } from '../../backend/tmux-ui/active-pane-terminal';
import type { ControlEvent } from '../../backend/tmux';
import type { SshConnection } from '../../backend/ssh/connection/ssh-client';

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export class TmuxSessionPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  private controller: ActivePaneTerminalController | undefined;
  private client: TmuxClient | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  readonly onDidClose: vscode.Event<number> = this.closeEmitter.event;

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
      this.closeEmitter.fire(1);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    void this.controller?.detach();
    this.controller = undefined;
  }

  handleInput(data: string): void {
    this.controller?.handleInput(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.controller?.setDimensions(dimensions.columns, dimensions.rows);
  }

  private handleTmuxEvent(event: ControlEvent): void {
    if (event.type === 'client-detached' || event.type === 'exit') {
      if (!this.closed) {
        this.closed = true;
        this.closeEmitter.fire(0);
      }
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
      void this.client?.refreshState();
    }, 50);
  }
}
