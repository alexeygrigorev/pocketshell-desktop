import { describe, expect, it } from 'vitest';
import { AgentType } from '../../../src/agents/types';
import {
  buildAgentStartCommand,
  buildDirectorySuggestions,
  buildRemoteDirectorySuggestionCommand,
  buildSessionName,
  buildWindowName,
  parseRemoteDirectoryOutput,
} from '../../../src/sessions/create-session';

describe('session creation helpers', () => {
  it('builds pocketshell agent wrapper commands with shell-safe directories', () => {
    expect(buildAgentStartCommand(AgentType.Claude, "/srv/prod app/it's")).toBe(
      "pocketshell agent claude --dir '/srv/prod app/it'\\''s'",
    );
    expect(buildAgentStartCommand(AgentType.Codex, '/repo')).toBe(
      "pocketshell agent codex --dir '/repo'",
    );
  });

  it('generates sanitized tmux session and window names from directory and kind', () => {
    expect(buildSessionName('/home/alice/git/prod api', 'shell')).toBe('prod-api');
    expect(buildSessionName('/home/alice/git/prod api', AgentType.OpenCode)).toBe('prod-api-opencode');
    expect(buildSessionName('', 'shell')).toBe('pocketshell');
    expect(buildWindowName('/home/alice/git/prod api', 'shell')).toBe('prod api');
    expect(buildWindowName('/home/alice/git/prod api', AgentType.Codex)).toBe('codex');
  });

  it('deduplicates watched folders and remote directory suggestions', () => {
    const suggestions = buildDirectorySuggestions([
      { label: 'api', path: '/home/alice/git/api', enabled: true },
      { label: 'disabled', path: '/home/alice/old', enabled: false },
    ], '/home/alice/git/api\n/home/alice/git/web\n\n/home/alice/git/web\n');

    expect(suggestions).toEqual([
      { label: 'api', path: '/home/alice/git/api', source: 'watched' },
      { label: 'web', path: '/home/alice/git/web', source: 'remote' },
    ]);
  });

  it('parses remote directory output defensively', () => {
    expect(parseRemoteDirectoryOutput('/tmp\n /srv/app \n/tmp\nbad\0path\n')).toEqual([
      '/tmp',
      '/srv/app',
    ]);
  });

  it('builds a bounded remote directory suggestion command with the seed path quoted', () => {
    const command = buildRemoteDirectorySuggestionCommand("/srv/prod app/it's");

    expect(command).toContain('find "$HOME" -maxdepth 2 -type d');
    expect(command).toContain('/srv/prod app/it');
    expect(command).toContain("\\''s");
    expect(command).toContain('head -100');
  });
});
