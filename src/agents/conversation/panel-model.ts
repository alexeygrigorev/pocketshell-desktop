import type { AgentType, ConversationMessage, ConversationSession } from './types';

export interface ConversationPanelModel {
  sessionId: string;
  agentType: AgentType;
  title: string;
  messages: ConversationMessage[];
  search: ConversationSearchState;
  composer: ConversationComposerState;
}

export interface ConversationSearchMatch {
  messageId: string;
  matchCount: number;
}

export interface ConversationSearchState {
  query: string;
  matches: ConversationSearchMatch[];
  activeIndex: number;
}

export interface QuoteReplyPayload {
  sessionId: string;
  agentType: AgentType;
  messageId: string;
  quote: string;
  panelKey?: string;
}

export type ComposerLastStatusKind = 'idle' | 'sending' | 'sent' | 'queued' | 'failed';

export interface ConversationComposerLastStatus {
  kind: ComposerLastStatusKind;
  message?: string;
  error?: string;
  failedDraft?: string;
}

export interface ConversationComposerState {
  pendingCount: number;
  isProcessing: boolean;
  clearDraftToken: number;
  lastStatus: ConversationComposerLastStatus;
}

export interface ConversationHtmlRenderOptions {
  cspSource?: string;
  nonce?: string;
}

export interface ConversationWebviewState {
  draft?: string;
  clearDraftToken?: number;
  [key: string]: unknown;
}

export function createConversationPanelModel(session: ConversationSession): ConversationPanelModel {
  return {
    sessionId: session.id,
    agentType: session.agentType,
    title: `${session.agentType}: ${session.id}`,
    messages: [...session.messages],
    search: createEmptySearchState(),
    composer: createEmptyComposerState(),
  };
}

export function appendConversationMessage(
  model: ConversationPanelModel,
  message: ConversationMessage,
): ConversationPanelModel {
  const existingIds = new Set(model.messages.map((m) => m.id));
  const nextMessage = existingIds.has(message.id)
    ? { ...message, id: `${message.id}-${model.messages.length + 1}` }
    : message;
  const nextModel = {
    ...model,
    messages: [...model.messages, nextMessage],
  };
  return model.search.query ? updateConversationSearch(nextModel, model.search.query, model.search.activeIndex) : nextModel;
}

export function updateConversationSearch(
  model: ConversationPanelModel,
  query: string,
  preferredActiveIndex = 0,
): ConversationPanelModel {
  const normalizedQuery = normalizeSearchText(query).trim();
  if (!normalizedQuery) {
    return {
      ...model,
      search: createEmptySearchState(),
    };
  }
  const matches = model.messages.flatMap((message) => {
    const matchCount = countSearchMatches(messagePlainText(message), normalizedQuery);
    return matchCount > 0 ? [{ messageId: message.id, matchCount }] : [];
  });
  return {
    ...model,
    search: {
      query,
      matches,
      activeIndex: clampSearchIndex(preferredActiveIndex, matches.length),
    },
  };
}

export function navigateConversationSearch(
  model: ConversationPanelModel,
  direction: 'next' | 'previous',
): ConversationPanelModel {
  const { matches, activeIndex } = model.search;
  if (matches.length === 0) {
    return model;
  }
  const delta = direction === 'next' ? 1 : -1;
  return {
    ...model,
    search: {
      ...model.search,
      activeIndex: wrapSearchIndex(activeIndex + delta, matches.length),
    },
  };
}

export function clearConversationSearch(model: ConversationPanelModel): ConversationPanelModel {
  return {
    ...model,
    search: createEmptySearchState(),
  };
}

export function messagePlainText(message: ConversationMessage): string {
  if (message.role !== 'tool') {
    return message.content;
  }
  const parts: string[] = [];
  if (message.toolName) {
    parts.push(`Tool: ${message.toolName}`);
  } else if (message.content) {
    parts.push(message.content);
  }
  if (message.toolInput !== undefined) {
    parts.push(`Input:\n${formatToolValue(message.toolInput)}`);
  }
  if (message.toolOutput !== undefined) {
    parts.push(`Result:\n${message.toolOutput}`);
  }
  return parts.join('\n\n');
}

export function sessionPlainText(model: ConversationPanelModel): string {
  return model.messages
    .map((message) => `${message.role.toUpperCase()}\n${messagePlainText(message)}`)
    .join('\n\n');
}

