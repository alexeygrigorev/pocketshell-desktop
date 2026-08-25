import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  KIND_LABELS,
  LAUNCHABLE_KINDS,
  buildLaunchCommand,
  isLaunchableKind,
  launchBlocker,
  parseProfileRows,
  profileFlagName,
  profilesFor,
  supportsProfiles,
  supportsSkipPermissions,
  type AgentProfile,
} from '../../src/shared/agentLaunch';

/**
 * Two suites with different jobs.
 *
 * The FIRST reads the committed `--help` capture and asserts that every flag
 * this module emits is spelled the way the helper the user actually runs
 * spells it. That is the guard docs/ANALYSIS.md asks for: this repo has been
 * burned four times by trusting a documented contract over a captured one, and
 * the `--dir` bug was a fifth. If a helper bump renames `--skip-permissions`,
 * re-capturing the fixture fails these tests rather than shipping a session
 * that starts a shell and prints a usage message.
 *
 * The SECOND is the command construction as pure logic — the matrix of
 * profile / no profile, skip / no skip, and a directory with a space in it.
 */
const V44 = resolve(__dirname, 'fixtures');
const readV44 = (name: string): string => readFileSync(resolve(V44, name), 'utf8');

describe('the 0.4.44 `pocketshell agent` contract, as captured', () => {
  const groupHelp = readV44('v0.4.44-agent-help.txt');
  const claudeHelp = readV44('v0.4.44-agent-claude-help.txt');
  const opencodeHelp = readV44('v0.4.44-agent-opencode-help.txt');

  it('offers exactly the three subcommands we are willing to launch', () => {
    // The `Commands:` block of `pocketshell agent --help`.
    const listed = [...groupHelp.matchAll(/^ {2}(\w+) {2,}Launch/gm)].map((m) => m[1]);
    expect(listed).toEqual(['claude', 'codex', 'opencode']);
    expect([...LAUNCHABLE_KINDS]).toEqual(listed);
  });

  it('has no `grok` subcommand, which is why the picker cannot offer one', () => {
    expect(groupHelp).not.toMatch(/^ {2}grok\b/m);
    expect(readV44('v0.4.44-agent-no-such-command.stderr.txt')).toContain(
      "Error: No such command 'grok'.",
    );
    expect(isLaunchableKind('grok')).toBe(false);
  });

  it('marks --dir required, which is the bug this module fixes', () => {
    expect(claudeHelp).toMatch(/--dir TEXT[\s\S]*?\[required\]/);
    // And the exact failure the old bare command produced.
    expect(readV44('v0.4.44-agent-missing-dir.stderr.txt')).toContain(
      "Error: Missing option '--dir'.",
    );
  });

  it('spells the permission flag as a --x/--no-x pair defaulting to ON', () => {
    expect(claudeHelp).toContain('--skip-permissions / --no-skip-permissions');
    expect(claudeHelp).toContain('[default: skip-permissions]');
    // Because the host default is ON, only the negative carries information.
    const on = buildLaunchCommand({ kind: 'claude', dir: '/srv/app', skipPermissions: true, profile: null });
    expect(on).not.toContain('--skip-permissions');
    expect(on).not.toContain('--no-skip-permissions');
  });

  it('says the permission flag is a no-op for opencode', () => {
    expect(opencodeHelp).toContain('No-op\n                                  for opencode');
    expect(supportsSkipPermissions('opencode')).toBe(false);
  });

  it('says --profile is ignored for opencode and excludes --config-dir', () => {
    expect(claudeHelp).toContain('Ignored for');
    expect(claudeHelp).toContain('opencode. Mutually exclusive with --profile.');
    expect(claudeHelp).toMatch(/--profile TEXT[\s\S]*?Mutually\s+exclusive with --config-dir/);
    expect(supportsProfiles('opencode')).toBe(false);
    // We never emit --config-dir, so the exclusive pair cannot both appear.
    const cmd = buildLaunchCommand({
      kind: 'claude',
      dir: '/srv/app',
      skipPermissions: true,
      profile: 'Claude (Z.AI)',
    });
    expect(cmd).not.toContain('--config-dir');
  });
});

