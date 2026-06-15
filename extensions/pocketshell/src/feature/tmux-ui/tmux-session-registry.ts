import * as vscode from 'vscode';
import { buildSnapshot } from '../../backend/tmux-ui/snapshot-builder';
import type { TmuxTreeSnapshot } from '../../backend/tmux-ui/types';
import type { TmuxSessionPseudoterminal } from './tmux-session-terminal';

export interface RegisteredTmuxSession {
  id: string;
  hostId: number;
  hostLabel: string;
  sessionName: string;
  terminal: vscode.Terminal;
  pty: TmuxSessionPseudoterminal;
}

export interface TmuxSessionTreeEntry {
  id: string;
  label: string;
  hostId: number;
  hostLabel: string;
  sessionName: string;
  terminal: vscode.Terminal;
  pty: TmuxSessionPseudoterminal;
  snapshot: TmuxTreeSnapshot | undefined;
}

export class TmuxSessionRegistry implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly sessions = new Map<string, RegisteredTmuxSession>();
  private readonly disposables = new Map<string, vscode.Disposable[]>();
  private nextId = 1;

  readonly onDidChange = this.changeEmitter.event;

  register(options: Omit<RegisteredTmuxSession, 'id'>): vscode.Disposable {
    const id = `tmux-ui-${this.nextId++}`;
    const entry: RegisteredTmuxSession = { id, ...options };
    this.sessions.set(id, entry);

    const stateSub = options.pty.onDidChangeState(() => this.changeEmitter.fire());
    const closeSub = options.pty.onDidClose(() => this.unregister(id));
    this.disposables.set(id, [stateSub, closeSub]);
    this.changeEmitter.fire();

    return new vscode.Disposable(() => this.unregister(id));
  }

  get(id: string): RegisteredTmuxSession | undefined {
    return this.sessions.get(id);
  }

  entries(): TmuxSessionTreeEntry[] {
    return [...this.sessions.values()].map((entry) => {
      const state = entry.pty.getState();
      return {
        ...entry,
        label: `${entry.hostLabel}: ${entry.sessionName}`,
        snapshot: state ? buildSnapshot(state, new Map()) : undefined,
      };
    });
  }

  dispose(): void {
    for (const id of this.sessions.keys()) {
      this.unregister(id);
    }
    this.changeEmitter.dispose();
  }

  private unregister(id: string): void {
    if (!this.sessions.has(id)) {
      return;
    }
    this.sessions.delete(id);
    const disposables = this.disposables.get(id) ?? [];
    this.disposables.delete(id);
    for (const disposable of disposables) {
      disposable.dispose();
    }
    this.changeEmitter.fire();
  }
}
