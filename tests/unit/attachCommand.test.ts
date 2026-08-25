import { describe, expect, it } from 'vitest';
import {
  SWITCH_CLIENT_NOT_READY_EXIT,
  SWITCH_NO_CLIENT_EXIT,
  clientTtyVar,
  sessionAttachCommand,
  sessionSwitchCommand,
  shellSingleQuote,
} from '../../src/shared/attachCommand';
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
    // Not because raw tmux cannot reach these sessions — it can; tmuxctl runs
    // a bare `tmux` on the default socket and so would this. It is because a
    // second way to join turns "the helper is missing" into "can't find
    // session", which reads as a stale session list rather than a broken
    // install. One join, one failure message.
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

/**
 * The handshake half of the join. These pin the two properties that keep the
 * fast switch path from ever being worse than the slow one it replaces:
 * publishing the tty must be optional and must not be able to fail the join,
 * and the join itself must be byte-for-byte what it always was when no
 * handshake is asked for.
 */
describe('sessionAttachCommand with a tty handshake', () => {
  const ttyVar = clientTtyVar('a1b2c3');
  const command = sessionAttachCommand('git-red-stamp-sound', ttyVar);

  it('is exactly the old command when no variable is given', () => {
    // The handshake is an optimisation's setup. A caller that does not want it
    // must not get a different join.
    expect(sessionAttachCommand('main')).toBe(
      sessionAttachCommand('main', undefined),
    );
    expect(sessionAttachCommand('main')).not.toContain('set-environment');
  });

  it('records the tty inside the same subshell as the PATH widening', () => {
    // Outside the subshell it would run before PATH is set, which is the one
    // place tmux might not be found on the hosts this app targets.
    expect(command).toMatch(/^\(\s*PATH=/);
    expect(command.indexOf('set-environment')).toBeGreaterThan(command.indexOf('PATH='));
    expect(command.indexOf('set-environment')).toBeLessThan(command.indexOf('tmuxctl'));
  });

  it('cannot fail the join when the handshake fails', () => {
    // Silenced and sequenced with `;`, never `&&`: a host with no tmux server
    // yet, or a tmux too old for set-environment, must still join normally and
    // simply not get the fast switch.
    expect(command).toContain('2>/dev/null;');
    expect(command).not.toContain('set-environment -g ' + ttyVar + ' "$(tty)" &&');
  });

  it('still joins with exactly one tmuxctl invocation', () => {
    expect(command.match(/tmuxctl '/g)).toHaveLength(1);
    expect(command).toContain("tmuxctl 'git-red-stamp-sound'");
  });

  it('does not smuggle in a second way to attach', () => {
    // `set-environment` is not a join; nothing here may look like one.
    expect(command).not.toContain('tmux attach');
    expect(command).not.toContain('switch-client');
  });
});

describe('clientTtyVar', () => {
  it('produces a shell identifier, whatever the token looks like', () => {
    // The name is spliced into `${v#NAME=}`, where a non-identifier cannot be
    // rescued by quoting.
    expect(clientTtyVar('abc123')).toBe('PS_DESKTOP_TTY_abc123');
    expect(clientTtyVar('a-b.c/$(id)')).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it('is prefixed, so an entry left on a tmux server is identifiable', () => {
    // These outlive the app: a connection cannot unset its own variable,
    // because by the time it closes there is no channel left to unset it on.
    expect(clientTtyVar('x')).toMatch(/^PS_DESKTOP_TTY_/);
  });
});

describe('sessionSwitchCommand', () => {
  const ttyVar = clientTtyVar('a1b2c3');
  const command = sessionSwitchCommand(ttyVar, 'git-red-stamp-sound');

  it('runs under POSIX sh, not whatever login shell the user has', () => {
    // sshd runs an exec channel under the user's shell, and `${v#NAME=}` is
    // not csh or fish. Same wrapper as bootstrap.pathAwareCommand.
    expect(command).toMatch(/^\/bin\/sh -lc '/);
  });

  it('switches an existing client rather than attaching a new one', () => {
    expect(command).toContain('switch-client');
    expect(command).not.toContain('attach-session');
    expect(command).not.toContain('tmuxctl');
  });

  it('names the client explicitly, never letting tmux guess', () => {
    // Without -c, tmux picks a "best" client — which on a host where the user
    // has their own terminal open could be theirs, not ours.
    expect(command).toContain('switch-client -c "$t"');
  });

  it('reads the tty back out of the tmux server it is switching on', () => {
    expect(command).toContain(`show-environment -g ${ttyVar}`);
    expect(command).toContain(`\${v#${ttyVar}=}`);
  });

  it('declines instead of guessing when the handshake finds nothing', () => {
    // Two ways to find nothing: the variable is unset (tmux exits non-zero),
    // or the value came back without the prefix, in which case the parameter
    // expansion is a no-op and the two strings are still equal.
    expect(command.match(new RegExp(`exit ${SWITCH_NO_CLIENT_EXIT}`, 'g'))).toHaveLength(2);
    expect(command).toContain('[ "$t" != "$v" ]');
  });

  it('targets the session exactly, not by prefix', () => {
    // tmux -t is fnmatch/prefix by default: `api` would match `api-staging`.
    // Asserted against the UNQUOTED script — the `sh -lc` wrapper escapes the
    // inner quotes, so the literal form only exists once the outer shell has
    // taken its layer off.
    const script = posixUnquote(command.slice('/bin/sh -lc '.length));
    expect(script).toContain("-t '=git-red-stamp-sound'");
  });

  it('execs the switch so the caller sees tmux own exit code', () => {
    // The caller keys its entire fallback off the exit code; a wrapper shell
    // exiting 0 over a failed switch would strand the pane on the old session.
    expect(command).toContain('exec tmux switch-client');
  });

  it('searches the same user-bin dirs as the join and the probe', () => {
    for (const dir of USER_BIN_DIRS) {
      expect(command).toContain(dir);
    }
  });

  it('quotes a session name carrying a single quote', () => {
    const nasty = sessionSwitchCommand(ttyVar, "it's mine");
    // Doubly nested: the name is quoted inside the script, and the script is
    // quoted inside `sh -lc`, so each `'` becomes `'\''` twice over.
    expect(nasty).not.toMatch(/-t '=it's mine'/);
    expect(nasty.endsWith("'")).toBe(true);
  });

  it('cannot be broken out of by a name built to close the quote', () => {
    const payload = "x'; rm -rf ~; echo '";
    const injected = sessionSwitchCommand(ttyVar, payload);
    // Unquoting the whole `sh -lc` argument must give back a script in which
    // the payload is still one quoted word — i.e. the payload never reaches
    // the outer shell as syntax.
    const script = posixUnquote(injected.slice('/bin/sh -lc '.length));
    expect(script).toContain(shellSingleQuote(`=${payload}`));
    expect(script.startsWith('export PATH=')).toBe(true);
  });
});

/**
 * Waiting for the client, which is the whole of the fast-switch bug.
 *
 * The handshake variable and the tmux client do not appear together: the join
 * publishes the tty as its first act and `tmuxctl` — Python — only execs
 * `tmux attach` a few hundred milliseconds later (1.5-2 s on a real host).
 * Ask `switch-client` for the client inside that window and it answers
 * `can't find client`, which the old script passed straight to the caller as a
 * flat failure. The caller re-joined, which opened a fresh window, so a user
 * clicking faster than their host could finish a join never got a single
 * switch and the feature was inert.
 *
 * These pin the shape of the wait rather than its timing; the timing is only
 * observable against a real tmux, and TmuxSwitch.integration.test.ts drives it
 * there with no settle delay at all.
 */
describe('sessionSwitchCommand — waiting for the client to come up', () => {
  const ttyVar = clientTtyVar('a1b2c3');

  it('checks the tty is a real client before trying to switch it', () => {
    // The check is the fix. Without it the script cannot tell "no client yet"
    // from "no client ever", because tmux reports both as `can't find client`.
    // Asserted against the UNQUOTED script: the `sh -lc` wrapper escapes the
    // inner quotes, so the literal form only exists once that layer is off.
    const script = posixUnquote(sessionSwitchCommand(ttyVar, 'alpha', 2_000).slice('/bin/sh -lc '.length));
    expect(script).toContain("list-clients -F '#{client_tty}'");
    expect(script).toContain('grep -qxF "$t"');
  });

  it('re-reads the handshake on every pass, not just the first', () => {
    // The value the loop starts with can be the OUTGOING join's tty; the
    // incoming join overwrites it part-way through the wait. A loop that read
    // once would wait out its whole budget on a tty already superseded.
    const script = sessionSwitchCommand(ttyVar, 'alpha', 2_000);
    const reads = script.match(new RegExp(`show-environment -g ${ttyVar}`, 'g'));
    expect(reads).toHaveLength(1);
    // ...and that single read sits INSIDE the loop.
    const loopStart = script.indexOf('while :; do');
    const loopEnd = script.indexOf('done;');
    expect(loopStart).toBeGreaterThan(-1);
    expect(script.indexOf('show-environment')).toBeGreaterThan(loopStart);
    expect(script.indexOf('show-environment')).toBeLessThan(loopEnd);
  });

  it('scales the number of attempts with the budget it is given', () => {
    const triesIn = (ms: number): number => {
      const m = /n=(\d+);/.exec(sessionSwitchCommand(ttyVar, 'alpha', ms));
      return Number(m?.[1]);
    };
    expect(triesIn(3_000)).toBeGreaterThan(triesIn(1_000));
    expect(triesIn(1_000)).toBeGreaterThan(triesIn(0));
  });

  it('still LOOKS for the client when told to wait for nothing', () => {
    // A zero budget means "do not wait", not "do not check". Skipping the
    // check would put back the exact failure this loop exists to remove.
    const command = sessionSwitchCommand(ttyVar, 'alpha', 0);
    expect(command).toContain('n=1;');
    expect(command).toContain('list-clients');
  });

  it('reports a missing client differently from a missing handshake', () => {
    // Two different diagnoses that were previously one number. 65 says the
    // rendezvous never happened — probably not even the same tmux server. 66
    // says it happened perfectly and the tty it named is not a live client, so
    // the join that owns it failed or the user detached.
    const command = sessionSwitchCommand(ttyVar, 'alpha', 1_000);
    expect(command).toContain(`exit ${SWITCH_CLIENT_NOT_READY_EXIT}`);
    expect(SWITCH_CLIENT_NOT_READY_EXIT).not.toBe(SWITCH_NO_CLIENT_EXIT);
  });

  it('prints what the clients ACTUALLY were when it gives up', () => {
    // The one fact worth having in the next bug report: the tty we wanted
    // against the ttys tmux had. Without it "can't find client" is unanswerable
    // from a log.
    const command = sessionSwitchCommand(ttyVar, 'alpha', 1_000);
    expect(command).toContain('no tmux client on %s');
    expect(command).toContain('#{client_tty} -> #{client_session}');
  });

  it('keeps a shell without fractional sleep correct rather than spinning', () => {
    // `sleep 0.15` is not POSIX (POSIX sleep takes an integer). busybox, GNU
    // and BSD all take it; a shell that does not must still pause.
    expect(sessionSwitchCommand(ttyVar, 'alpha', 1_000)).toContain('|| sleep 1');
  });
});

describe('sessionAttachCommand — the note a forced re-join carries', () => {
  it('says why, in the terminal, where the user is already looking', () => {
    const command = sessionAttachCommand('alpha', clientTtyVar('t1'), "can't find session: alpha");
    expect(command).toContain('[PocketShell] %s');
    expect(command).toContain("can'\\''t find session: alpha");
    // Before the join, because once tmux attaches it owns the screen.
    expect(command.indexOf('printf')).toBeLessThan(command.indexOf('tmuxctl'));
  });

  it('adds nothing at all to an ordinary first join', () => {
    const command = sessionAttachCommand('alpha', clientTtyVar('t1'));
    expect(command).not.toContain('[PocketShell] %s');
  });

  it('cannot be used to repaint the pane with remote bytes', () => {
    // The note is built from tmux's stderr, which is remote output. Control
    // bytes in it would be executed by the terminal it is printed into.
    const command = sessionAttachCommand('alpha', undefined, 'evil\u001b[2Jwipe\nsecond line');
    // Losing the ESC is what turns the rest into inert text rather than a
    // clear-screen; the newline goes with it so the note stays one line.
    expect(command).not.toContain('\u001b');
    expect(command).not.toContain('\n');
    expect(command).toContain('evil [2Jwipe second line');
  });
});
