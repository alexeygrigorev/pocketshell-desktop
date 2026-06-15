import { describe, expect, it } from 'vitest';
import {
  addPromptComposerAttachments,
  appendPromptComposerTranscript,
  appendPromptComposerText,
  buildPromptComposerAttachmentContext,
  buildInitialPromptDraft,
  buildPromptComposerDraftKey,
  buildPromptComposerPromptText,
  canResolvePromptComposerPaneHostFromTarget,
  createPromptComposerDictationProvider,
  createPromptComposerPanelModel,
  findPromptComposerAttachmentSendBlocker,
  getPromptComposerDictationAvailability,
  markPromptComposerAttachmentError,
  markPromptComposerAttachmentUploaded,
  markPromptComposerAttachmentUploading,
  markPromptComposerFailed,
  markPromptComposerSent,
  readPromptComposerDictationConfig,
  normalizePromptComposerOpenArgs,
  persistPromptComposerDraftState,
  planPromptComposerAttachmentRemotePath,
  promptComposerPaneTargetsMatchRequest,
  quoteTargetsPromptComposer,
  removePromptComposerAttachment,
  renderPromptComposerHtml,
  resolvePromptComposerInsertTarget,
  sanitizePromptComposerFileName,
  sanitizePromptComposerTargetFragment,
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

  it('keeps dictation off by default and does not require an API key', () => {
    const config = readPromptComposerDictationConfig(undefined, {});
    const availability = getPromptComposerDictationAvailability(config);
    const model = createPromptComposerPanelModel({
      kind: 'agent',
      hostId: 1,
      agentType: 'codex',
      sessionId: 's1',
    });
    const html = renderPromptComposerHtml(model);

    expect(config.provider).toBe('none');
    expect(config.openAiApiKey).toBeUndefined();
    expect(availability.enabled).toBe(false);
    expect(createPromptComposerDictationProvider(config, {})).toBeUndefined();
    expect(html).not.toContain('data-action="dictate"');
  });

  it('requires an OpenAI key only when the OpenAI dictation provider is enabled', () => {
    const missingKey = readPromptComposerDictationConfig({
      promptComposerDictationProvider: 'openai',
    }, {});
    const withEnvKey = readPromptComposerDictationConfig({
      promptComposerDictationProvider: 'openai',
    }, {
      OPENAI_API_KEY: 'env-key',
    });

    expect(getPromptComposerDictationAvailability(missingKey)).toEqual({
      enabled: false,
      provider: 'openai',
      reason: 'OpenAI dictation requires an API key.',
    });
    expect(getPromptComposerDictationAvailability(withEnvKey)).toEqual({
      enabled: true,
      provider: 'openai',
    });
  });

  it('supports local/system provider abstraction without an API key', async () => {
    const calls: string[] = [];
    const config = readPromptComposerDictationConfig({
      promptComposerDictationProvider: 'system',
      promptComposerDictationCommand: 'dictate-once',
    }, {});
    const provider = createPromptComposerDictationProvider(config, {
      runCommand: async (command) => {
        calls.push(command);
        return '  hello from dictation  \n';
      },
    });

    await expect(provider?.transcribe()).resolves.toBe('hello from dictation');
    expect(calls).toEqual(['dictate-once']);
  });

  it('appends transcripts into composer drafts and renders dictation controls only when enabled', () => {
    const target = {
      kind: 'pane' as const,
      hostId: 1,
      entryId: 'tmux-ui-1',
      paneId: '%1',
    };
    const disabled = createPromptComposerPanelModel(target);
    const enabled = createPromptComposerPanelModel(target, 'existing', { dictationEnabled: true });
    const html = renderPromptComposerHtml(enabled);

    expect(appendPromptComposerTranscript('existing', 'spoken prompt')).toBe('existing\n\nspoken prompt\n\n');
    expect(appendPromptComposerTranscript('', 'spoken prompt\n')).toBe('spoken prompt\n\n');
    expect(renderPromptComposerHtml(disabled)).not.toContain('data-action="dictate"');
    expect(html).toContain('data-action="dictate"');
    expect(html).toContain("vscode.postMessage({ action: 'dictate', text: composerInput?.value ?? '' })");
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

  it('sanitizes attachment filenames and target fragments for remote staging paths', () => {
    expect(sanitizePromptComposerFileName('../a file?.txt')).toBe('a_file_.txt');
    expect(sanitizePromptComposerFileName('..')).toBe('attachment');
    expect(sanitizePromptComposerTargetFragment('pane:1:%4/../../x')).toBe('pane-1-4-x');

    const plan = planPromptComposerAttachmentRemotePath({
      kind: 'agent',
      hostId: 7,
      agentType: 'codex',
      sessionId: 'session/with spaces',
    }, { name: '../context.md' }, { remoteHome: '/home/dev' });

    expect(plan).toEqual({
      targetFragment: 'agent-7-codex-session-with-spaces',
      stagingDirectory: '/home/dev/.pocketshell/attachments/agent-7-codex-session-with-spaces',
      remotePath: '/home/dev/.pocketshell/attachments/agent-7-codex-session-with-spaces/context.md',
      filename: 'context.md',
    });
  });

  it('stages, updates, removes, and preserves prompt attachments with failed drafts', () => {
    const model = createPromptComposerPanelModel({
      kind: 'pane',
      hostId: 2,
      entryId: 'tmux-ui-1',
      paneId: '%1',
    }, 'draft');
    const staged = addPromptComposerAttachments(model, [
      { id: 'a1', localPath: '/tmp/report.txt', displayName: 'report.txt', size: 12 },
      { id: 'a2', localPath: '/tmp/other/report.txt', displayName: 'report.txt' },
    ]);
    const uploading = markPromptComposerAttachmentUploading(staged, 'a1', '/remote/report.txt');
    const uploaded = markPromptComposerAttachmentUploaded(uploading, 'a1', '/remote/report.txt');
    const failed = markPromptComposerAttachmentError(uploaded, 'a2', 'disk full');
    const failedPrompt = markPromptComposerFailed(failed, 'Attachment upload failed', 'draft text');
    const removed = removePromptComposerAttachment(failedPrompt, 'a2');

    expect(staged.attachments.map((attachment) => attachment.name)).toEqual(['report.txt', 'report-2.txt']);
    expect(uploading.attachments[0]).toMatchObject({ status: 'uploading', remotePath: '/remote/report.txt' });
    expect(uploaded.attachments[0]).toMatchObject({ status: 'uploaded', error: undefined });
    expect(failed.attachments[1]).toMatchObject({ status: 'error', error: 'disk full' });
    expect(failedPrompt.status.failedDraft).toBe('draft text');
    expect(failedPrompt.attachments).toHaveLength(2);
    expect(removed.attachments).toHaveLength(1);
    expect(removed.initialDraft).toBe('draft');
  });

  it('builds prompt attachment context and blocks pending or failed attachments', () => {
    const model = addPromptComposerAttachments(createPromptComposerPanelModel({
      kind: 'agent',
      hostId: 1,
      agentType: 'claude',
      sessionId: 's1',
    }), [
      { id: 'a1', localPath: '/tmp/a.txt', displayName: 'a.txt' },
      { id: 'a2', localPath: '/tmp/b.txt', displayName: 'b.txt' },
    ]);
    const oneUploaded = markPromptComposerAttachmentUploaded(model, 'a1', '/home/dev/.pocketshell/attachments/t/a.txt');
    const failed = markPromptComposerAttachmentError(oneUploaded, 'a2', 'permission denied');
    const uploadedOnly = oneUploaded.attachments.filter((attachment) => attachment.id === 'a1');

    expect(buildPromptComposerAttachmentContext(oneUploaded.attachments)).toBe(
      'Attached files are available on the remote host:\n- a.txt: /home/dev/.pocketshell/attachments/t/a.txt',
    );
    expect(findPromptComposerAttachmentSendBlocker(oneUploaded.attachments)).toBe('Attachment b.txt is not uploaded yet');
    expect(findPromptComposerAttachmentSendBlocker(failed.attachments)).toBe(
      'Attachment upload failed for b.txt: permission denied',
    );
    expect(() => buildPromptComposerPromptText('Use these', oneUploaded.attachments)).toThrow('not uploaded yet');
    expect(() => buildPromptComposerPromptText('Use these', failed.attachments)).toThrow('permission denied');
    expect(buildPromptComposerPromptText('Use these', uploadedOnly)).toBe(
      'Use these\n\nAttached files are available on the remote host:\n- a.txt: /home/dev/.pocketshell/attachments/t/a.txt',
    );
  });

  it('renders attachment controls and upload states in the webview contract', () => {
    const model = markPromptComposerAttachmentError(
      addPromptComposerAttachments(createPromptComposerPanelModel({
        kind: 'agent',
        hostId: 1,
        agentType: 'codex',
        sessionId: 's1',
      }), [
        { id: 'a1', localPath: '/tmp/<bad>.txt', displayName: '<bad>.txt' },
      ]),
      'a1',
      'upload failed',
    );
    const html = renderPromptComposerHtml(model);

    expect(html).toContain('data-action="attach"');
    expect(html).toContain('data-action="remove-attachment"');
    expect(html).toContain('&lt;bad&gt;.txt');
    expect(html).toContain('error: upload failed');
    expect(html).toContain("vscode.postMessage({ action: 'attach-files' })");
  });

  it('requires pane host resolution from a tmux entry before attachment upload', () => {
    expect(canResolvePromptComposerPaneHostFromTarget({
      kind: 'pane',
      paneId: '%1',
    })).toBe(false);
    expect(canResolvePromptComposerPaneHostFromTarget({
      kind: 'pane',
      entryId: 'tmux-ui-1',
      paneId: '%1',
    })).toBe(true);
    expect(promptComposerPaneTargetsMatchRequest({
      kind: 'pane',
      entryId: 'tmux-ui-1',
      paneId: '%1',
    }, {
      kind: 'pane',
      hostId: 1,
      entryId: 'tmux-ui-1',
      paneId: '%1',
    })).toBe(true);
    expect(promptComposerPaneTargetsMatchRequest({
      kind: 'pane',
      entryId: 'tmux-ui-1',
      paneId: '%1',
    }, {
      kind: 'pane',
      hostId: 2,
      entryId: 'tmux-ui-2',
      paneId: '%1',
    })).toBe(false);
  });

  it('requires agent insert targets to be known same-host panes', () => {
    const agentTarget = {
      kind: 'agent' as const,
      hostId: 1,
      agentType: 'codex' as const,
      sessionId: 's1',
    };

    expect(resolvePromptComposerInsertTarget(agentTarget)).toEqual({
      error: 'Insert requires a tmux pane opened from the same host as this agent session',
    });
    expect(resolvePromptComposerInsertTarget(agentTarget, {
      kind: 'pane',
      hostId: 2,
      entryId: 'tmux-ui-2',
      paneId: '%2',
    })).toEqual({
      error: 'Insert target must be on the same host as this agent session',
    });
    expect(resolvePromptComposerInsertTarget(agentTarget, {
      kind: 'pane',
      hostId: 1,
      entryId: 'tmux-ui-1',
      paneId: '%1',
    })).toEqual({
      target: {
        kind: 'pane',
        hostId: 1,
        entryId: 'tmux-ui-1',
        paneId: '%1',
      },
    });
    expect(resolvePromptComposerInsertTarget({
      kind: 'pane',
      entryId: 'tmux-ui-1',
      paneId: '%1',
    })).toEqual({
      error: 'No connected host is available for this tmux pane',
    });
  });
});