export function createQuoteReplyPayload(
  model: ConversationPanelModel,
  messageId: string,
  panelKey?: string,
): QuoteReplyPayload | undefined {
  const message = model.messages.find((m) => m.id === messageId);
  if (!message) {
    return undefined;
  }
  return {
    sessionId: model.sessionId,
    agentType: model.agentType,
    messageId: message.id,
    quote: toBlockquote(messagePlainText(message)),
    ...(panelKey ? { panelKey } : {}),
  };
}

export function quotePayloadTargetsPanel(payload: QuoteReplyPayload, panelKey: string): boolean {
  return payload.panelKey === panelKey;
}

export function updateConversationComposer(
  model: ConversationPanelModel,
  composer: Partial<ConversationComposerState>,
): ConversationPanelModel {
  return {
    ...model,
    composer: {
      ...model.composer,
      ...composer,
      lastStatus: composer.lastStatus ?? model.composer.lastStatus,
    },
  };
}

export function markComposerSending(model: ConversationPanelModel): ConversationPanelModel {
  return updateConversationComposer(model, {
    lastStatus: { kind: 'sending', message: 'Sending reply...' },
  });
}

export function markComposerSendSucceeded(model: ConversationPanelModel): ConversationPanelModel {
  return updateConversationComposer(model, {
    clearDraftToken: model.composer.clearDraftToken + 1,
    lastStatus: { kind: 'sent', message: 'Reply sent.' },
  });
}

export function markComposerQueuedReplySent(model: ConversationPanelModel): ConversationPanelModel {
  return updateConversationComposer(model, {
    lastStatus: { kind: 'sent', message: 'Queued reply sent.' },
  });
}

export function markComposerSendFailed(
  model: ConversationPanelModel,
  error: string,
  failedDraft: string,
): ConversationPanelModel {
  return updateConversationComposer(model, {
    lastStatus: { kind: 'failed', message: 'Reply failed.', error, failedDraft },
  });
}

export function markComposerQueued(model: ConversationPanelModel): ConversationPanelModel {
  return updateConversationComposer(model, {
    clearDraftToken: model.composer.clearDraftToken + 1,
    lastStatus: { kind: 'queued', message: 'Reply queued.' },
  });
}

export function insertQuoteIntoDraft(draft: string, quote: string): string {
  const trimmedDraft = draft.trimEnd();
  const trimmedQuote = quote.trimEnd();
  if (!trimmedQuote) {
    return draft;
  }
  return trimmedDraft ? `${trimmedDraft}\n\n${trimmedQuote}\n\n` : `${trimmedQuote}\n\n`;
}

export function persistComposerDraftState(
  state: ConversationWebviewState,
  renderedClearDraftToken: number,
  draft: string,
): ConversationWebviewState {
  return {
    ...state,
    draft,
    clearDraftToken: renderedClearDraftToken,
  };
}

export function shouldClearComposerDraft(
  state: ConversationWebviewState,
  renderedClearDraftToken: number,
): boolean {
  return state.clearDraftToken !== renderedClearDraftToken;
}

export function renderConversationHtml(
  model: ConversationPanelModel,
  options: ConversationHtmlRenderOptions = {},
): string {
  const activeMatch = model.search.matches[model.search.activeIndex];
  const matchedMessageIds = new Set(model.search.matches.map((match) => match.messageId));
  const body = model.messages
    .map((message) => renderMessage(message, matchedMessageIds, activeMatch?.messageId))
    .join('\n');
  const searchCounter = renderSearchCounter(model.search);
  const searchEmptyState = model.search.query && model.search.matches.length === 0
    ? `<div class="search-empty" role="status">No matches for "${escapeHtml(model.search.query)}"</div>`
    : '';
  const nonceAttribute = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
  const csp = renderContentSecurityPolicy(options);
  const cspMeta = csp
    ? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">\n`
    : '';
  const composerStatus = renderComposerStatus(model.composer);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta}<meta name="viewport" content="width=device-width, initial-scale=1">
