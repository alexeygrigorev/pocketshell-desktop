import type { AgentType } from '../reply/types';

export type PromptComposerTarget = PromptComposerAgentTarget | PromptComposerPaneTarget;

export interface PromptComposerAgentTarget {
  kind: 'agent';
  hostId?: number;
  agentType: AgentType;
  sessionId: string;
  label?: string;
  panelKey?: string;
}

export interface PromptComposerPaneTarget {
  kind: 'pane';
  hostId?: number;
  entryId?: string;
  paneId?: string;
  label?: string;
}

export interface PromptComposerOpenArgs {
  target?: PromptComposerTarget;
  prefillText?: string;
  quoteText?: string;
  useLastQuote: boolean;
}

export type PromptComposerStatusKind = 'idle' | 'sending' | 'sent' | 'inserting' | 'inserted' | 'failed';

export interface PromptComposerStatus {
  kind: PromptComposerStatusKind;
  message?: string;
  error?: string;
  failedDraft?: string;
}

export interface PromptComposerPanelModel {
  target: PromptComposerTarget;
  title: string;
  initialDraft: string;
  clearDraftToken: number;
  status: PromptComposerStatus;
}

export interface PromptComposerHtmlRenderOptions {
  cspSource?: string;
  nonce?: string;
}

export interface PromptComposerWebviewState {
  draft?: string;
  clearDraftToken?: number;
  targetKey?: string;
  [key: string]: unknown;
}

export function normalizePromptComposerOpenArgs(input: unknown): PromptComposerOpenArgs {
  const value = isRecord(input) ? input : {};
  const targetInput = isRecord(value.target) ? value.target : value;
  const target = normalizePromptComposerTarget(targetInput);
  return {
    ...(target ? { target } : {}),
    prefillText: stringField(value, 'prefillText') ?? stringField(value, 'prefill') ?? stringField(value, 'text') ?? stringField(value, 'prompt'),
    quoteText: stringField(value, 'quoteText') ?? stringField(value, 'quote') ?? quoteFromPayload(value.quotePayload),
    useLastQuote: value.useLastQuote !== false,
  };
}

export function normalizePromptComposerTarget(input: unknown): PromptComposerTarget | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const kind = stringField(input, 'kind');
  const agentType = normalizeAgentType(input.agentType);
  const sessionId = stringField(input, 'sessionId');
  if ((kind === 'agent' || agentType || sessionId) && agentType && sessionId) {
    return {
      kind: 'agent',
      agentType,
      sessionId,
      hostId: numberField(input, 'hostId'),
      label: stringField(input, 'label'),
      panelKey: stringField(input, 'panelKey'),
    };
  }

  const paneId = stringField(input, 'paneId');
  const entryId = stringField(input, 'entryId');
  if (paneId || entryId) {
    return {
      kind: 'pane',
      hostId: numberField(input, 'hostId'),
      entryId,
      paneId,
      label: stringField(input, 'label'),
    };
  }

  return undefined;
}

export function createPromptComposerPanelModel(
  target: PromptComposerTarget,
  initialDraft = '',
): PromptComposerPanelModel {
  return {
    target,
    title: target.label ?? defaultTargetLabel(target),
    initialDraft,
    clearDraftToken: 0,
    status: { kind: 'idle' },
  };
}

export function buildPromptComposerDraftKey(target: PromptComposerTarget): string {
  if (target.kind === 'agent') {
    return [
      'pocketshell.promptComposer.draft.agent',
      target.hostId ?? 'unknown-host',
      target.agentType,
      target.sessionId,
    ].join(':');
  }
  return [
    'pocketshell.promptComposer.draft.pane',
    target.hostId ?? 'unknown-host',
    target.entryId ?? 'unknown-entry',
    target.paneId ?? 'active',
  ].join(':');
}

export function appendPromptComposerText(draft: string, text: string): string {
  const trimmedText = text.trimEnd();
  if (!trimmedText) {
    return draft;
  }
  const trimmedDraft = draft.trimEnd();
  return trimmedDraft ? `${trimmedDraft}\n\n${trimmedText}\n\n` : `${trimmedText}\n\n`;
}

