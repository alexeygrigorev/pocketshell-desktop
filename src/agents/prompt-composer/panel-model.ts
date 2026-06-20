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
export type PromptComposerAttachmentStatus = 'staged' | 'uploading' | 'uploaded' | 'error';

export interface PromptComposerStatus {
  kind: PromptComposerStatusKind;
  message?: string;
  error?: string;
  failedDraft?: string;
}

export interface PromptComposerAttachment {
  id: string;
  localPath: string;
  name: string;
  displayName: string;
  status: PromptComposerAttachmentStatus;
  size?: number;
  remotePath?: string;
  error?: string;
}

export interface PromptComposerAttachmentInput {
  id: string;
  localPath: string;
  displayName?: string;
  size?: number;
}

export interface PromptComposerAttachmentRemotePlan {
  targetFragment: string;
  stagingDirectory: string;
  remotePath: string;
  filename: string;
}

export interface PromptComposerInsertResolution {
  target?: PromptComposerPaneTarget;
  error?: string;
}

export interface PromptComposerPanelModel {
  target: PromptComposerTarget;
  title: string;
  initialDraft: string;
  clearDraftToken: number;
  status: PromptComposerStatus;
  attachments: PromptComposerAttachment[];
  dictationEnabled: boolean;
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
  options: { dictationEnabled?: boolean } = {},
): PromptComposerPanelModel {
  return {
    target,
    title: target.label ?? defaultTargetLabel(target),
    initialDraft,
    clearDraftToken: 0,
    status: { kind: 'idle' },
    attachments: [],
    dictationEnabled: options.dictationEnabled === true,
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
    attachments: [],
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

export function addPromptComposerAttachments(
  model: PromptComposerPanelModel,
  files: PromptComposerAttachmentInput[],
): PromptComposerPanelModel {
  const existingNames = new Set(model.attachments.map((attachment) => attachment.name));
  const attachments = files.map((file) => {
    const displayName = file.displayName?.trim() || basenameFromPath(file.localPath) || 'attachment';
    const name = uniqueAttachmentFileName(sanitizePromptComposerFileName(displayName), existingNames);
    existingNames.add(name);
    return {
      id: file.id,
      localPath: file.localPath,
      displayName,
      name,
      status: 'staged' as const,
      size: file.size,
    };
  });
  return {
    ...model,
    attachments: [...model.attachments, ...attachments],
  };
}

export function removePromptComposerAttachment(
  model: PromptComposerPanelModel,
  attachmentId: string,
): PromptComposerPanelModel {
  return {
    ...model,
    attachments: model.attachments.filter((attachment) => attachment.id !== attachmentId),
  };
}

export function markPromptComposerAttachmentUploading(
  model: PromptComposerPanelModel,
  attachmentId: string,
  remotePath?: string,
): PromptComposerPanelModel {
  return updatePromptComposerAttachment(model, attachmentId, (attachment) => ({
    ...attachment,
    status: 'uploading',
    remotePath: remotePath ?? attachment.remotePath,
    error: undefined,
  }));
}

export function markPromptComposerAttachmentUploaded(
  model: PromptComposerPanelModel,
  attachmentId: string,
  remotePath: string,
): PromptComposerPanelModel {
  return updatePromptComposerAttachment(model, attachmentId, (attachment) => ({
    ...attachment,
    status: 'uploaded',
    remotePath,
    error: undefined,
  }));
}

export function markPromptComposerAttachmentError(
  model: PromptComposerPanelModel,
  attachmentId: string,
  error: string,
): PromptComposerPanelModel {
  return updatePromptComposerAttachment(model, attachmentId, (attachment) => ({
    ...attachment,
    status: 'error',
    error,
  }));
}

export function planPromptComposerAttachmentRemotePath(
  target: PromptComposerTarget,
  attachment: Pick<PromptComposerAttachment, 'name'>,
  options: { remoteHome?: string; baseDirectory?: string } = {},
): PromptComposerAttachmentRemotePlan {
  const targetFragment = sanitizePromptComposerTargetFragment(buildPromptComposerAttachmentTargetKey(target));
  const baseDirectory = normalizeRemoteBaseDirectory(options.remoteHome, options.baseDirectory);
  const stagingDirectory = `${baseDirectory}/${targetFragment}`;
  const filename = sanitizePromptComposerFileName(attachment.name);
  return {
    targetFragment,
    stagingDirectory,
    remotePath: `${stagingDirectory}/${filename}`,
    filename,
  };
}

export function buildPromptComposerAttachmentContext(attachments: readonly PromptComposerAttachment[]): string {
  const uploaded = attachments.filter((attachment) => attachment.status === 'uploaded' && attachment.remotePath);
  if (uploaded.length === 0) {
    return '';
  }
  const lines = [
    'Attached files are available on the remote host:',
    ...uploaded.map((attachment) => `- ${attachment.displayName}: ${attachment.remotePath}`),
  ];
  return lines.join('\n');
}

export function findPromptComposerAttachmentSendBlocker(
  attachments: readonly PromptComposerAttachment[],
): string | undefined {
  const failed = attachments.find((attachment) => attachment.status === 'error');
  if (failed) {
    return `Attachment upload failed for ${failed.displayName}: ${failed.error ?? 'Unknown upload error'}`;
  }
  const pending = attachments.find((attachment) => attachment.status !== 'uploaded');
  if (pending) {
    return `Attachment ${pending.displayName} is not uploaded yet`;
  }
  return undefined;
}

export function buildPromptComposerPromptText(text: string, attachments: readonly PromptComposerAttachment[]): string {
  const blocker = findPromptComposerAttachmentSendBlocker(attachments);
  if (blocker) {
    throw new Error(blocker);
  }
  const trimmedText = text.trimEnd();
  const context = buildPromptComposerAttachmentContext(attachments);
  if (!context) {
    return trimmedText;
  }
  return trimmedText ? `${trimmedText}\n\n${context}` : context;
}

export function sanitizePromptComposerFileName(value: string): string {
  const stripped = value
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
    ?.trim() ?? '';
  const sanitized = stripped
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+$/, '')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return sanitized || 'attachment';
}

export function sanitizePromptComposerTargetFragment(value: string): string {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 120);
  return sanitized || 'target';
}

