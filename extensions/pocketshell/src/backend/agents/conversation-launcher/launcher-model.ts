/**
 * Conversation launcher sidebar — pure view model.
 *
 * This is the vscode-free state machine that backs the sidebar WebviewView
 * providers in `extensions/pocketshell/src/feature/conversation/` and
 * `feature/prompt-composer/`. The sidebar surfaces a compact launcher for the
 * existing `pocketshell.conversation.*` / `pocketshell.promptComposer.*`
 * commands: it shows the currently-attributed agent session (detected on the
 * active tmux pane), a one-line status, and action buttons that delegate to
 * the real command implementations. It does NOT reimplement the backend.
 *
 * The model is intentionally small and side-effect free so it can be unit
 * tested in isolation and mirrored byte-identically into the extension.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported agent types (mirrors the conversation backend literal union). */
export type LauncherAgentType = 'claude' | 'codex' | 'opencode';

/**
 * A session hint resolved from the active tmux pane. `undefined` means "no
 * session detected for this pane" (the pane is not running a known agent, or
 * multiple ambiguous sessions matched).
 */
export interface LauncherSessionHint {
  agentType: LauncherAgentType;
  sessionId: string;
  label?: string;
  /** Host id the session lives on, when known. */
  hostId?: number;
}

export type LauncherStatusKind =
  | 'idle'
  | 'no-session'
  | 'ambiguous'
  | 'opening-conversation'
  | 'opening-composer'
  | 'open-failed';

export interface LauncherStatus {
  kind: LauncherStatusKind;
  message?: string;
  error?: string;
}

export interface LauncherPanelModel {
  /** The session attributed to the active pane, or undefined. */
  session: LauncherSessionHint | undefined;
  /** Whether attribution was attempted and produced no single match. */
  ambiguous: boolean;
  /** Whether a host connection is currently active for the session. */
  hasConnection: boolean;
  status: LauncherStatus;
  /** Monotonic token bumped whenever the model changes (for dirty checks). */
  revision: number;
}

export interface LauncherHtmlRenderOptions {
  cspSource?: string;
  nonce?: string;
}

// ---------------------------------------------------------------------------
// Construction & mutations
// ---------------------------------------------------------------------------

export function createLauncherPanelModel(): LauncherPanelModel {
  return {
    session: undefined,
    ambiguous: false,
    hasConnection: false,
    status: { kind: 'idle' },
    revision: 0,
  };
}

/** Apply a freshly-resolved attribution result to the model. */
export function applySessionAttribution(
  model: LauncherPanelModel,
  result:
    | { kind: 'match'; session: LauncherSessionHint; hasConnection: boolean }
    | { kind: 'no-match' }
    | { kind: 'ambiguous' },
): LauncherPanelModel {
  if (result.kind === 'match') {
    return bump({
      ...model,
      session: result.session,
      ambiguous: false,
      hasConnection: result.hasConnection,
      status: { kind: 'idle' },
    });
  }
  if (result.kind === 'ambiguous') {
    return bump({
      ...model,
      session: undefined,
      ambiguous: true,
      status: { kind: 'ambiguous', message: 'Multiple agent sessions match the active pane.' },
    });
  }
  return bump({
    ...model,
    session: undefined,
    ambiguous: false,
    hasConnection: false,
    status: { kind: 'no-session', message: 'No agent conversation detected for the active pane.' },
  });
}

export function markOpeningConversation(model: LauncherPanelModel): LauncherPanelModel {
  if (!model.session) {
    return markOpenFailed(model, 'No agent session is available to open.');
  }
  return bump({
    ...model,
    status: { kind: 'opening-conversation', message: 'Opening conversation…' },
  });
}

export function markOpeningComposer(model: LauncherPanelModel): LauncherPanelModel {
  if (!model.session) {
    return markOpenFailed(model, 'No agent session is available for the prompt composer.');
  }
  return bump({
    ...model,
    status: { kind: 'opening-composer', message: 'Opening prompt composer…' },
  });
}

export function markOpenSucceeded(model: LauncherPanelModel): LauncherPanelModel {
  return bump({ ...model, status: { kind: 'idle' } });
}

export function markOpenFailed(model: LauncherPanelModel, error: string): LauncherPanelModel {
  return bump({ ...model, status: { kind: 'open-failed', message: 'Action failed.', error } });
}

export function resetLauncherStatus(model: LauncherPanelModel): LauncherPanelModel {
  if (model.status.kind === 'idle' || model.status.kind === 'no-session' || model.status.kind === 'ambiguous') {
    return model;
  }
  return bump({ ...model, status: model.session ? { kind: 'idle' } : { kind: 'no-session' } });
}

// ---------------------------------------------------------------------------
// Validation / predicates
// ---------------------------------------------------------------------------

/** True when the launcher can offer the "open conversation" / "open composer" actions. */
export function canLaunch(model: LauncherPanelModel): boolean {
  return model.session !== undefined;
}

