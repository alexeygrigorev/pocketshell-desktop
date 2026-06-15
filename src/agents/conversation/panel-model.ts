import type { AgentType, ConversationMessage, ConversationSession } from './types';

export interface ConversationPanelModel {
  sessionId: string;
  agentType: AgentType;
  title: string;
  messages: ConversationMessage[];
}

export interface QuoteReplyPayload {
  sessionId: string;
  agentType: AgentType;
  messageId: string;
  quote: string;
}

export interface ConversationHtmlRenderOptions {
  cspSource?: string;
  nonce?: string;
}

export function createConversationPanelModel(session: ConversationSession): ConversationPanelModel {
  return {
    sessionId: session.id,
    agentType: session.agentType,
    title: `${session.agentType}: ${session.id}`,
    messages: [...session.messages],
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
  return {
    ...model,
    messages: [...model.messages, nextMessage],
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
  };
}

export function renderConversationHtml(
  model: ConversationPanelModel,
  options: ConversationHtmlRenderOptions = {},
): string {
  const body = model.messages.map(renderMessage).join('\n');
  const nonceAttribute = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
  const csp = renderContentSecurityPolicy(options);
  const cspMeta = csp
    ? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">\n`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta}<meta name="viewport" content="width=device-width, initial-scale=1">
<style${nonceAttribute}>
:root { color-scheme: light dark; }
body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.toolbar { position: sticky; top: 0; z-index: 1; display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.title { font-weight: 600; margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 4px 8px; border-radius: 4px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
.messages { padding: 12px; max-width: 980px; margin: 0 auto; }
.message { border-bottom: 1px solid var(--vscode-panel-border); padding: 12px 0; }
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
</style>
</head>
<body>
<div class="toolbar">
  <div class="title">${escapeHtml(model.title)}</div>
  <button type="button" data-action="copy-session">Copy Session</button>
  <button type="button" data-action="scroll-bottom">Scroll Bottom</button>
</div>
<main class="messages">
${body}
</main>
<script${nonceAttribute}>
const vscode = acquireVsCodeApi();
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'scroll-bottom') {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    return;
  }
  vscode.postMessage({ action, messageId: button.dataset.messageId });
});
window.addEventListener('load', () => window.scrollTo(0, document.body.scrollHeight));
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

function renderMessage(message: ConversationMessage): string {
  const actions = `<div class="message-actions">
    <button type="button" data-action="copy-message" data-message-id="${escapeHtml(message.id)}">Copy</button>
    <button type="button" data-action="quote-reply" data-message-id="${escapeHtml(message.id)}">Quote</button>
  </div>`;
  return `<article class="message" data-message-id="${escapeHtml(message.id)}">
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