export function canResolvePromptComposerPaneHostFromTarget(target: PromptComposerPaneTarget): boolean {
  return target.hostId !== undefined || Boolean(target.entryId);
}

export function promptComposerPaneTargetsMatchRequest(
  requested: PromptComposerPaneTarget,
  resolved: PromptComposerPaneTarget,
): boolean {
  if (requested.hostId !== undefined && resolved.hostId !== requested.hostId) {
    return false;
  }
  if (requested.entryId && resolved.entryId !== requested.entryId) {
    return false;
  }
  if (requested.paneId && resolved.paneId !== requested.paneId) {
    return false;
  }
  return true;
}

export function resolvePromptComposerInsertTarget(
  target: PromptComposerTarget,
  insertTarget?: PromptComposerPaneTarget,
): PromptComposerInsertResolution {
  if (target.kind === 'pane') {
    if (target.hostId === undefined) {
      return { error: 'No connected host is available for this tmux pane' };
    }
    return { target };
  }
  if (!insertTarget) {
    return { error: 'Insert requires a tmux pane opened from the same host as this agent session' };
  }
  if (target.hostId === undefined) {
    return { error: 'No connected host is available for this agent session' };
  }
  if (insertTarget.hostId === undefined) {
    return { error: 'No connected host is available for the insert tmux pane' };
  }
  if (insertTarget.hostId !== target.hostId) {
    return { error: 'Insert target must be on the same host as this agent session' };
  }
  return { target: insertTarget };
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
  const attachments = renderAttachments(model.attachments);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta}<meta name="viewport" content="width=device-width, initial-scale=1">
