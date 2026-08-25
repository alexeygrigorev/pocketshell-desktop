import { describe, expect, it } from 'vitest';
import { sessionAttachCommand, shellSingleQuote } from '../../src/shared/attachCommand';
import { USER_BIN_DIRS } from '../../src/shared/userBinPath';

/**
 * These pin the join contract, which is the thing that actually broke: the app
 * created and listed sessions through the helper but attached with raw
 * `tmux attach -t`, so every session in a freshly rendered list failed with
 * `can't find session`. The helper's own footer documents the join command,
 * and the fixture in ./fixtures/v0.4.44-sessions-list.txt carries it verbatim.
 *
 * The first fix replaced the raw command with a three-branch fallback chain.
 * That is gone too, and several tests below now assert its ABSENCE — see
 * src/shared/attachCommand.ts for why a chain ending in raw tmux was actively
 * harmful rather than merely dead weight.
 */
/**
 * The inverse of POSIX single-quoting, used to prove a quoted name round-trips.
 * A quoted word is a concatenation of `'...'` runs and backslash escapes; this
 * walks it the way `sh` word-splitting would, so a name that survives is one
 * the shell passes through as a single argument.
 */
function posixUnquote(quoted: string): string {
  let out = '';
  let i = 0;
  while (i < quoted.length) {
    const ch = quoted[i];
    if (ch === "'") {
      const end = quoted.indexOf("'", i + 1);
      // An unterminated run means the quoting is broken — the caller's assertion
      // should fail rather than this silently papering over it.
      if (end === -1) return `${out}<unterminated>`;
      out += quoted.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '\\') {
      out += quoted[i + 1] ?? '';
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

describe('sessionAttachCommand', () => {
  const command = sessionAttachCommand('git-red-stamp-sound');

  it('joins with tmuxctl, the command the helper itself documents', () => {
    expect(command).toContain("tmuxctl 'git-red-stamp-sound'");
  });

  it('joins with a bare name — never `:name`, which would CREATE', () => {
    // `Create a new one: tmuxctl :<session>`. A join that silently created a
    // session would turn a stale row into a brand-new empty pane.
    expect(command).not.toContain(":'git-red-stamp-sound'");
    expect(command).not.toMatch(/tmuxctl\s+:/);
  });

  it('never falls back to raw tmux, which is the failure that started this', () => {
    // The user's sessions are not on the default tmux socket, so this branch
    // could only ever produce `can't find session` — a failure that looks like
    // a stale session list rather than a missing helper.
    expect(command).not.toContain('tmux attach');
    expect(command).not.toContain('-t ');
  });

  it('carries no pre-0.4.44 helper spelling (D22: hard cuts, no shims)', () => {
    expect(command).not.toContain('pocketshell sessions');
  });

  it('has exactly one command that can join — no branching ladder', () => {
    expect(command).not.toContain('elif');
    expect(command).not.toContain('command -v');
    // One INVOCATION — `tmuxctl <quoted-name>`. The bare word appears again in
    // the failure text, which is prose, not a second thing that could run.
    expect(command.match(/tmuxctl '/g)).toHaveLength(1);
  });

  it('searches the same user-bin dirs bootstrap probes, so the two agree', () => {
    // A host where bootstrap finds tmuxctl in ~/.local/bin but the PTY does not
    // is the bug where the app reports the host is ready and the join fails.
    for (const dir of USER_BIN_DIRS) {
      expect(command).toContain(dir);
    }
    expect(command).toContain('$PATH');
  });

  it('scopes the PATH change to a subshell, leaving the login shell alone', () => {
    expect(command).toMatch(/^\(\s*PATH=/);
    // The assignment is inside the parens, not before them.
    expect(command.indexOf('PATH=')).toBeGreaterThan(command.indexOf('('));
    expect(command.indexOf(')')).toBeGreaterThan(command.indexOf('tmuxctl'));
  });

  it('reports a failed join instead of leaving a silent prompt', () => {
    // Clicking a session and getting an untouched prompt is exactly how the
    // original bug read as "nothing happened".
    expect(command).toContain('||');
    expect(command).toContain('printf');
    expect(command).toContain('PocketShell');
    expect(command).toContain('tmuxctl');
  });

  it('does not exec, so a detach or a failed join leaves a live prompt', () => {
    expect(command).not.toContain('exec ');
  });

  it('passes the name to printf as an argument, not as the format string', () => {
    // A session called `100%s` spliced into a format string would consume the
    // next argument (or read garbage); as an argument it is inert data.
    const percent = sessionAttachCommand('100%s-done');
    expect(percent).toContain("printf '");
    // The only conversion in the format belongs to the format, and the name
    // sits after the closing quote of the format string.
    const formatEnd = percent.indexOf("' '100%s-done'");
    expect(formatEnd).toBeGreaterThan(-1);
  });

  it('quotes a name carrying a single quote everywhere it appears', () => {
    const nasty = sessionAttachCommand("it's mine");
    // Twice: once joined, once named in the failure line.
    expect(nasty.match(/'it'\\''s mine'/g)).toHaveLength(2);
    expect(nasty).not.toContain("'it's mine'");
  });

  it('cannot be broken out of by a name built to close the quote', () => {
    const payload = "x'; rm -rf ~; echo '";
    const injected = sessionAttachCommand(payload);

    // The payload's text DOES appear — inside the quotes, which is the point.
    // What must never happen is it appearing at top level, so the property to
    // assert is that every `'` originating in the name arrives as the POSIX
    // close-escape-reopen dance `'\''` rather than as a bare closing quote.
    const escaped = shellSingleQuote(payload);
    // Round-trip through the inverse of POSIX single-quoting: a quoted word is
    // a concatenation of '...' segments and \-escapes. If unquoting yields the
    // original name exactly, the shell will pass it as ONE argument and none of
    // it was ever interpreted.
    expect(posixUnquote(escaped)).toBe(payload);

    // And the built command embeds exactly that form, twice — join and
    // diagnostic — with nothing of the name outside it.
    expect(injected.split(escaped)).toHaveLength(3);
  });
});

describe('shellSingleQuote', () => {
  it('wraps a plain value', () => {
    expect(shellSingleQuote('main')).toBe("'main'");
  });

  it('escapes an embedded quote by closing, escaping, and reopening', () => {
    expect(shellSingleQuote("a'b")).toBe("'a'\\''b'");
  });

  it('leaves every other shell metacharacter to the quotes', () => {
    expect(shellSingleQuote('$(id) `id` && rm')).toBe("'$(id) `id` && rm'");
  });
});