<style${nonceAttribute}>
:root { color-scheme: light dark; }
body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.toolbar { position: sticky; top: 0; z-index: 1; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.title { font-weight: 600; margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input[type="search"] { min-width: 180px; max-width: 260px; flex: 0 1 240px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 4px 6px; border-radius: 4px; }
button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 4px 8px; border-radius: 4px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.55; cursor: default; }
.search-counter { min-width: 44px; color: var(--vscode-descriptionForeground); text-align: center; }
.search-empty { max-width: 980px; margin: 12px auto 0; padding: 8px 12px; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
.messages { padding: 12px; max-width: 980px; margin: 0 auto; }
.message { border-bottom: 1px solid var(--vscode-panel-border); padding: 12px 0; }
.message.search-match { margin: 0 -8px; padding: 12px 8px; background: var(--vscode-editor-findMatchHighlightBackground); outline: 1px solid var(--vscode-editor-findMatchBorder, transparent); }
.message.search-active { background: var(--vscode-editor-findMatchBackground); outline: 2px solid var(--vscode-focusBorder); }
.message-header { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
.role { font-weight: 700; color: var(--vscode-foreground); text-transform: capitalize; }
.spacer { flex: 1; }
.message-actions { display: flex; gap: 6px; }
.content { line-height: 1.5; overflow-wrap: anywhere; }
.content pre, details pre { overflow: auto; padding: 8px; border-radius: 6px; background: var(--vscode-textCodeBlock-background); }
.content code, details code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
.content :first-child { margin-top: 0; }
.content :last-child { margin-bottom: 0; }
details { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; }
summary { cursor: pointer; font-weight: 600; }
.tool-section { margin-top: 8px; }
.composer { position: sticky; bottom: 0; z-index: 1; padding: 10px 12px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.composer-inner { max-width: 980px; margin: 0 auto; display: grid; gap: 8px; }
.composer-meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
textarea { box-sizing: border-box; width: 100%; min-height: 88px; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 8px; border-radius: 4px; font: inherit; line-height: 1.45; }
.composer-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.composer-status { color: var(--vscode-descriptionForeground); }
.composer-status[data-visible="false"] { display: none; }
.composer-status strong { color: var(--vscode-foreground); }
.composer-status .error { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
<div class="toolbar">
  <div class="title">${escapeHtml(model.title)}</div>
  <input type="search" value="${escapeHtml(model.search.query)}" placeholder="Search conversation" aria-label="Search conversation" data-search-input>
  <button type="button" data-action="search-previous"${model.search.matches.length === 0 ? ' disabled' : ''}>Previous</button>
  <button type="button" data-action="search-next"${model.search.matches.length === 0 ? ' disabled' : ''}>Next</button>
  <span class="search-counter" role="status">${searchCounter}</span>
  <button type="button" data-action="search-clear"${model.search.query ? '' : ' disabled'}>Clear</button>
  <button type="button" data-action="copy-session">Copy Session</button>
  <button type="button" data-action="open-prompt-composer">Open Composer</button>
  <button type="button" data-action="scroll-bottom">Scroll Bottom</button>
</div>
${searchEmptyState}
<main class="messages">
${body}
</main>
<section class="composer" aria-label="Reply composer">
  <div class="composer-inner">
    <div class="composer-meta">Reply to ${escapeHtml(model.agentType)} session ${escapeHtml(model.sessionId)}</div>
    <textarea data-composer-input aria-label="Reply text" placeholder="Type a reply to this agent session"></textarea>
    <div class="composer-actions">
      <button type="button" data-action="send-reply">Send</button>
      <button type="button" data-action="queue-reply">Queue</button>
      <button type="button" data-action="restore-failed-draft"${model.composer.lastStatus.failedDraft ? '' : ' disabled'}>Restore Failed Draft</button>
      <span class="composer-status" role="status" data-composer-status data-visible="${composerStatus.visible ? 'true' : 'false'}">${composerStatus.html}</span>
    </div>
  </div>
</section>
<script${nonceAttribute}>
const vscode = acquireVsCodeApi();
const SEARCH_UPDATE_DELAY_MS = 150;
const renderedSearchQuery = ${jsonStringForScript(model.search.query)};
const renderedClearDraftToken = ${JSON.stringify(model.composer.clearDraftToken)};
const renderedFailedDraft = ${jsonStringForScript(model.composer.lastStatus.failedDraft ?? '')};
const searchInput = document.querySelector('[data-search-input]');
const composerInput = document.querySelector('[data-composer-input]');
let restoredState = vscode.getState?.() || {};
let searchPostTimer;
function setWebviewState(nextState) {
  restoredState = nextState;
  vscode.setState?.(nextState);
}
function nextPersistedState(extra) {
  return {
    ...restoredState,
    query: searchInput?.value ?? restoredState.query,
    selectionStart: searchInput?.selectionStart ?? restoredState.selectionStart,
    selectionEnd: searchInput?.selectionEnd ?? restoredState.selectionEnd,
    scrollY: window.scrollY,
    draft: composerInput?.value ?? restoredState.draft ?? '',
    clearDraftToken: renderedClearDraftToken,
    ...extra,
  };
}
function persistSearchState(pendingSearchInputRender) {
  if (!searchInput) return;
  setWebviewState({
    ...nextPersistedState({}),
    pendingSearchInputRender,
  });
}
function persistComposerState() {
  setWebviewState(nextPersistedState({ pendingSearchInputRender: restoredState.pendingSearchInputRender === true }));
}
function scheduleSearchUpdate() {
  if (!searchInput) return;
  persistSearchState(true);
  window.clearTimeout(searchPostTimer);
  searchPostTimer = window.setTimeout(() => {
    persistSearchState(true);
    vscode.postMessage({ action: 'search-update', query: searchInput.value });
  }, SEARCH_UPDATE_DELAY_MS);
}
function restorePendingSearchInput() {
  if (!searchInput || restoredState.pendingSearchInputRender !== true) {
    return false;
  }
  if (typeof restoredState.query === 'string') {
    searchInput.value = restoredState.query;
  }
  searchInput.focus();
  if (
    typeof restoredState.selectionStart === 'number' &&
    typeof restoredState.selectionEnd === 'number'
  ) {
    searchInput.setSelectionRange(restoredState.selectionStart, restoredState.selectionEnd);
  }
  if (typeof restoredState.scrollY === 'number') {
    window.scrollTo(0, restoredState.scrollY);
  }
  if (searchInput.value !== renderedSearchQuery) {
    scheduleSearchUpdate();
  } else {
    persistSearchState(false);
  }
  return true;
}
function restoreComposerInput() {
  if (!composerInput) return;
  if (restoredState.clearDraftToken !== renderedClearDraftToken) {
    composerInput.value = '';
    setWebviewState(nextPersistedState({ draft: '', clearDraftToken: renderedClearDraftToken }));
    return;
  }
  if (typeof restoredState.draft === 'string') {
    composerInput.value = restoredState.draft;
  }
}
function submitComposer(action) {
  if (!composerInput) return;
  persistComposerState();
  vscode.postMessage({ action, text: composerInput.value });
}
function insertIntoComposer(text) {
  if (!composerInput || !text) return;
  const draft = composerInput.value.trimEnd();
  composerInput.value = draft ? draft + '\\n\\n' + text.trimEnd() + '\\n\\n' : text.trimEnd() + '\\n\\n';
  composerInput.focus();
  persistComposerState();
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'scroll-bottom') {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    return;
  }
  if (action === 'search-clear') {
    window.clearTimeout(searchPostTimer);
    if (searchInput) {
      searchInput.value = '';
    }
    persistSearchState(false);
  }
  if (action === 'send-reply' || action === 'queue-reply') {
    submitComposer(action);
    return;
  }
  if (action === 'restore-failed-draft') {
    insertIntoComposer(renderedFailedDraft);
    return;
  }
  vscode.postMessage({ action, messageId: button.dataset.messageId });
});
searchInput?.addEventListener('input', () => {
  scheduleSearchUpdate();
});
composerInput?.addEventListener('input', () => {
  persistComposerState();
});
window.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.action === 'composer-insert-quote' && typeof message.quote === 'string') {
    insertIntoComposer(message.quote);
  }
});
window.addEventListener('load', () => {
  restoreComposerInput();
  if (restorePendingSearchInput()) {
    return;
  }
  const activeMatch = document.querySelector('.message.search-active');
  if (activeMatch) {
    activeMatch.scrollIntoView({ block: 'center' });
    searchInput?.focus();
    return;
  }
  if (${model.search.query ? 'true' : 'false'}) {
    searchInput?.focus();
    return;
  }
  window.scrollTo(0, document.body.scrollHeight);
});
</script>
</body>
</html>`;
}

function renderContentSecurityPolicy(options: ConversationHtmlRenderOptions): string | undefined {
  if (!options.cspSource || !options.nonce) {
    return undefined;
  }
  const cspSource = escapeCspDirectiveValue(options.cspSource);
  const nonce = escapeCspDirectiveValue(options.nonce);
  return [
    "default-src 'none'",
    `img-src ${cspSource} https: data:`,
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
}

function renderSearchCounter(search: ConversationSearchState): string {
  if (!search.query) {
    return '';
  }
  if (search.matches.length === 0) {
    return '0/0';
  }
  return `${search.activeIndex + 1}/${search.matches.length}`;
}

function renderComposerStatus(composer: ConversationComposerState): { visible: boolean; html: string } {
  const parts: string[] = [];
  if (composer.pendingCount > 0) {
    parts.push(`${composer.pendingCount} pending`);
  }
  if (composer.isProcessing) {
    parts.push('sending queued reply');
  }
  if (composer.lastStatus.kind !== 'idle') {
    const label = composer.lastStatus.kind === 'failed' ? 'failed' : composer.lastStatus.kind;
    const error = composer.lastStatus.error ? ` <span class="error">${escapeHtml(composer.lastStatus.error)}</span>` : '';
    parts.push(`<strong>${escapeHtml(label)}</strong>${composer.lastStatus.message ? ` ${escapeHtml(composer.lastStatus.message)}` : ''}${error}`);
  }
  return {
    visible: composer.pendingCount > 0 || composer.isProcessing || composer.lastStatus.kind !== 'idle',
    html: parts.join(' &middot; '),
  };
}

function renderMessage(
  message: ConversationMessage,
  matchedMessageIds: Set<string>,
  activeMessageId: string | undefined,
): string {
  const classes = ['message'];
  if (matchedMessageIds.has(message.id)) {
    classes.push('search-match');
  }
  if (message.id === activeMessageId) {
    classes.push('search-active');
  }
  const actions = `<div class="message-actions">
    <button type="button" data-action="copy-message" data-message-id="${escapeHtml(message.id)}">Copy</button>
    <button type="button" data-action="quote-reply" data-message-id="${escapeHtml(message.id)}">Quote</button>
  </div>`;
  return `<article class="${classes.join(' ')}" data-message-id="${escapeHtml(message.id)}">
  <header class="message-header">
    <span class="role">${escapeHtml(message.role)}</span>
    ${message.toolName ? `<span>${escapeHtml(message.toolName)}</span>` : ''}
    <span class="spacer"></span>
    ${actions}
  </header>
  ${message.role === 'tool' ? renderToolMessage(message) : `<div class="content">${renderMarkdown(message.content)}</div>`}