describe('buildLaunchCommand', () => {
  const base = { kind: 'claude', dir: '/srv/app', skipPermissions: true, profile: null } as const;

  it('always passes --dir, quoted', () => {
    expect(buildLaunchCommand(base)).toBe("pocketshell agent claude --dir '/srv/app'");
  });

  it('emits --no-skip-permissions only when the user turned it off', () => {
    expect(buildLaunchCommand({ ...base, skipPermissions: false })).toBe(
      "pocketshell agent claude --dir '/srv/app' --no-skip-permissions",
    );
  });

  it('never emits a permission flag for opencode, either way', () => {
    const on = buildLaunchCommand({ ...base, kind: 'opencode', skipPermissions: true });
    const off = buildLaunchCommand({ ...base, kind: 'opencode', skipPermissions: false });
    expect(on).toBe("pocketshell agent opencode --dir '/srv/app'");
    expect(off).toBe(on);
  });

  it('emits --profile, quoted, for a named profile', () => {
    expect(buildLaunchCommand({ ...base, profile: 'Claude (Z.AI)' })).toBe(
      "pocketshell agent claude --dir '/srv/app' --profile 'Claude (Z.AI)'",
    );
  });

  it('drops a blank or whitespace-only profile rather than emitting an empty flag', () => {
    expect(buildLaunchCommand({ ...base, profile: '   ' })).toBe(
      "pocketshell agent claude --dir '/srv/app'",
    );
    expect(buildLaunchCommand({ ...base, profile: null })).toBe(
      "pocketshell agent claude --dir '/srv/app'",
    );
  });

  it('ignores a profile for opencode, which has no config dir', () => {
    expect(buildLaunchCommand({ ...base, kind: 'opencode', profile: 'Claude (Z.AI)' })).toBe(
      "pocketshell agent opencode --dir '/srv/app'",
    );
  });

  it('combines both flags in the helper documented order', () => {
    expect(
      buildLaunchCommand({ kind: 'codex', dir: '/srv/app', skipPermissions: false, profile: 'work' }),
    ).toBe("pocketshell agent codex --dir '/srv/app' --no-skip-permissions --profile 'work'");
  });

  // --- quoting ------------------------------------------------------------

  it('survives a directory containing a space', () => {
    expect(buildLaunchCommand({ ...base, dir: '/srv/my app' })).toBe(
      "pocketshell agent claude --dir '/srv/my app'",
    );
  });

  it('expands a literal `~/` cwd instead of quoting it into a dead path', () => {
    // tmux reports unexpanded cwds; `'~/git/x'` would make the helper look for
    // a directory literally named `~`.
    expect(buildLaunchCommand({ ...base, dir: '~/git/my app' })).toBe(
      "pocketshell agent claude --dir $HOME/'git/my app'",
    );
    expect(buildLaunchCommand({ ...base, dir: '~' })).toBe(
      'pocketshell agent claude --dir $HOME',
    );
  });

  it('passes a hostile folder name through as data', () => {
    expect(buildLaunchCommand({ ...base, dir: "/srv/wei'rd $(touch /tmp/PWNED)" })).toBe(
      "pocketshell agent claude --dir '/srv/wei'\\''rd $(touch /tmp/PWNED)'",
    );
  });

  it('quotes a profile name containing a quote', () => {
    expect(buildLaunchCommand({ ...base, profile: "o'brien" })).toBe(
      "pocketshell agent claude --dir '/srv/app' --profile 'o'\\''brien'",
    );
  });
});

describe('launchBlocker', () => {
  it('passes a complete choice', () => {
    expect(launchBlocker({ kind: 'claude', dir: '/srv/app', skipPermissions: true, profile: null })).toBeNull();
  });

  it('blocks a kind the helper cannot launch', () => {
    expect(launchBlocker({ kind: 'grok' as never, dir: '/srv/app' })).toBe('Pick an agent to launch.');
  });

  it('blocks a folder with no host directory, BEFORE anything is created', () => {
    expect(launchBlocker({ kind: 'claude', dir: '' })).toMatch(/no known directory/);
    expect(launchBlocker({ kind: 'claude', dir: '   ' })).toMatch(/no known directory/);
  });
});

describe('profile rows', () => {
  const envelope = JSON.parse(readV44('v0.4.44-profiles-list.json')) as { profiles: unknown[] };

  it('parses the real 0.4.44 envelope rows', () => {
    const rows = parseProfileRows(envelope.profiles);
    expect(rows).toEqual<AgentProfile[]>([
      { name: 'Claude', engine: 'claude', configDir: null, default: true },
      { name: 'Claude (Z.AI)', engine: 'claude', configDir: '/home/testuser/.zlaude', default: false },
      { name: 'Codex', engine: 'codex', configDir: null, default: true },
    ]);
  });

  it('treats a host with no profiles as empty, not an error', () => {
    const empty = JSON.parse(readV44('v0.4.44-profiles-list-empty.json')) as { profiles: unknown[] };
    expect(empty.profiles).toEqual([]);
    expect(parseProfileRows(empty.profiles)).toEqual([]);
  });

  it('drops rows that could not be passed to --profile', () => {
    expect(
      parseProfileRows([
        null,
        'nope',
        { engine: 'claude' },
        { name: '  ', engine: 'claude' },
        { name: 'ok', engine: '' },
        { name: 'ok', engine: 'claude', config_dir: '', default: 'yes' },
      ]),
    ).toEqual<AgentProfile[]>([{ name: 'ok', engine: 'claude', configDir: null, default: false }]);
  });

  it('filters to the engine, and gives opencode none', () => {
    const rows = parseProfileRows(envelope.profiles);
    expect(profilesFor('claude', rows).map((p) => p.name)).toEqual(['Claude', 'Claude (Z.AI)']);
    expect(profilesFor('codex', rows).map((p) => p.name)).toEqual(['Codex']);
    expect(profilesFor('opencode', rows)).toEqual([]);
  });

  describe('profileFlagName', () => {
    const rows = parseProfileRows(envelope.profiles);

    it('is null for the engine default — naming it is the same launch', () => {
      expect(profileFlagName('Claude', rows)).toBeNull();
    });

    it('is the name for a non-default profile', () => {
      expect(profileFlagName('Claude (Z.AI)', rows)).toBe('Claude (Z.AI)');
    });

    it('is null for a remembered profile the host no longer lists', () => {
      expect(profileFlagName('Claude (deleted)', rows)).toBeNull();
    });

    it('is null when nothing is picked', () => {
      expect(profileFlagName(null, rows)).toBeNull();
      expect(profileFlagName('', rows)).toBeNull();
    });
  });
});

describe('the picker surface', () => {
  it('labels every launchable kind', () => {
    for (const kind of LAUNCHABLE_KINDS) expect(KIND_LABELS[kind]).toBeTruthy();
    expect(Object.keys(KIND_LABELS).sort()).toEqual([...LAUNCHABLE_KINDS].sort());
  });
});
