import { describe, expect, it } from 'vitest';
import {
  appendPromptComposerText,
  buildInitialPromptDraft,
  buildPromptComposerDraftKey,
  createPromptComposerPanelModel,
  markPromptComposerFailed,
  markPromptComposerSent,
  normalizePromptComposerOpenArgs,
  persistPromptComposerDraftState,
  quoteTargetsPromptComposer,
  renderPromptComposerHtml,
  shouldClearPromptComposerDraft,
} from '../../../../src/agents/prompt-composer';

describe('prompt composer panel model', () => {
  it('normalizes agent command arguments and prefill aliases', () => {
    const args = normalizePromptComposerOpenArgs({
      target: {
        kind: 'agent',
        hostId: 7,
        agentType: 'codex',
        sessionId: 's1',
        panelKey: '7:codex:s1',
      },
      prompt: 'review this file',
      quotePayload: { quote: '> quoted' },
    });

    expect(args).toEqual({
      target: {
        kind: 'agent',
        hostId: 7,
        agentType: 'codex',
        sessionId: 's1',
        label: undefined,
        panelKey: '7:codex:s1',
      },
      prefillText: 'review this file',
      quoteText: '> quoted',
      useLastQuote: true,
    });
  });

  it('normalizes pane targets only when a concrete pane or entry is present', () => {
    expect(normalizePromptComposerOpenArgs({ kind: 'pane' }).target).toBeUndefined();
    expect(normalizePromptComposerOpenArgs({
      kind: 'pane',
      hostId: 2,
      entryId: 'tmux-ui-1',
      paneId: '%3',
    }).target).toEqual({
      kind: 'pane',
      hostId: 2,
      entryId: 'tmux-ui-1',
      paneId: '%3',
      label: undefined,
    });
  });

  it('builds stable per-target draft keys', () => {
    expect(buildPromptComposerDraftKey({
      kind: 'agent',
      hostId: 1,
      agentType: 'claude',
      sessionId: 'abc',
    })).toBe('pocketshell.promptComposer.draft.agent:1:claude:abc');

    expect(buildPromptComposerDraftKey({
      kind: 'pane',
      hostId: 1,
      entryId: 'tmux-ui-2',
      paneId: '%4',
    })).toBe('pocketshell.promptComposer.draft.pane:1:tmux-ui-2:%4');
  });

  it('combines stored drafts with quote and prefill text', () => {
    expect(appendPromptComposerText('', '> quote')).toBe('> quote\n\n');
    expect(buildInitialPromptDraft('existing', {
      quoteText: '> quote',
      prefillText: 'explain this',
    })).toBe('existing\n\n> quote\n\nexplain this\n\n');
  });

  it('matches stored quote replies to agent targets', () => {
    const target = {
      kind: 'agent' as const,
      hostId: 1,
      agentType: 'codex' as const,
      sessionId: 's1',
      panelKey: '1:codex:s1',
    };

    expect(quoteTargetsPromptComposer({ agentType: 'codex', sessionId: 's1', panelKey: '1:codex:s1' }, target)).toBe(true);
    expect(quoteTargetsPromptComposer({ agentType: 'claude', sessionId: 's1' }, target)).toBe(false);
    expect(quoteTargetsPromptComposer({ agentType: 'codex', sessionId: 's2' }, target)).toBe(false);
    expect(quoteTargetsPromptComposer({ agentType: 'codex', sessionId: 's1', panelKey: '2:codex:s1' }, target)).toBe(false);
  });

  it('preserves drafts in webview state per target and clear token', () => {
    const targetKey = 'pocketshell.promptComposer.draft.agent:1:codex:s1';
    let state = {};

    expect(shouldClearPromptComposerDraft(state, targetKey, 0)).toBe(true);
    state = persistPromptComposerDraftState(state, targetKey, 0, 'draft');
    expect(shouldClearPromptComposerDraft(state, targetKey, 0)).toBe(false);
    expect(shouldClearPromptComposerDraft(state, targetKey, 1)).toBe(true);
    expect(shouldClearPromptComposerDraft(state, `${targetKey}:other`, 0)).toBe(true);
  });

  it('renders send, insert, Enter submit, and strict CSP contracts', () => {
    const model = createPromptComposerPanelModel({
      kind: 'agent',
      hostId: 1,
      agentType: 'codex',
      sessionId: 's1',
    }, '</script>');
    const html = renderPromptComposerHtml(model, {
      cspSource: 'vscode-webview://1234',
      nonce: 'test-nonce',
    });

    expect(html).toContain('data-action="send"');
    expect(html).toContain('data-action="insert"');
    expect(html).toContain("event.key === 'Enter' && !event.shiftKey");
    expect(html).toContain("submit('send')");
    expect(html).toContain("vscode.postMessage({ action, text: composerInput.value })");
    expect(html).toContain('const renderedInitialDraft = "\\u003c/script\\u003e";');
    expect(html).toContain("default-src &#39;none&#39;");
    expect(html).toContain('<script nonce="test-nonce">');
    expect(html).not.toContain('unsafe-inline');
  });

  it('clears only after successful send and preserves failed drafts', () => {
    const model = createPromptComposerPanelModel({
      kind: 'pane',
      hostId: 1,
      entryId: 'tmux-ui-1',
      paneId: '%1',
    }, 'draft');
    const sent = markPromptComposerSent(model);
    const failed = markPromptComposerFailed(model, 'network down', 'draft');

    expect(sent.clearDraftToken).toBe(1);
    expect(sent.initialDraft).toBe('');
    expect(failed.clearDraftToken).toBe(0);
    expect(failed.status.failedDraft).toBe('draft');
    expect(renderPromptComposerHtml(failed)).toContain('network down');
  });
});
