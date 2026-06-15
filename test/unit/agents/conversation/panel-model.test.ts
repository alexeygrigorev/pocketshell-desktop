import { describe, expect, it } from 'vitest';
import {
  appendConversationMessage,
  clearConversationSearch,
  createConversationPanelModel,
  createQuoteReplyPayload,
  insertQuoteIntoDraft,
  markComposerQueued,
  markComposerQueuedReplySent,
  markComposerSendFailed,
  markComposerSendSucceeded,
  messagePlainText,
  navigateConversationSearch,
  persistComposerDraftState,
  quotePayloadTargetsPanel,
  renderConversationHtml,
  renderMarkdown,
  sessionPlainText,
  shouldClearComposerDraft,
  updateConversationSearch,
} from '../../../../src/agents/conversation/panel-model';
import type { ConversationSession } from '../../../../src/agents/conversation/types';
import { AgentType } from '../../../../src/agents/types';

function session(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    id: 's1',
    agentType: AgentType.Codex,
    startedAt: 1,
    messageCount: 2,
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: '# Hello\n\n<script>alert(1)</script>\n\n- item with `code`\n\n[ok](https://example.com)',
        timestamp: 1,
      },
      {
        id: 'm2',
        role: 'tool',
        content: 'Tool: shell',
        timestamp: 2,
        toolName: 'shell',
        toolInput: { cmd: 'ls <bad>' },
        toolOutput: 'done > now',
      },
    ],
    ...overrides,
  };
}

