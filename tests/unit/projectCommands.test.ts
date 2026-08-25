import { describe, expect, it } from 'vitest';
import { shellQuote, shellQuoteRemotePath } from '../../src/shared/shellQuote';
import {
  FREE_SESSION_NAME_MAX_SUFFIX,
  createSessionCommand,
  directoryExistsCommand,
  fallbackCreateSessionCommand,
  freeSessionNameCommand,
  mkdirCommand,
  reposCloneCommand,
  renameSessionCommand,
  reposListCommand,
  resolveDirectoryCommand,
  sessionExistsCommand,
} from '@main/projects/commands';

/**
 * Folder paths, folder names and repo slugs all reach a remote POSIX shell.
 * These tests are the injection boundary: they assert that a value which
 * WOULD execute if it were interpolated raw comes out as one inert quoted
 * word instead. `PWNED` is the canary — if it ever appears outside a quoted
 * region in a built command, the escaping regressed.
 */
const HOSTILE = "wei'rd $(touch /tmp/PWNED) `id` ; rm -rf / #";

describe('shellQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('plain')).toBe("'plain'");
  });

  it("escapes an embedded quote as '\\''", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('renders a hostile value as one inert word', () => {
    const quoted = shellQuote(HOSTILE);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // Every `$`, backtick, `;` and `#` stays inside quotes: the only way out
    // of a single-quoted string is a `'`, and each one is escaped.
    expect(quoted).toBe("'wei'\\''rd $(touch /tmp/PWNED) `id` ; rm -rf / #'");
  });

  it('keeps a newline inside the quoted word', () => {
    expect(shellQuote('a\nrm -rf /')).toBe("'a\nrm -rf /'");
  });
});

describe('shellQuoteRemotePath', () => {
  it('leaves $HOME expandable and quotes the rest', () => {
    expect(shellQuoteRemotePath('~')).toBe('$HOME');
    expect(shellQuoteRemotePath('$HOME')).toBe('$HOME');
    expect(shellQuoteRemotePath('~/git/x')).toBe("$HOME/'git/x'");
    expect(shellQuoteRemotePath('$HOME/git/x')).toBe("$HOME/'git/x'");
  });

  it('quotes an absolute path whole', () => {
    expect(shellQuoteRemotePath('/var/log')).toBe("'/var/log'");
  });

  it('treats a blank path as home', () => {
    expect(shellQuoteRemotePath('   ')).toBe('$HOME');
  });

  it('does not let a hostile segment escape after the $HOME prefix', () => {
    expect(shellQuoteRemotePath(`~/${HOSTILE}`)).toBe(
      "$HOME/'wei'\\''rd $(touch /tmp/PWNED) `id` ; rm -rf / #'",
    );
  });

  it('does not expand a `$HOME`-lookalike that is not the prefix', () => {
    expect(shellQuoteRemotePath('/tmp/$HOME/x')).toBe("'/tmp/$HOME/x'");
  });
});

describe('directory commands', () => {
  it('builds the existence pre-flight', () => {
    expect(directoryExistsCommand('~/git/x')).toBe("[ -d $HOME/'git/x' ]");
  });

  it('builds `cd … && pwd -P`', () => {
    expect(resolveDirectoryCommand('/var/log')).toBe("cd -- '/var/log' && pwd -P");
  });

  it('terminates mkdir option parsing so a leading `-` is not a flag', () => {
    expect(mkdirCommand('/home/a/-rf')).toBe("mkdir -p -- '/home/a/-rf'");
  });

  it('quotes a hostile folder path in every directory command', () => {
    for (const built of [
      directoryExistsCommand(`/home/a/${HOSTILE}`),
      resolveDirectoryCommand(`/home/a/${HOSTILE}`),
      mkdirCommand(`/home/a/${HOSTILE}`),
    ]) {
      expect(built).toContain("'/home/a/wei'\\''rd $(touch /tmp/PWNED) `id` ; rm -rf / #'");
    }
  });
});

describe('sessionExistsCommand', () => {
  it('uses tmux exact-match (`=name`) so a `-2` sibling is not mistaken for it', () => {
    expect(sessionExistsCommand('git-x')).toBe("tmux has-session -t '=git-x' 2>/dev/null");
  });

  it('quotes a hostile name', () => {
    expect(sessionExistsCommand("a'b")).toBe("tmux has-session -t '=a'\\''b' 2>/dev/null");
  });
});

