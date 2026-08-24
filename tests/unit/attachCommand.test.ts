import { describe, expect, it } from 'vitest';
import { sessionAttachCommand, shellSingleQuote } from '../../src/shared/attachCommand';

/**
 * These pin the join contract, which is the thing that actually broke: the app
 * created and listed sessions through the helper but attached with raw
 * `tmux attach -t`, so every session in a freshly rendered list failed with
 * `can't find session`. The helper's own footer documents the join command,
 * and the fixture in ./fixtures/v0.4.44-sessions-list.txt carries it verbatim.
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

  it('prefers tmuxctl, the join command the helper itself documents', () => {
    expect(command).toContain("tmuxctl 'git-red-stamp-sound'");
    // Ahead of both fallbacks in the chain.
    expect(command.indexOf('tmuxctl ')).toBeLessThan(command.indexOf('pocketshell sessions'));
    expect(command.indexOf('tmuxctl ')).toBeLessThan(command.indexOf('tmux attach'));
  });

  it('joins with a bare name — never `:name`, which would CREATE', () => {
    // `Create a new one: tmuxctl :<session>`. A join that silently created a
    // session would turn a stale row into a brand-new empty pane.
    expect(command).not.toContain(":'git-red-stamp-sound'");
    expect(command).not.toMatch(/tmuxctl\s+:/);
  });

  it('falls back through the older helper name, then raw tmux', () => {
    expect(command).toContain("pocketshell sessions 'git-red-stamp-sound'");
    expect(command).toContain("tmux attach -t 'git-red-stamp-sound'");
  });

  it('tests for the binary rather than assuming it — bootstrap never probes tmuxctl', () => {
    expect(command).toContain('command -v tmuxctl >/dev/null 2>&1');
  });

  it('does not exec, so a detach or a failed join leaves a live prompt', () => {
    expect(command).not.toContain('exec ');
  });

  it('quotes a name carrying a single quote in every branch', () => {
    const nasty = sessionAttachCommand("it's mine");
    // Three occurrences, one per branch, all escaped the POSIX way.
    expect(nasty.match(/'it'\\''s mine'/g)).toHaveLength(3);
    expect(nasty).not.toContain("'it's mine'");
  });

  it('cannot be broken out of by a name built to close the quote', () => {
    const payload = "x'; rm -rf ~; echo '";
    const injected = sessionAttachCommand(payload);

    // The payload's text DOES appear — inside the quotes, which is the point.
    // What must never happen is it appearing at top level, so the property to
    // assert is that every `'` originating in the name arrives as the POSIX
    // close-escape-reopen dance `'\''` rather than as a bare closing quote.
    // Counting quote runs is how that is visible without writing a shell
    // parser: a correctly escaped name contributes `'\''` per quote, so the
    // total number of `'` characters stays even and no `'` sits alone.
    const escaped = shellSingleQuote(payload);
    // Round-trip through the inverse of POSIX single-quoting: a quoted word is
    // a concatenation of '...' segments and \-escapes. If unquoting yields the
    // original name exactly, the shell will pass it as ONE argument and none of
    // it was ever interpreted.
    expect(posixUnquote(escaped)).toBe(payload);

    // And the built command embeds exactly that form, three times — once per
    // branch — with nothing of the name outside it.
    expect(injected.split(escaped)).toHaveLength(4);
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