export function buildInitialPromptDraft(
  storedDraft: string | undefined,
  additions: { quoteText?: string; prefillText?: string } = {},
): string {
  let draft = storedDraft ?? '';
  draft = appendPromptComposerText(draft, additions.quoteText ?? '');
  draft = appendPromptComposerText(draft, additions.prefillText ?? '');
  return draft;
}

export function quoteTargetsPromptComposer(
  quote: { sessionId?: string; agentType?: string; panelKey?: string } | undefined,
  target: PromptComposerTarget,
): boolean {
  if (!quote || target.kind !== 'agent') {
    return false;
  }
  if (quote.panelKey && target.panelKey && quote.panelKey !== target.panelKey) {
    return false;
  }
  return quote.sessionId === target.sessionId && quote.agentType === target.agentType;
}

export function markPromptComposerSending(model: PromptComposerPanelModel): PromptComposerPanelModel {
  return {
    ...model,
    status: { kind: 'sending', message: 'Sending prompt...' },
  };
}

export function markPromptComposerInserting(model: PromptComposerPanelModel): PromptComposerPanelModel {
  return {
    ...model,
    status: { kind: 'inserting', message: 'Inserting prompt...' },
  };
}

export function markPromptComposerSent(model: PromptComposerPanelModel): PromptComposerPanelModel {
  return {
    ...model,
    initialDraft: '',
    clearDraftToken: model.clearDraftToken + 1,
    status: { kind: 'sent', message: 'Prompt sent.' },
  };
}

export function markPromptComposerInserted(model: PromptComposerPanelModel): PromptComposerPanelModel {
  return {
    ...model,
    status: { kind: 'inserted', message: 'Prompt inserted.' },
  };
}

export function markPromptComposerFailed(
  model: PromptComposerPanelModel,
  error: string,
  failedDraft: string,
): PromptComposerPanelModel {
  return {
    ...model,
    status: { kind: 'failed', message: 'Prompt failed.', error, failedDraft },
  };
}

export function persistPromptComposerDraftState(
  state: PromptComposerWebviewState,
  targetKey: string,
  renderedClearDraftToken: number,
  draft: string,
): PromptComposerWebviewState {
  return {
    ...state,
    targetKey,
    draft,
    clearDraftToken: renderedClearDraftToken,
  };
}

export function shouldClearPromptComposerDraft(
  state: PromptComposerWebviewState,
  targetKey: string,
  renderedClearDraftToken: number,
): boolean {
  return state.targetKey !== targetKey || state.clearDraftToken !== renderedClearDraftToken;
}

export function renderPromptComposerHtml(
  model: PromptComposerPanelModel,
  options: PromptComposerHtmlRenderOptions = {},
): string {
  const nonceAttribute = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
  const csp = renderContentSecurityPolicy(options);
  const cspMeta = csp
    ? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">\n`
    : '';
  const targetKey = buildPromptComposerDraftKey(model.target);
  const status = renderStatus(model.status);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta}<meta name="viewport" content="width=device-width, initial-scale=1">