describe('freeSessionNameCommand', () => {
  const built = freeSessionNameCommand('git-x');

  it('walks base, base-2, base-3 … entirely on the host', () => {
    expect(built).toContain("__ps_n='git-x'");
    expect(built).toContain('while tmux has-session -t "=$__ps_n" 2>/dev/null; do');
    expect(built).toContain("__ps_n='git-x'-$__ps_i");
    expect(built).toContain('__ps_i=$((__ps_i+1))');
    expect(built).toContain("printf '%s\\n' \"$__ps_n\"");
  });

  it('bounds the walk', () => {
    expect(built).toContain(`[ "$__ps_i" -gt ${FREE_SESSION_NAME_MAX_SUFFIX} ]`);
    expect(FREE_SESSION_NAME_MAX_SUFFIX).toBe(200);
  });

  it('quotes the base so a hostile name cannot break the loop', () => {
    const hostile = freeSessionNameCommand("a'; touch /tmp/PWNED; :'b");
    // The payload sits inside a quoted region on BOTH interpolations — the
    // seed and the `-$i` concatenation.
    expect(hostile).toBe(
      "__ps_n='a'\\''; touch /tmp/PWNED; :'\\''b'; __ps_i=2; " +
        'while tmux has-session -t "=$__ps_n" 2>/dev/null; do ' +
        'if [ "$__ps_i" -gt 200 ]; then break; fi; ' +
        "__ps_n='a'\\''; touch /tmp/PWNED; :'\\''b'-$__ps_i; " +
        '__ps_i=$((__ps_i+1)); ' +
        "done; printf '%s\\n' \"$__ps_n\"",
    );
    expect(singleQuotesBalanced(hostile)).toBe(true);
  });
});

/**
 * Every command this module builds must leave the shell's quote state where it
 * found it: an odd number of quote DELIMITERS means some interpolated value
 * escaped its quoted region, which is the exact failure that turns a folder
 * name into a command.
 *
 * The `\'` sequences are literal quotes, not delimiters — that is how a quote
 * gets through a single-quoted word at all — so they are removed before
 * counting.
 */