</article>`;
}

function renderToolMessage(message: ConversationMessage): string {
  const summary = message.toolName ? `Tool: ${message.toolName}` : message.content || 'Tool result';
  const input = message.toolInput === undefined
    ? ''
    : `<div class="tool-section"><strong>Input</strong><pre><code>${escapeHtml(formatToolValue(message.toolInput))}</code></pre></div>`;
  const output = message.toolOutput === undefined
    ? ''
    : `<div class="tool-section"><strong>Result</strong><pre><code>${escapeHtml(message.toolOutput)}</code></pre></div>`;
  return `<details>
    <summary>${escapeHtml(summary)}</summary>
    ${input}
    ${output}
  </details>`;
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${renderInlineMarkdown(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i += 1;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i += 1;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join('\n'))}</p>`);
  }
  return blocks.join('\n');
}

function renderInlineMarkdown(input: string): string {
  const segments = input.split(/(`[^`]*`)/g);
  return segments.map((segment) => {
    if (segment.startsWith('`') && segment.endsWith('`')) {
      return `<code>${escapeHtml(segment.slice(1, -1))}</code>`;
    }
    return renderLinks(escapeHtml(segment)).replace(/\n/g, '<br>');
  }).join('');
}

function renderLinks(escaped: string): string {
  return escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, href: string) => `<a href="${escapeHtml(href)}">${label}</a>`,
  );
}

function toBlockquote(text: string): string {
  const body = text.trim() || '(empty message)';
  return body.split('\n').map((line) => `> ${line}`).join('\n');
}

function createEmptySearchState(): ConversationSearchState {
  return {
    query: '',
    matches: [],
    activeIndex: 0,
  };
}

function createEmptyComposerState(): ConversationComposerState {
  return {
    pendingCount: 0,
    isProcessing: false,
    clearDraftToken: 0,
    lastStatus: { kind: 'idle' },
  };
}

function countSearchMatches(text: string, normalizedQuery: string): number {
  const normalizedText = normalizeSearchText(text);
  let count = 0;
  let index = normalizedText.indexOf(normalizedQuery);
  while (index !== -1) {
    count += 1;
    index = normalizedText.indexOf(normalizedQuery, index + normalizedQuery.length);
  }
  return count;
}

function normalizeSearchText(text: string): string {
  return text.replace(/\s+/g, ' ').toLocaleLowerCase();
}

function clampSearchIndex(index: number, matchCount: number): number {
  if (matchCount === 0) {
    return 0;
  }
  return Math.min(Math.max(index, 0), matchCount - 1);
}

function wrapSearchIndex(index: number, matchCount: number): number {
  return ((index % matchCount) + matchCount) % matchCount;
}

function jsonStringForScript(input: string): string {
  return JSON.stringify(input)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function formatToolValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
  return input.replace(/[;\s]/g, '');
}
