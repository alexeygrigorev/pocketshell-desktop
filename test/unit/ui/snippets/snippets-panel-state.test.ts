import { describe, expect, it } from 'vitest';
import {
  buildSnippetsPanelModel,
  kindToTab,
  renderSnippetsPanelHtml,
} from '../../../../src/ui/snippets/snippets-panel-state';
import {
  normalizeCommandTemplate,
  normalizeSnippet,
} from '../../../../src/agents/snippets';

function makeSnippet(overrides: Partial<Parameters<typeof normalizeSnippet>[0]> = {}) {
  return normalizeSnippet({
    id: 's1',
    name: 'Snip',
    prefix: 'snip',
    body: 'echo hello',
    ...overrides,
  }, undefined, 1);
}

function makeMacro(overrides: Partial<Parameters<typeof normalizeCommandTemplate>[0]> = {}) {
  return normalizeCommandTemplate({
    id: 'm1',
    name: 'Macro',
    commands: 'git pull\nnpm test',
    ...overrides,
  }, undefined, 1);
}

describe('kindToTab', () => {
  it('maps template→commands, snippet→prompts', () => {
    expect(kindToTab('template')).toBe('commands');
    expect(kindToTab('snippet')).toBe('prompts');
  });
});

describe('buildSnippetsPanelModel', () => {
  it('partitions snippets into prompts/commands tabs by kind, macros into macros tab', () => {
    const prompt = makeSnippet({ id: 'p1', kind: 'snippet', body: 'a prompt' });
    const command = makeSnippet({ id: 'c1', kind: 'template', body: 'git status' });
    const macro = makeMacro({ id: 'm1', commands: 'git pull\nnpm test' });

    const model = buildSnippetsPanelModel({
      snippets: [prompt, command],
      macros: [macro],
      tab: 'prompts',
    });

    expect(model.counts).toEqual({ prompts: 1, commands: 1, macros: 1 });
    expect(model.promptRows.map((r) => r.id)).toEqual(['p1']);
    expect(model.commandRows.map((r) => r.id)).toEqual(['c1']);
    expect(model.macroRows.map((r) => r.id)).toEqual(['m1']);
    // Active tab gates which rows the panel renders.
    expect(model.promptRows).toHaveLength(1);
  });

  it('flags rows that contain {{placeholders}}', () => {
    const prompt = makeSnippet({ id: 'p1', body: 'echo {{name}}' });
    const macro = makeMacro({ id: 'm1', commands: 'ssh {{user}}@host' });
    const model = buildSnippetsPanelModel({
      snippets: [prompt],
      macros: [macro],
      tab: 'prompts',
    });
    expect(model.promptRows[0].hasPlaceholders).toBe(true);
    expect(model.macroRows[0].hasPlaceholders).toBe(true);
  });

  it('filters rows by the search query across name/prefix/preview/tags', () => {
    const a = makeSnippet({ id: 'a', name: 'Deploy App', prefix: 'deploy', body: 'git pull', tags: ['ops'] });
    const b = makeSnippet({ id: 'b', name: 'Status', prefix: 'st', body: 'kubectl get pods', kind: 'template' });
    const model = buildSnippetsPanelModel({
      snippets: [a, b],
      macros: [],
      tab: 'commands',
      search: 'kubectl',
    });
    expect(model.commandRows.map((r) => r.id)).toEqual(['b']);
  });

  it('counts are pre-search (badges unaffected by query)', () => {
    const a = makeSnippet({ id: 'a', name: 'Alpha', prefix: 'alpha', body: 'echo a' });
    const b = makeSnippet({ id: 'b', name: 'Beta', prefix: 'beta', body: 'echo b' });
    const model = buildSnippetsPanelModel({
      snippets: [a, b],
      macros: [],
      tab: 'prompts',
      search: 'alpha',
    });
    expect(model.counts.prompts).toBe(2);
    expect(model.promptRows.map((r) => r.id)).toEqual(['a']);
  });

  it('truncates long previews', () => {
    const long = 'x'.repeat(120);
    const prompt = makeSnippet({ id: 'p1', body: long });
    const model = buildSnippetsPanelModel({ snippets: [prompt], macros: [], tab: 'prompts' });
    expect(model.promptRows[0].preview.length).toBeLessThanOrEqual(80);
    expect(model.promptRows[0].preview.endsWith('...')).toBe(true);
  });

  it('computes empty text per tab + search', () => {
    const noMatch = buildSnippetsPanelModel({ snippets: [], macros: [], tab: 'prompts', search: 'zzz' });
    expect(noMatch.emptyText).toContain('zzz');
    const noMacros = buildSnippetsPanelModel({ snippets: [], macros: [], tab: 'macros' });
    expect(noMacros.emptyText.toLowerCase()).toContain('macros');
  });
});

describe('renderSnippetsPanelHtml', () => {
  it('renders tabs with counts, active marker, and search input value', () => {
    const prompt = makeSnippet({ id: 'p1', body: 'echo hi' });
    const model = buildSnippetsPanelModel({
      snippets: [prompt],
      macros: [],
      tab: 'prompts',
      search: 'echo',
    });
    const html = renderSnippetsPanelHtml(model, { cspSource: 'https://example', nonce: 'abc' });
    expect(html).toContain('data-active="true"');
    expect(html).toContain('>Prompts<');
    expect(html).toContain('value="echo"');
    expect(html).toContain('Send+Enter');
    // CSP + nonce wired (nonce-abc appears in the CSP script-src directive).
    expect(html).toContain('nonce="abc"');
    expect(html).toContain('nonce-abc');
  });

  it('renders macro rows with line count and Send/Send+Enter chips', () => {
    const macro = makeMacro({ id: 'm1', commands: 'git pull\nnpm test\necho done' });
    const model = buildSnippetsPanelModel({ snippets: [], macros: [macro], tab: 'macros' });
    const html = renderSnippetsPanelHtml(model, {});
    expect(html).toContain('3 line(s)');
    expect(html).toContain('Send+Enter');
    expect(html).toContain('data-row-id="m1"');
  });

  it('escapes user-controlled text in row previews', () => {
    const prompt = makeSnippet({ id: 'p1', name: '<b>', body: '<script>alert(1)</script>' });
    const model = buildSnippetsPanelModel({ snippets: [prompt], macros: [], tab: 'prompts' });
    const html = renderSnippetsPanelHtml(model, {});
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('emits the status banner when provided', () => {
    const model = buildSnippetsPanelModel({
      snippets: [],
      macros: [],
      tab: 'prompts',
      status: { tone: 'error', message: 'boom' },
    });
    expect(renderSnippetsPanelHtml(model, {})).toContain('boom');
  });
});