function singleQuotesBalanced(command: string): boolean {
  const delimitersOnly = command.replace(/\\'/g, '');
  return (delimitersOnly.match(/'/g)?.length ?? 0) % 2 === 0;
}

describe('quote balance across every builder', () => {
  const hostiles = [
    HOSTILE,
    "a'b",
    "'",
    "''",
    "a'; touch /tmp/PWNED; :'b",
    '\n; touch /tmp/PWNED',
  ];

  it('holds for every builder and every hostile input', () => {
    for (const value of hostiles) {
      const built = [
        shellQuote(value),
        shellQuoteRemotePath(`/x/${value}`),
        shellQuoteRemotePath(`~/${value}`),
        directoryExistsCommand(`/x/${value}`),
        resolveDirectoryCommand(`/x/${value}`),
        mkdirCommand(`/x/${value}`),
        sessionExistsCommand(value),
        freeSessionNameCommand(value),
        createSessionCommand(value, `/x/${value}`),
        fallbackCreateSessionCommand(value, `/x/${value}`),
        reposListCommand({ scope: 'local', roots: [`/x/${value}`] }),
        reposCloneCommand({ repository: value, root: `/x/${value}`, folder: value }),
      ];
      for (const command of built) {
        expect(singleQuotesBalanced(command), `unbalanced for ${JSON.stringify(value)}`).toBe(
          true,
        );
      }
    }
  });
});

describe('createSessionCommand', () => {
  it('passes --cwd and, deliberately, no --mem', () => {
    expect(createSessionCommand('git-x', '/home/a/git/x')).toBe(
      "pocketshell sessions create 'git-x' -c '/home/a/git/x'",
    );
    expect(createSessionCommand('git-x', '/home/a/git/x')).not.toContain('--mem');
  });

  it('keeps `~` expandable in the cwd', () => {
    expect(createSessionCommand('git-x', '~/git/x')).toBe(
      "pocketshell sessions create 'git-x' -c $HOME/'git/x'",
    );
  });

  it('quotes both the name and the cwd', () => {
    const built = createSessionCommand("a'b", `/home/a/${HOSTILE}`);
    expect(built).toContain("create 'a'\\''b'");
    expect(built).toContain("-c '/home/a/wei'\\''rd $(touch /tmp/PWNED) `id` ; rm -rf / #'");
  });
});

describe('fallbackCreateSessionCommand', () => {
  it('is the idempotent attach-or-create raw tmux form', () => {
    expect(fallbackCreateSessionCommand('git-x', '/home/a/git/x')).toBe(
      "tmux new-session -A -d -s 'git-x' -c '/home/a/git/x'",
    );
  });
});

describe('reposListCommand', () => {
  it('always passes the scope flag explicitly', () => {
    // With neither flag the helper prints a "defaulting to --local" hint
    // alongside the rows.
    expect(reposListCommand({ scope: 'local' })).toBe('pocketshell repos list --local --json');
    expect(reposListCommand({ scope: 'remote' })).toBe('pocketshell repos list --remote --json');
  });

  it('adds local-only options', () => {
    expect(reposListCommand({ scope: 'local', roots: ['~/git', '/srv/code'], maxDepth: 2 })).toBe(
      "pocketshell repos list --local --json --root $HOME/'git' --root '/srv/code' --max-depth 2",
    );
  });

  it('adds remote-only options', () => {
    expect(reposListCommand({ scope: 'remote', limit: 50 })).toBe(
      'pocketshell repos list --remote --json --limit 50',
    );
  });

  it('ignores options that do not apply to the scope', () => {
    expect(reposListCommand({ scope: 'remote', roots: ['/x'], maxDepth: 3 })).toBe(
      'pocketshell repos list --remote --json',
    );
    expect(reposListCommand({ scope: 'local', limit: 10 })).toBe(
      'pocketshell repos list --local --json',
    );
  });

  it('rejects a non-integer or non-positive numeric option rather than emitting it', () => {
    expect(reposListCommand({ scope: 'remote', limit: 0 })).not.toContain('--limit');
    expect(reposListCommand({ scope: 'remote', limit: 1.5 })).not.toContain('--limit');
    expect(reposListCommand({ scope: 'local', maxDepth: -1 })).not.toContain('--max-depth');
  });

  it('quotes a hostile scan root', () => {
    expect(reposListCommand({ scope: 'local', roots: [`/srv/${HOSTILE}`] })).toContain(
      "--root '/srv/wei'\\''rd $(touch /tmp/PWNED) `id` ; rm -rf / #'",
    );
  });
});

describe('reposCloneCommand', () => {
  it('builds the plain form', () => {
    expect(reposCloneCommand({ repository: 'octocat/Hello-World' })).toBe(
      "pocketshell repos clone 'octocat/Hello-World'",
    );
  });

  it('adds root, folder and protocol', () => {
    expect(
      reposCloneCommand({
        repository: 'octocat/Hello-World',
        root: '~/git',
        folder: 'hello',
        protocol: 'https',
      }),
    ).toBe("pocketshell repos clone 'octocat/Hello-World' --root $HOME/'git' --folder 'hello' --protocol https");
  });

  it('quotes the repository slug — it comes from the renderer', () => {
    expect(reposCloneCommand({ repository: "o/r'; touch /tmp/PWNED; :" })).toBe(
      "pocketshell repos clone 'o/r'\\''; touch /tmp/PWNED; :'",
    );
  });

  it('quotes the target folder name', () => {
    expect(reposCloneCommand({ repository: 'o/r', folder: HOSTILE })).toContain(
      "--folder 'wei'\\''rd $(touch /tmp/PWNED) `id` ; rm -rf / #'",
    );
  });
});

describe('renameSessionCommand', () => {
  it('forces an exact match on the source and terminates options', () => {
    expect(renameSessionCommand('api', 'api-staging')).toBe(
      "tmux rename-session -t '=api' -- 'api-staging'",
    );
  });

  it('quotes both sides — a foreign session name can carry anything tmux allows', () => {
    // Built from the same quoter rather than spelled out: the point is that
    // BOTH arguments go through it, not what a nested single quote looks like.
    expect(renameSessionCommand(HOSTILE, HOSTILE)).toBe(
      `tmux rename-session -t ${shellQuote(`=${HOSTILE}`)} -- ${shellQuote(HOSTILE)}`,
    );
    // And that the `=` really is inside the quotes, where a hostile name
    // cannot get in front of it.
    expect(renameSessionCommand(HOSTILE, HOSTILE)).toContain("-t '=wei");
  });
});