<style${nonceAttribute}>
:root { color-scheme: light dark; }
body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.composer { box-sizing: border-box; min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
.header { display: flex; gap: 8px; align-items: center; min-width: 0; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.target-kind { color: var(--vscode-descriptionForeground); text-transform: uppercase; font-size: 0.85em; }
.body { padding: 12px; }
textarea { box-sizing: border-box; width: 100%; height: 100%; min-height: 260px; resize: none; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 10px; border-radius: 4px; font: inherit; line-height: 1.45; }
.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 10px 12px; border-top: 1px solid var(--vscode-panel-border); }
button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 5px 10px; border-radius: 4px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.55; cursor: default; }
.status { color: var(--vscode-descriptionForeground); }
.status[data-visible="false"] { display: none; }
.status strong { color: var(--vscode-foreground); }
.status .error { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
<section class="composer" aria-label="Prompt composer">
  <header class="header">
    <span class="target-kind">${escapeHtml(model.target.kind)}</span>
    <div class="title">${escapeHtml(model.title)}</div>
  </header>
  <main class="body">
    <textarea data-composer-input aria-label="Prompt text" placeholder="Prompt"></textarea>
  </main>
  <footer class="actions">
    <button type="button" data-action="send">Send</button>
    <button type="button" class="secondary" data-action="insert">Insert</button>
    <button type="button" class="secondary" data-action="restore-failed-draft"${model.status.failedDraft ? '' : ' disabled'}>Restore Failed Draft</button>
    <span class="status" role="status" data-visible="${status.visible ? 'true' : 'false'}">${status.html}</span>
  </footer>
</section>
<script${nonceAttribute}>
const vscode = acquireVsCodeApi();
const renderedTargetKey = ${jsonStringForScript(targetKey)};
const renderedClearDraftToken = ${JSON.stringify(model.clearDraftToken)};
const renderedInitialDraft = ${jsonStringForScript(model.initialDraft)};
const renderedFailedDraft = ${jsonStringForScript(model.status.failedDraft ?? '')};
const composerInput = document.querySelector('[data-composer-input]');
let restoredState = vscode.getState?.() || {};
function setWebviewState(nextState) {
  restoredState = nextState;
  vscode.setState?.(nextState);
}
function persistDraft() {
  const draft = composerInput?.value ?? '';
  setWebviewState({
    ...restoredState,
    targetKey: renderedTargetKey,
    draft,
    clearDraftToken: renderedClearDraftToken,
  });
  vscode.postMessage({ action: 'draft-change', text: draft });
}
function restoreDraft() {
  if (!composerInput) return;
  if (restoredState.targetKey === renderedTargetKey && restoredState.clearDraftToken === renderedClearDraftToken && typeof restoredState.draft === 'string') {
    composerInput.value = restoredState.draft;
    return;
  }
  composerInput.value = renderedInitialDraft;
  persistDraft();
}
function submit(action) {
  if (!composerInput) return;
  persistDraft();
  vscode.postMessage({ action, text: composerInput.value });
}
function insertText(text) {
  if (!composerInput || !text) return;
  const current = composerInput.value.trimEnd();
  composerInput.value = current ? current + '\\n\\n' + text.trimEnd() + '\\n\\n' : text.trimEnd() + '\\n\\n';
  composerInput.focus();
  persistDraft();
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'send' || action === 'insert') {
    submit(action);
    return;
  }
  if (action === 'restore-failed-draft') {
    insertText(renderedFailedDraft);
  }
});
composerInput?.addEventListener('input', persistDraft);
composerInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit('send');
  }
});
window.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.action === 'insert-text' && typeof message.text === 'string') {
    insertText(message.text);
  }
});
window.addEventListener('load', () => {
  restoreDraft();
  composerInput?.focus();
});
</script>
</body>
</html>`;
}

function defaultTargetLabel(target: PromptComposerTarget): string {
  if (target.kind === 'agent') {
    return `${target.agentType}: ${target.sessionId}`;
  }
  return target.paneId ? `tmux pane ${target.paneId}` : 'tmux active pane';
}

function renderStatus(status: PromptComposerStatus): { visible: boolean; html: string } {
  if (status.kind === 'idle') {
    return { visible: false, html: '' };
  }
  const pieces = [`<strong>${escapeHtml(status.kind)}</strong>`];
  if (status.message) {
    pieces.push(escapeHtml(status.message));
  }
  if (status.error) {
    pieces.push(`<span class="error">${escapeHtml(status.error)}</span>`);
  }
  return { visible: true, html: pieces.join(' ') };
}

function renderContentSecurityPolicy(options: PromptComposerHtmlRenderOptions): string | undefined {
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

function normalizeAgentType(value: unknown): AgentType | undefined {
  return value === 'claude' || value === 'codex' || value === 'opencode' ? value : undefined;
}

function quoteFromPayload(value: unknown): string | undefined {
  return isRecord(value) ? stringField(value, 'quote') : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeCspDirectiveValue(value: string): string {
  return value.replace(/[\r\n;]/g, '');
}

function jsonStringForScript(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
