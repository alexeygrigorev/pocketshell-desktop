/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId } from '../../host-picking';
import type { FeatureDeps } from '../manifest';
import type { ConversationAttributionResult } from '../../backend/agents';
import {
  applySessionAttribution,
  buildConversationOpenElement,
  createLauncherPanelModel,
  launcherTitle,
  markOpenFailed,
  markOpenSucceeded,
  markOpeningConversation,
  renderLauncherHtml,
  resetLauncherStatus,
  type LauncherPanelModel,
  type LauncherSessionHint,
} from '../../backend/agents/conversation-launcher';

/**
 * Sidebar view provider that surfaces the agent Conversation view in the
 * reworked shell. This is a NEW surface distinct from the existing editor
 * WebviewPanel opened by `conversation-commands.ts`: a persistent
 * `WebviewView` pinned to the activity bar that inspects the active tmux pane
 * for an attributed agent session and offers a launcher button that delegates
 * to the existing `pocketshell.conversation.openActivePane` command. It does
 * NOT reimplement any backend logic.
 *
 * Registration is deferred: callers wire `registerConversationSidebar()` into
 * the feature manifest's `register` (or extension.ts) in a later batch.
 */
export class ConversationSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'pocketshell.conversation.sidebar';

  private view?: vscode.WebviewView;
  private model: LauncherPanelModel = createLauncherPanelModel();
  private nonce: string = createNonce();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly extensionUri: vscode.Uri;
  private readonly service: ConnectionService;

  constructor(service: ConnectionService, extensionUri: vscode.Uri) {
    this.service = service;
    this.extensionUri = extensionUri;
  }

  /** vscode WebviewViewProvider entry point. */
  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.onDidReceiveMessage(
      (message: { action?: string }) => this.handleMessage(message),
      undefined,
      view,
    );
    view.onDidChangeVisibility(
      () => {
        if (view.visible) {
          void this.refreshAttribution();
        }
      },
      undefined,
      view,
    );
    void this.refreshAttribution().then(() => this.render());
  }

  /** Public hook so the owning feature can refresh when a pane changes. */
  refresh(): void {
    void this.refreshAttribution().then(() => this.render());
  }

  private async handleMessage(message: { action?: string }): Promise<void> {
    if (message.action !== 'open-conversation') {
      return;
    }
    this.model = markOpeningConversation(this.model);
    this.render();
    try {
      const element = buildConversationOpenElement(this.model);
      await vscode.commands.executeCommand('pocketshell.conversation.openActivePane', element);
      this.model = markOpenSucceeded(this.model);
    } catch (err) {
      this.model = markOpenFailed(this.model, errorMessage(err));
    }
    this.render();
    this.scheduleStatusReset();
  }

  private async refreshAttribution(): Promise<void> {
    if (!this.view?.visible) {
      return;
    }
    const connectedHostId = await resolveHostId(this.service, undefined, { connectedOnly: true });
    const hasConnection = connectedHostId !== undefined;
    const hint = await vscode.commands.executeCommand<ConversationAttributionResult | undefined>(
      'pocketshell.tmux-ui.getActivePaneConversationHint',
      undefined,
    );
    this.model = applySessionAttribution(this.model, toAttributionResult(hint, hasConnection, connectedHostId));
  }

  private scheduleStatusReset(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.model = resetLauncherStatus(this.model);
      this.render();
    }, 4000);
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    this.view.description = launcherTitle(this.model);
    this.view.webview.html = renderLauncherHtml(this.model, {
      cspSource: this.view.webview.cspSource,
      nonce: this.nonce,
    });
  }
}

/**
 * Register the conversation sidebar view provider.
 *
 * Returns disposables only; it does NOT register any commands or manifest
 * contributions. The owning feature wires the `view` contribution
 * (`pocketshell.conversation.sidebar`) into `package.json` in a later batch.
 */
export function registerConversationSidebar(
  service: ConnectionService,
  ctx: vscode.ExtensionContext,
  _deps: FeatureDeps,
): vscode.Disposable[] {
  const provider = new ConversationSidebarProvider(service, ctx.extensionUri);
  const registration = vscode.window.registerWebviewViewProvider(
    ConversationSidebarProvider.viewType,
    provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );
  return [registration];
}

function toAttributionResult(
  hint: ConversationAttributionResult | undefined,
  hasConnection: boolean,
  hostId: number | undefined,
):
  | { kind: 'match'; session: LauncherSessionHint; hasConnection: boolean }
  | { kind: 'no-match' }
  | { kind: 'ambiguous' } {
  if (hint?.kind === 'match' && hint.session) {
    const session: LauncherSessionHint = {
      agentType: hint.session.agentType,
      sessionId: hint.session.id,
      label: `${hint.session.agentType}: ${hint.session.id}`,
      ...(hostId === undefined ? {} : { hostId }),
    };
    return { kind: 'match', session, hasConnection };
  }
  if (hint?.kind === 'no-match') {
    return { kind: 'no-match' };
  }
  return hint ? { kind: 'ambiguous' } : { kind: 'no-match' };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function createNonce(): string {
  return randomBytes(16).toString('base64');
}