/** Human-readable title for the sidebar header. */
export function launcherTitle(model: LauncherPanelModel): string {
  const session = model.session;
  if (!session) {
    return model.ambiguous ? 'Ambiguous session' : 'No active session';
  }
  return session.label ?? `${session.agentType}: ${session.sessionId}`;
}

/**
 * Build the command-invocation argument expected by
 * `pocketshell.conversation.openActivePane` (an opaque element passed to the
 * command's host-resolution helper). The launcher hands the host id through so
 * the command can skip interactive host picking.
 */
export function buildConversationOpenElement(
  model: LauncherPanelModel,
): { hostId?: number } | undefined {
  if (!model.session) {
    return undefined;
  }
  return model.session.hostId === undefined ? {} : { hostId: model.session.hostId };
}

/**
 * Build the command-invocation argument expected by
 * `pocketshell.promptComposer.open` — a normalized open-args object whose
 * `target` points at the attributed agent session.
 */
export function buildComposerOpenArgs(
  model: LauncherPanelModel,
): {
  target: {
    kind: 'agent';
    agentType: LauncherAgentType;
    sessionId: string;
    hostId?: number;
    label?: string;
  };
} | undefined {
  const session = model.session;
  if (!session) {
    return undefined;
  }
  return {
    target: {
      kind: 'agent',
      agentType: session.agentType,
      sessionId: session.sessionId,
      ...(session.hostId === undefined ? {} : { hostId: session.hostId }),
      ...(session.label === undefined ? {} : { label: session.label }),
    },
  };
}

// ---------------------------------------------------------------------------
// HTML rendering (pure; no vscode)
// ---------------------------------------------------------------------------

export function renderLauncherHtml(
  model: LauncherPanelModel,
  options: LauncherHtmlRenderOptions = {},
): string {
  const nonceAttribute = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
  const csp = renderContentSecurityPolicy(options);
  const cspMeta = csp
    ? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">\n`
    : '';
  const launchable = canLaunch(model);
  const title = launcherTitle(model);
  const sessionLine = renderSessionLine(model);
  const status = renderStatus(model.status);
  const openButtons = `
    <button type="button" data-action="open-conversation"${launchable ? '' : ' disabled'}>Open Conversation</button>
    <button type="button" data-action="open-composer"${launchable ? '' : ' disabled'}>Open Prompt Composer</button>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta}<meta name="viewport" content="width=device-width, initial-scale=1">
<style${nonceAttribute}>
:root { color-scheme: light dark; }
body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.launcher { display: grid; gap: 10px; padding: 12px; }
.header { font-weight: 600; }
.session { color: var(--vscode-descriptionForeground); font-size: 0.9em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions { display: grid; gap: 8px; }
button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 6px 10px; border-radius: 4px; cursor: pointer; text-align: left; }
button:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.55; cursor: default; }
.status { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.status[data-visible="false"] { display: none; }
.status .error { color: var(--vscode-errorForeground); }
.hint { color: var(--vscode-descriptionForeground); font-size: 0.85em; line-height: 1.4; }
</style>
</head>
<body>
<section class="launcher" aria-label="PocketShell conversation launcher">
  <div class="header">Agent Conversation</div>
  <div class="session" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
  ${sessionLine}
  <div class="actions">
    ${openButtons}
  </div>
  <span class="status" role="status" data-visible="${status.visible ? 'true' : 'false'}">${status.html}</span>
  <p class="hint">The active tmux pane is inspected to find the running agent session. Use the buttons to open the full conversation view or the prompt composer.</p>
</section>
<script${nonceAttribute}>
const vscode = acquireVsCodeApi();
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action !== 'open-conversation' && action !== 'open-composer') return;
  vscode.postMessage({ action });
});
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function bump(model: LauncherPanelModel): LauncherPanelModel {
  return { ...model, revision: model.revision + 1 };
}

function renderSessionLine(model: LauncherPanelModel): string {
  const session = model.session;
  if (!session) {
    return '';
  }
  const connectionLabel = model.hasConnection ? 'connected' : 'host not selected';
  return `<div class="session">${escapeHtml(session.agentType)} · ${escapeHtml(session.sessionId)} · ${escapeHtml(connectionLabel)}</div>`;
}

function renderStatus(status: LauncherStatus): { visible: boolean; html: string } {
  if (status.kind === 'idle') {
    return { visible: false, html: '' };
  }
  const pieces: string[] = [`<strong>${escapeHtml(status.kind)}</strong>`];
  if (status.message) {
    pieces.push(escapeHtml(status.message));
  }
  if (status.error) {
    pieces.push(`<span class="error">${escapeHtml(status.error)}</span>`);
  }
  return { visible: true, html: pieces.join(' ') };
}

function renderContentSecurityPolicy(options: LauncherHtmlRenderOptions): string | undefined {
  if (!options.cspSource || !options.nonce) {
    return undefined;
  }
  const cspSource = escapeCspDirectiveValue(options.cspSource);
  const nonce = escapeCspDirectiveValue(options.nonce);
  return [
    "default-src 'none'",
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeCspDirectiveValue(input: string): string {
  return input.replace(/[\r\n;]/g, '');
}
