import { describe, expect, it } from 'vitest';
import {
  appendConversationMessage,
  createConversationPanelModel,
  createQuoteReplyPayload,
  messagePlainText,
  renderConversationHtml,
  renderMarkdown,
  sessionPlainText,
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
});