<style${nonceAttribute}>
:root { color-scheme: light dark; }
body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.composer { box-sizing: border-box; min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
.composer[data-drop-active="true"] { outline: 2px dashed var(--vscode-focusBorder); outline-offset: -4px; }
.header { display: flex; gap: 8px; align-items: center; min-width: 0; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.target-kind { color: var(--vscode-descriptionForeground); text-transform: uppercase; font-size: 0.85em; }
.body { padding: 12px; min-height: 0; }
textarea { box-sizing: border-box; width: 100%; height: 100%; min-height: 260px; resize: none; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 10px; border-radius: 4px; font: inherit; line-height: 1.45; }
.attachments { display: grid; gap: 6px; padding: 0 12px 10px; }
.attachments[data-visible="false"] { display: none; }
.attachment { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: center; padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
.attachment-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment-status { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.attachment-status[data-status="uploaded"] { color: var(--vscode-testing-iconPassed); }
.attachment-status[data-status="error"] { color: var(--vscode-errorForeground); }
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
  ${attachments}
  <footer class="actions">
    <button type="button" data-action="send">Send</button>
    <button type="button" class="secondary" data-action="insert">Insert</button>
    ${model.dictationEnabled ? '<button type="button" class="secondary" data-action="dictate">Dictate</button>' : ''}
    <button type="button" class="secondary" data-action="attach">Attach</button>
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
  if (action === 'attach') {
    persistDraft();
    vscode.postMessage({ action: 'attach-files' });
    return;
  }
  if (action === 'dictate') {
    persistDraft();
    vscode.postMessage({ action: 'dictate', text: composerInput?.value ?? '' });
    return;
  }
  if (action === 'remove-attachment') {
    persistDraft();
    vscode.postMessage({ action, attachmentId: button.dataset.attachmentId });
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
function readDroppedFiles(dataTransfer) {
  if (!dataTransfer || typeof dataTransfer.items === 'undefined') {
    return [];
  }
  const files = [];
  for (let i = 0; i < dataTransfer.items.length; i += 1) {
    const item = dataTransfer.items[i];
    if (item && item.kind === 'file') {
      const file = item.getAsFile();
      if (file) {
        files.push({ path: String(file.path || file.name || ''), name: String(file.name || '') });
      }
    }
  }
  return files;
}
document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  const composer = document.querySelector('.composer');
  if (composer) composer.setAttribute('data-drop-active', 'true');
});
document.addEventListener('dragleave', (event) => {
  if (event.relatedTarget && event.relatedTarget !== document) return;
  const composer = document.querySelector('.composer');
  if (composer) composer.removeAttribute('data-drop-active');
});
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer) return;
  event.preventDefault();
  const composer = document.querySelector('.composer');
  if (composer) composer.removeAttribute('data-drop-active');
  const droppedFiles = readDroppedFiles(event.dataTransfer);
  const droppedText = (typeof event.dataTransfer.getData === 'function' ? event.dataTransfer.getData('text/plain') : '') || '';
  if (droppedFiles.length === 0 && !droppedText) return;
  persistDraft();
  vscode.postMessage({
    action: 'drop',
    text: droppedText,
    files: droppedFiles.map((file) => file.path || file.name).filter((value) => Boolean(value)),
  });
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

function renderAttachments(attachments: readonly PromptComposerAttachment[]): string {
  if (attachments.length === 0) {
    return '<section class="attachments" aria-label="Attachments" data-visible="false"></section>';
  }
  const rows = attachments.map((attachment) => {
    const status = attachment.status === 'error' && attachment.error
      ? `${attachment.status}: ${attachment.error}`
      : attachment.status;
    return `<div class="attachment" data-attachment-id="${escapeHtml(attachment.id)}">
      <span class="attachment-name" title="${escapeHtml(attachment.displayName)}">${escapeHtml(attachment.displayName)}</span>
      <span class="attachment-status" data-status="${escapeHtml(attachment.status)}" title="${escapeHtml(status)}">${escapeHtml(status)}</span>
      <button type="button" class="secondary" data-action="remove-attachment" data-attachment-id="${escapeHtml(attachment.id)}">Remove</button>
    </div>`;
  }).join('');
  return `<section class="attachments" aria-label="Attachments" data-visible="true">${rows}</section>`;
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

function updatePromptComposerAttachment(
  model: PromptComposerPanelModel,
  attachmentId: string,
  update: (attachment: PromptComposerAttachment) => PromptComposerAttachment,
): PromptComposerPanelModel {
  return {
    ...model,
    attachments: model.attachments.map((attachment) => (
      attachment.id === attachmentId ? update(attachment) : attachment
    )),
  };
}

function uniqueAttachmentFileName(name: string, existingNames: ReadonlySet<string>): string {
  if (!existingNames.has(name)) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let index = 2;
  let candidate = `${base}-${index}${extension}`;
  while (existingNames.has(candidate)) {
    index += 1;
    candidate = `${base}-${index}${extension}`;
  }
  return candidate;
}

function buildPromptComposerAttachmentTargetKey(target: PromptComposerTarget): string {
  if (target.kind === 'agent') {
    return [
      'agent',
      target.hostId ?? 'unknown-host',
      target.agentType,
      target.sessionId,
    ].join('-');
  }
  return [
    'pane',
    target.hostId ?? 'unknown-host',
    target.entryId ?? 'unknown-entry',
    target.paneId ?? 'active',
  ].join('-');
}

function normalizeRemoteBaseDirectory(remoteHome?: string, baseDirectory?: string): string {
  const base = (baseDirectory?.trim() || '.pocketshell/attachments').replace(/\/+$/, '');
  if (base.startsWith('/') || base.startsWith('~')) {
    return base;
  }
  const home = remoteHome?.trim().replace(/\/+$/, '');
  return home ? `${home}/${base}` : `~/${base}`;
}

function basenameFromPath(value: string): string | undefined {
  return value.split(/[\\/]/).filter(Boolean).pop();
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
