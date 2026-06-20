import { describe, expect, it, vi } from 'vitest';
import { SlashCommandPalette } from '../../../../src/agents/palette/command-palette';
import type { SlashCommand } from '../../../../src/agents/palette/types';
import {
  SnippetValidationError,
  checkCommandTemplateRunScope,
  checkSnippetRunScope,
  deleteCommandTemplate,
  deleteSnippet,
  expandCommandTemplateLines,
  expandSnippetBody,
  extractPlaceholderNames,
  filterCommandTemplatesByScope,
  filterSnippetsByScope,
  getCommandTemplate,
  getSnippet,
  normalizeCommandTemplate,
  normalizeSnippet,
  parseCommandTemplateLibrary,
  parseSnippetLibrary,
  resolvePlaceholders,
  snippetToPaletteCommand,
  splitCommandLines,
  upsertCommandTemplate,
  upsertSnippet,
} from '../../../../src/agents/snippets';

describe('snippet model', () => {
  it('normalizes text, array bodies, tags, scope, and generated ids', () => {
    const snippet = normalizeSnippet({
      name: '  Deploy App  ',
      prefix: ' /Deploy App ',
      body: ['git pull', 'npm test'],
      kind: 'template',
      scope: { type: 'host', hostId: 42 },
      description: '  Deploy from git  ',
      tags: ' deploy, ops, deploy ',
    }, undefined, 1_000);

    expect(snippet).toMatchObject({
      id: 'deploy-app-rs',
      name: 'Deploy App',
      prefix: 'deploy-app',
      body: 'git pull\nnpm test',
      kind: 'template',
      scope: { type: 'host', hostId: 42 },
      description: 'Deploy from git',
      tags: ['deploy', 'ops'],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  it('rejects invalid snippets', () => {
    expect(() => normalizeSnippet({
      name: 'Missing body',
      prefix: 'missing',
      body: '',
    })).toThrow(SnippetValidationError);

    expect(() => normalizeSnippet({
      name: 'Bad host',
      prefix: 'bad',
      body: 'echo bad',
      scope: { type: 'host', hostId: -1 },
    })).toThrow(SnippetValidationError);
  });

  it('parses persisted libraries defensively and ignores bad entries', () => {
    const library = parseSnippetLibrary([
      {
        id: 'ok',
        name: 'OK',
        prefix: 'ok',
        body: 'echo ok',
        scope: 'global',
      },
      { id: 'bad', name: 'Bad' },
      null,
    ]);

    expect(library).toHaveLength(1);
    expect(library[0].id).toBe('ok');
  });

  it('upserts, preserves creation time on edit, and deletes snippets', () => {
    const created = upsertSnippet([], {
      id: 'deploy',
      name: 'Deploy',
      prefix: 'deploy',
      body: 'git pull',
    }, 100);
    const edited = upsertSnippet(created, {
      id: 'deploy',
      name: 'Deploy',
      prefix: 'deploy',
      body: 'git pull\nnpm test',
    }, 200);

    expect(getSnippet(edited, 'deploy')).toMatchObject({
      createdAt: 100,
      updatedAt: 200,
      body: 'git pull\nnpm test',
    });
    expect(deleteSnippet(edited, 'deploy')).toHaveLength(0);
  });

  it('filters global and per-host snippets by scope', () => {
    const global = normalizeSnippet({ id: 'global', name: 'Global', prefix: 'global', body: 'pwd' }, undefined, 1);
    const host1 = normalizeSnippet({
      id: 'host1',
      name: 'Host 1',
      prefix: 'host1',
      body: 'hostname',
      scope: { type: 'host', hostId: 1 },
    }, undefined, 1);
    const host2 = normalizeSnippet({
      id: 'host2',
      name: 'Host 2',
      prefix: 'host2',
      body: 'hostname',
      scope: { type: 'host', hostId: 2 },
    }, undefined, 1);

    expect(filterSnippetsByScope([global, host1, host2], { hostId: 1 }).map((s) => s.id))
      .toEqual(['global', 'host1']);
    expect(filterSnippetsByScope([global, host1, host2], { hostId: 1, includeGlobal: false }).map((s) => s.id))
      .toEqual(['host1']);
    expect(filterSnippetsByScope([global, host1, host2]).map((s) => s.id))
      .toEqual(['global']);
  });

  it('checks host-scoped snippets against the verified target host', () => {
    const global = normalizeSnippet({ id: 'global', name: 'Global', prefix: 'global', body: 'pwd' }, undefined, 1);
    const hostScoped = normalizeSnippet({
      id: 'host1',
      name: 'Host 1',
      prefix: 'host1',
      body: 'hostname',
      scope: { type: 'host', hostId: 1 },
    }, undefined, 1);

    expect(checkSnippetRunScope(global, undefined)).toEqual({ allowed: true });
    expect(checkSnippetRunScope(hostScoped, 1)).toEqual({ allowed: true });
    expect(checkSnippetRunScope(hostScoped, undefined)).toEqual({
      allowed: false,
      reason: 'missing-host',
      expectedHostId: 1,
    });
    expect(checkSnippetRunScope(hostScoped, 2)).toEqual({
      allowed: false,
      reason: 'host-mismatch',
      expectedHostId: 1,
      actualHostId: 2,
    });
  });

  it('expands template placeholders and variables', () => {
    const snippet = normalizeSnippet({
      id: 'expand',
      name: 'Expand',
      prefix: 'expand',
      body: 'tmux new -s ${1:work}\necho {{hostId}}\necho ${cwd}\necho $2',
    }, undefined, 1);

    expect(expandSnippetBody(snippet, { variables: { hostId: 7, cwd: '/srv/app' } }))
      .toBe('tmux new -s work\necho 7\necho /srv/app\necho ');
  });

  it('converts snippets to searchable palette command metadata', () => {
    const snippet = normalizeSnippet({
      id: 'deploy',
      name: 'Deploy Service',
      prefix: 'deploy',
      body: 'git pull && npm test',
      kind: 'template',
      scope: { type: 'host', hostId: 3 },
      description: 'Deploy the service',
      tags: ['ops'],
    }, undefined, 1);
    const descriptor = snippetToPaletteCommand(snippet);

    expect(descriptor).toMatchObject({
      id: 'pocketshell.snippets.run.deploy',
      prefix: '/deploy',
      label: 'Deploy Service',
      category: 'Snippets',
      snippetId: 'deploy',
    });
    expect(descriptor.description).toContain('host 3');
    expect(descriptor.description).toContain('ops');

    const slashCommand: SlashCommand = {
      ...descriptor,
      execute: vi.fn().mockResolvedValue(undefined),
    };
    const palette = new SlashCommandPalette([slashCommand]);

    expect(palette.search('deploy')[0].command.id).toBe('pocketshell.snippets.run.deploy');
    expect(palette.search('ops')[0].command.id).toBe('pocketshell.snippets.run.deploy');
  });

  it('extracts unique placeholder names in first-occurrence order', () => {
    expect(extractPlaceholderNames('echo {{name}} && {{name}} && {{host-name}}'))
      .toEqual(['name', 'host-name']);
    // Names must start with a letter; numbers/underscores-only are ignored.
    expect(extractPlaceholderNames('{{1up}} {{_bad}} {{ok}}')).toEqual(['ok']);
    // Names longer than 40 chars do not match the app's placeholder pattern.
    expect(extractPlaceholderNames('{{' + 'a'.repeat(45) + '}}')).toEqual([]);
    expect(extractPlaceholderNames('{{' + 'a'.repeat(40) + '}}')).toEqual(['a'.repeat(40)]);
  });

  it('resolves provided placeholders via the expand engine', () => {
    // {{name}} is substituted when a value is supplied.
    expect(resolvePlaceholders('echo {{name}}', { name: 'world' })).toBe('echo world');
    // {{var}} without a value collapses to empty (existing expand-engine
    // behavior; the placeholder dialog validates all fields are filled so
    // this only happens when no placeholders are present at all).
    expect(resolvePlaceholders('echo {{missing}}', {})).toBe('echo ');
    // ${var} without a value is left intact (different from {{var}}).
    expect(resolvePlaceholders('echo ${kept}', {})).toBe('echo ${kept}');
  });
});

describe('command template (macro) model', () => {
  it('normalizes name/commands/scope/tags and generates an id', () => {
    const template = normalizeCommandTemplate({
      name: '  Deploy  ',
      commands: ['git pull', 'npm test'],
      scope: { type: 'host', hostId: 7 },
      tags: ' deploy, ops ',
    }, undefined, 1_000);

    expect(template).toMatchObject({
      name: 'Deploy',
      commands: 'git pull\nnpm test',
      scope: { type: 'host', hostId: 7 },
      tags: ['deploy', 'ops'],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(template.id).toBe('deploy-rs');
  });

  it('rejects invalid templates', () => {
    expect(() => normalizeCommandTemplate({ name: 'No commands', commands: '' }))
      .toThrow(SnippetValidationError);
    expect(() => normalizeCommandTemplate({
      name: 'Bad scope',
      commands: 'echo',
      scope: { type: 'host', hostId: -2 },
    })).toThrow(SnippetValidationError);
  });

  it('parses persisted libraries defensively', () => {
    const library = parseCommandTemplateLibrary([
      { id: 'ok', name: 'OK', commands: 'echo ok', scope: 'global' },
      { id: 'bad', name: 'Bad' },
      null,
    ]);
    expect(library).toHaveLength(1);
    expect(library[0].id).toBe('ok');
  });

  it('upserts, preserves creation time, and deletes', () => {
    const created = upsertCommandTemplate([], {
      id: 'deploy',
      name: 'Deploy',
      commands: 'git pull',
    }, 100);
    const edited = upsertCommandTemplate(created, {
      id: 'deploy',
      name: 'Deploy',
      commands: 'git pull\nnpm test',
    }, 200);

    expect(getCommandTemplate(edited, 'deploy')).toMatchObject({
      createdAt: 100,
      updatedAt: 200,
      commands: 'git pull\nnpm test',
    });
    expect(deleteCommandTemplate(edited, 'deploy')).toHaveLength(0);
  });

  it('filters by scope', () => {
    const global = normalizeCommandTemplate({ id: 'g', name: 'G', commands: 'echo g' }, undefined, 1);
    const host1 = normalizeCommandTemplate({
      id: 'h1', name: 'H1', commands: 'echo h1', scope: { type: 'host', hostId: 1 },
    }, undefined, 1);

    expect(filterCommandTemplatesByScope([global, host1], { hostId: 1 }).map((t) => t.id))
      .toEqual(['g', 'h1']);
    expect(filterCommandTemplatesByScope([global, host1], { hostId: 1, includeGlobal: false }).map((t) => t.id))
      .toEqual(['h1']);
  });

  it('checks host scope against the verified target host', () => {
    const hostScoped = normalizeCommandTemplate({
      id: 'h', name: 'H', commands: 'echo', scope: { type: 'host', hostId: 1 },
    }, undefined, 1);
    expect(checkCommandTemplateRunScope(hostScoped, 1)).toEqual({ allowed: true });
    expect(checkCommandTemplateRunScope(hostScoped, undefined)).toEqual({
      allowed: false,
      reason: 'missing-host',
      expectedHostId: 1,
    });
    expect(checkCommandTemplateRunScope(hostScoped, 2)).toEqual({
      allowed: false,
      reason: 'host-mismatch',
      expectedHostId: 1,
      actualHostId: 2,
    });
  });

  it('splits commands into one submission per non-empty line', () => {
    expect(splitCommandLines('git pull\r\n\r\nnpm test\n  echo done  '))
      .toEqual(['git pull', 'npm test', 'echo done']);
  });

  it('expands each macro line with placeholder values', () => {
    const lines = expandCommandTemplateLines(
      { commands: 'git pull\nssh {{user}}@host\n{{cmd}}' },
      { user: 'alice', cmd: 'uptime' },
    );
    expect(lines).toEqual(['git pull', 'ssh alice@host', 'uptime']);
  });
});