describe('conversation panel model', () => {
  it('renders escaped lightweight markdown', () => {
    const html = renderMarkdown('# Title\n\n<script>x</script>\n\n- run `npm test`\n\n[site](https://example.com)');

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('<li>run <code>npm test</code></li>');
    expect(html).toContain('<a href="https://example.com">site</a>');
  });

  it('renders tool messages as collapsible details', () => {
    const model = createConversationPanelModel(session());
    const html = renderConversationHtml(model);

    expect(html).toContain('<details>');
    expect(html).toContain('<summary>Tool: shell</summary>');
    expect(html).toContain('&lt;bad&gt;');
    expect(html).toContain('done &gt; now');
  });

  it('renders a strict CSP and matching nonces when options are provided', () => {
    const model = createConversationPanelModel(session());
    const html = renderConversationHtml(model, {
      cspSource: 'vscode-webview://1234',
      nonce: 'test-nonce',
    });

    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src &#39;none&#39;");
    expect(html).toContain('style-src vscode-webview://1234 &#39;nonce-test-nonce&#39;');
    expect(html).toContain('script-src &#39;nonce-test-nonce&#39;');
    expect(html).toContain('<style nonce="test-nonce">');
    expect(html).toContain('<script nonce="test-nonce">');
    expect(html).not.toContain('unsafe-inline');
  });

  it('builds plain text for message and session copy', () => {
    const model = createConversationPanelModel(session());

    expect(messagePlainText(model.messages[1])).toContain('Tool: shell');
    expect(messagePlainText(model.messages[1])).toContain('"cmd": "ls <bad>"');
    expect(sessionPlainText(model)).toContain('USER\n# Hello');
    expect(sessionPlainText(model)).toContain('TOOL\nTool: shell');
  });

  it('builds quote-reply payloads as blockquotes', () => {
    const model = createConversationPanelModel(session());
    const payload = createQuoteReplyPayload(model, 'm1');

    expect(payload).toEqual({
      sessionId: 's1',
      agentType: AgentType.Codex,
      messageId: 'm1',
      quote: [
        '> # Hello',
        '> ',
        '> <script>alert(1)</script>',
        '> ',
        '> - item with `code`',
        '> ',
        '> [ok](https://example.com)',
      ].join('\n'),
    });
  });

  it('builds panel-scoped quote payloads for composer insertion', () => {
    const model = createConversationPanelModel(session());
    const payload = createQuoteReplyPayload(model, 'm1', 'host-1:codex:s1');

    expect(payload?.panelKey).toBe('host-1:codex:s1');
    expect(quotePayloadTargetsPanel(payload!, 'host-1:codex:s1')).toBe(true);
    expect(quotePayloadTargetsPanel(payload!, 'host-2:codex:s1')).toBe(false);
    expect(quotePayloadTargetsPanel({ ...payload!, panelKey: undefined }, 'host-1:codex:s1')).toBe(false);
  });

  it('inserts quotes into empty and existing composer drafts', () => {
    expect(insertQuoteIntoDraft('', '> quoted')).toBe('> quoted\n\n');
    expect(insertQuoteIntoDraft('Please explain', '> quoted')).toBe('Please explain\n\n> quoted\n\n');
  });

  it('appends tail messages without mutating previous state', () => {
    const initial = createConversationPanelModel(session({ messages: [] }));
    const next = appendConversationMessage(initial, {
      id: 'tail-1',
      role: 'assistant',
      content: 'new',
      timestamp: 3,
    });

    expect(initial.messages).toHaveLength(0);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].content).toBe('new');
  });

  it('calculates full-text search results over message and tool text', () => {
    const model = updateConversationSearch(createConversationPanelModel(session()), 'shell');

    expect(model.search.query).toBe('shell');
    expect(model.search.matches).toEqual([{ messageId: 'm2', matchCount: 1 }]);
    expect(model.search.activeIndex).toBe(0);
  });

  it('normalizes search text across case and whitespace', () => {
    const model = createConversationPanelModel(session({
      messages: [
        { id: 'm1', role: 'assistant', content: 'Alpha\n\nBeta', timestamp: 1 },
      ],
    }));

    expect(updateConversationSearch(model, 'alpha beta').search.matches).toEqual([
      { messageId: 'm1', matchCount: 1 },
    ]);
  });

  it('wraps search navigation and leaves empty results bounded', () => {
    const model = updateConversationSearch(createConversationPanelModel(session({
      messages: [
        { id: 'm1', role: 'assistant', content: 'needle one', timestamp: 1 },
        { id: 'm2', role: 'user', content: 'needle two', timestamp: 2 },
      ],
    })), 'needle');

    expect(navigateConversationSearch(model, 'previous').search.activeIndex).toBe(1);
    expect(navigateConversationSearch(
      navigateConversationSearch(model, 'next'),
      'next',
    ).search.activeIndex).toBe(0);

    const empty = updateConversationSearch(model, 'missing');
    expect(empty.search.activeIndex).toBe(0);
    expect(navigateConversationSearch(empty, 'next')).toBe(empty);
  });

  it('recomputes active search results when tail messages append', () => {
    const initial = updateConversationSearch(createConversationPanelModel(session({ messages: [] })), 'tail');
    const next = appendConversationMessage(initial, {
      id: 'tail-1',
      role: 'tool',
      content: 'Tool: shell',
      timestamp: 3,
      toolName: 'shell',
      toolInput: { cmd: 'echo tail' },
      toolOutput: 'tail output',
    });

    expect(next.search.query).toBe('tail');
    expect(next.search.matches).toEqual([{ messageId: 'tail-1', matchCount: 2 }]);
  });

  it('clears search state', () => {
    const model = updateConversationSearch(createConversationPanelModel(session()), 'shell');

    expect(clearConversationSearch(model).search).toEqual({
      query: '',
      matches: [],
      activeIndex: 0,
    });
  });

  it('renders clear no-match state without blocking messages', () => {
    const model = updateConversationSearch(createConversationPanelModel(session()), 'absent');
    const html = renderConversationHtml(model);

    expect(html).toContain('No matches for "absent"');
    expect(html).toContain('0/0');
    expect(html).toContain('data-message-id="m1"');
    expect(html).not.toContain('class="message search-active"');
  });

  it('renders escaped search state and active message highlight', () => {
    const model = updateConversationSearch(createConversationPanelModel(session()), '<script>');
    const html = renderConversationHtml(model);

    expect(html).toContain('value="&lt;script&gt;"');
    expect(html).toContain('class="message search-match search-active" data-message-id="m1"');
    expect(html).not.toContain('value="<script>"');
  });

  it('renders a debounced search input contract with restored input state', () => {
    const model = createConversationPanelModel(session());
    const html = renderConversationHtml(model);
    const debounceIndex = html.indexOf('searchPostTimer = window.setTimeout');
    const updateIndex = html.indexOf("vscode.postMessage({ action: 'search-update'");

    expect(html).toContain('const SEARCH_UPDATE_DELAY_MS = 150');
    expect(html).toContain('setWebviewState({');
    expect(html).toContain('let restoredState = vscode.getState?.() || {};');
    expect(html).toContain('function setWebviewState(nextState)');
    expect(html).toContain('restorePendingSearchInput()');
    expect(debounceIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(debounceIndex);
    expect(html).not.toContain("searchInput?.addEventListener('input', () => {\n  vscode.postMessage");
  });

  it('renders a composer pre-bound to the current session and agent', () => {
    const model = createConversationPanelModel(session());
    const html = renderConversationHtml(model);

    expect(html).toContain('Reply to codex session s1');
    expect(html).toContain('data-composer-input');
    expect(html).toContain('data-action="open-prompt-composer"');
    expect(html).toContain('data-action="send-reply"');
    expect(html).toContain('data-action="queue-reply"');
    expect(html).toContain('renderedClearDraftToken = 0');
    expect(html).toContain("vscode.postMessage({ action, text: composerInput.value })");
    expect(html).toContain('let restoredState = vscode.getState?.() || {};');
    expect(html).toContain('restoredState = nextState;');
    expect(html).toContain('clearDraftToken: renderedClearDraftToken');
    expect(html).not.toContain('clearDraftToken: restoredState.clearDraftToken');
  });

  it('preserves a draft across a normal same-token rerender', () => {
    const renderedClearDraftToken = 0;
    let webviewState = {};

    expect(shouldClearComposerDraft(webviewState, renderedClearDraftToken)).toBe(true);
    webviewState = persistComposerDraftState(webviewState, renderedClearDraftToken, '');
    expect(shouldClearComposerDraft(webviewState, renderedClearDraftToken)).toBe(false);

    webviewState = persistComposerDraftState(webviewState, renderedClearDraftToken, 'draft reply');
    expect(shouldClearComposerDraft(webviewState, renderedClearDraftToken)).toBe(false);
    expect(webviewState).toMatchObject({
      draft: 'draft reply',
      clearDraftToken: renderedClearDraftToken,
    });
  });

  it('shows queue status when replies are pending or processing', () => {
    const model = markComposerQueued(createConversationPanelModel(session()));
    const processing = {
      ...model,
      composer: {
        ...model.composer,
        pendingCount: 2,
        isProcessing: true,
      },
    };
    const html = renderConversationHtml(processing);

    expect(html).toContain('data-visible="true"');
    expect(html).toContain('2 pending');
    expect(html).toContain('sending queued reply');
    expect(html).toContain('<strong>queued</strong> Reply queued.');
  });

  it('advances the clear token only for accepted queue or direct send success', () => {
    const model = createConversationPanelModel(session());
    const queued = markComposerQueued(model);
    const sent = markComposerSendSucceeded(model);
    const queuedSent = markComposerQueuedReplySent(queued);

    expect(queued.composer.clearDraftToken).toBe(1);
    expect(sent.composer.clearDraftToken).toBe(1);
    expect(queuedSent.composer.clearDraftToken).toBe(queued.composer.clearDraftToken);
    expect(queuedSent.composer.lastStatus).toEqual({ kind: 'sent', message: 'Queued reply sent.' });
  });

  it('preserves failed draft text for retry without advancing the clear token', () => {
    const model = createConversationPanelModel(session());
    const failed = markComposerSendFailed(model, 'network down', 'unsent text');
    const html = renderConversationHtml(failed);

    expect(failed.composer.clearDraftToken).toBe(0);
    expect(failed.composer.lastStatus.failedDraft).toBe('unsent text');
    expect(html).toContain('<strong>failed</strong> Reply failed.');
    expect(html).toContain('network down');
    expect(html).toContain('const renderedFailedDraft = "unsent text";');
    expect(html).toContain('data-action="restore-failed-draft"');
  });

  it('reschedules an unsent restored search query after a tail render replacement', () => {
    const model = updateConversationSearch(createConversationPanelModel(session()), 'server query');
    const html = renderConversationHtml(model);
    const compareIndex = html.indexOf('if (searchInput.value !== renderedSearchQuery)');
    const scheduleIndex = html.indexOf('scheduleSearchUpdate();', compareIndex);
    const clearPendingIndex = html.indexOf('persistSearchState(false);', compareIndex);

    expect(html).toContain('const renderedSearchQuery = "server query";');
    expect(compareIndex).toBeGreaterThan(-1);
    expect(scheduleIndex).toBeGreaterThan(compareIndex);
    expect(clearPendingIndex).toBeGreaterThan(scheduleIndex);
  });

  it('escapes the rendered search query for script context', () => {
    const model = updateConversationSearch(createConversationPanelModel(session()), '</script>');
    const html = renderConversationHtml(model);

    expect(html).toContain('const renderedSearchQuery = "\\u003c/script\\u003e";');
    expect(html).not.toContain('const renderedSearchQuery = "</script>";');
  });
});
