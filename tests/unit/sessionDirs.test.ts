import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  directoryExistsProbeCommand,
  MAX_CANDIDATES_PER_SESSION,
  parseExistingDirectories,
  sessionDirCandidates,
} from '../../src/main/projects/sessionDirs';
import {
  parseSessionEnrichment,
  SESSION_ENRICHMENT_COMMAND,
} from '../../src/main/helper/parsers';

/**
 * The missing-working-directory bug, and the two halves of its fix.
 *
 * The user's log, for a whole day, on every refresh:
 *
 *     {"total":12,"probeRows":8,"unplaced":[
 *       {"name":"git-red-stamp-sound","probe":"absent",...},
 *       {"name":"git-auth","probe":"absent",...},
 *       {"name":"git-dtc-website-import","probe":"absent",...},
 *       {"name":"git-ai-engineering-field-guide","probe":"absent",...}],
 *      "unmatchedProbeKeys":[]}
 *
 * Three fixes had already gone at this from the parsing side. The fixtures
 * below are what settles it, and they are CAPTURED rather than written: real
 * tmux 3.4 in a container, six sessions, four of them on a second socket —
 * named after the user's own four, because the point is that the shape
 * reproduces exactly.
 *
 * `tmux34-list-panes-default-socket.txt` is what the old probe saw: two rows
 * for six sessions. `tmux34-list-panes-socket-sweep.txt` is what the new one
 * sees. `tmux34-list-panes-socket-diagnostic.txt` is the evidence line that
 * tells the two remaining causes apart, and it is unambiguous — two distinct
 * `#{pid}` values, so two servers.
 */
function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

describe('the probe sees every tmux server, not only the default socket', () => {
  it('reproduces the reported symptom on the default socket alone', () => {
    // Two rows for six live sessions. This is `probeRows: 8` / `total: 12` in
    // miniature, and it is not a parse failure: every row present parses.
    const map = parseSessionEnrichment(fixture('tmux34-list-panes-default-socket.txt'));
    expect([...map.keys()].sort()).toEqual(['git-dtc-website', 'git-red-stamp']);
    expect(map.get('git-red-stamp')?.path).toBe('/root/git/red-stamp');
  });

  it('places all six sessions once the sweep covers the other socket', () => {
    const map = parseSessionEnrichment(fixture('tmux34-list-panes-socket-sweep.txt'));
    expect([...map.keys()].sort()).toEqual([
      'git-ai-engineering-field-guide',
      'git-auth',
      'git-dtc-website',
      'git-dtc-website-import',
      'git-red-stamp',
      'git-red-stamp-sound',
    ]);
    // And the four that were absent now carry their real working directories,
    // including the nested one that name-derivation alone could only guess at.
    expect(map.get('git-dtc-website-import')?.path).toBe('/root/git/dtc-website/import');
    expect(map.get('git-red-stamp-sound')?.path).toBe('/root/git/red-stamp-sound');
    expect(map.get('git-auth')?.agentKind).toBe('codex');
  });

  it('is unbothered by the default socket appearing twice in the sweep', () => {
    // The command runs the default invocation AND then sweeps the directory
    // that contains the default socket, so those rows arrive twice. The parser
    // keys by session name, so the second reading overwrites the first with
    // itself — no duplicate rows, no lost agent kind.
    const sweep = fixture('tmux34-list-panes-socket-sweep.txt');
    expect(sweep.split('\n').filter((l) => l.startsWith('git-red-stamp:')).length).toBe(2);
    expect(parseSessionEnrichment(sweep).get('git-red-stamp')?.agentKind).toBe('claude');
  });

  it('keeps the plain invocation as well as the sweep', () => {
    // A host whose socket directory this glob does not model must not go from
    // eight rows to zero. The unconditional `tmux -u list-panes -a` is what
    // guarantees the sweep can only ADD.
    expect(SESSION_ENRICHMENT_COMMAND.startsWith('tmux -u list-panes -a -F ')).toBe(true);
    expect(SESSION_ENRICHMENT_COMMAND).toContain('[ -S "$__ps_s" ] || continue');
    expect(SESSION_ENRICHMENT_COMMAND).toContain('tmux -S "$__ps_s" -u list-panes -a');
  });
});

describe('candidate directories derived from a session name', () => {
  it('tries the FLAT reading first, which is what a repo directory is', () => {
    const candidates = sessionDirCandidates('git-ai-engineering-field-guide', '/home/alexey');
    expect(candidates[0]).toBe('/home/alexey/git/ai-engineering-field-guide');
  });

  it('offers both readings of the ambiguous name that blocked this before', () => {
    // `rootFromSessionName` refuses to derive a directory precisely because
    // this name means either of these. Offering both and letting the HOST say
    // which exists is what makes the refusal unnecessary.
    const candidates = sessionDirCandidates('git-dtc-website-import', '/home/alexey');
    expect(candidates).toContain('/home/alexey/git/dtc-website-import');
    expect(candidates).toContain('/home/alexey/git/dtc-website/import');
    expect(candidates.indexOf('/home/alexey/git/dtc-website-import')).toBe(0);
  });

  it('reads a hyphen-free name as one directory under the root', () => {
    expect(sessionDirCandidates('git-auth', '/home/alexey')).toEqual(['/home/alexey/git/auth']);
  });

  it('handles a name that is a bare root with no tail at all', () => {
    expect(sessionDirCandidates('scratch', '/home/alexey')).toEqual(['/home/alexey/scratch']);
  });

  it('caps the candidate list so one long name cannot flood the batch', () => {
    // Six components is 2^4 = 16 readings and only eight survive. Ordering by
    // separator count is what makes the cap harmless: the flat reading and all
    // four single-split ones are kept, and it is the deep splits — the shapes
    // nobody's repository directory actually has — that fall off.
    const candidates = sessionDirCandidates('git-a-b-c-d-e', '/home/alexey');
    expect(candidates.length).toBe(MAX_CANDIDATES_PER_SESSION);
    expect(candidates[0]).toBe('/home/alexey/git/a-b-c-d-e');
    // `/home/alexey/git/a-b-c-d-e` splits to five parts; each extra separator
    // adds one. So: one reading at five, all four single-split readings at
    // six, and nothing past seven survives.
    expect(candidates.filter((c) => c.split('/').length === 5).length).toBe(1);
    expect(candidates.filter((c) => c.split('/').length === 6).length).toBe(4);
    expect(candidates.filter((c) => c.split('/').length > 7)).toEqual([]);
  });

  it('produces nothing for an empty or hyphen-only name', () => {
    expect(sessionDirCandidates('', '/home/alexey')).toEqual([]);
    expect(sessionDirCandidates('---', '/home/alexey')).toEqual([]);
  });

  it('tolerates a home with a trailing slash', () => {
    // `$HOME` comes off the host verbatim, and a doubled slash in a path we
    // then ask `test -d` about would still work but would be logged, cached
    // and eventually shown to the user in that shape.
    expect(sessionDirCandidates('git-auth', '/home/alexey/')).toEqual(['/home/alexey/git/auth']);
  });
});

describe('the batched test -d probe', () => {
  it('quotes every candidate and prints only indices', () => {
    const command = directoryExistsProbeCommand([
      '/home/a/git/x',
      "/home/a/git/it's mine",
      '/home/a/git/we::ird',
    ]);
    expect(command).toContain("'/home/a/git/it'\\''s mine'");
    // The output carries no path at all, which is what makes it unambiguous
    // for a directory name containing the delimiter.
    expect(command).toContain("printf '%s\\n' \"$__ps_n\"");
    expect(command).not.toContain('$__ps_d"::');
  });

  it('is a no-op command for an empty request', () => {
    expect(directoryExistsProbeCommand([])).toBe('true');
  });

  it('maps the real host output back onto the requested paths', () => {
    // Captured from the same container run as the fixtures above: asked about
    // four directories, of which the first and the third exist.
    const requested = [
      '/root/git/red-stamp-sound',
      '/root/git/dtc-website-import',
      '/root/git/dtc-website/import',
      '/root/git/nope',
    ];
    const exists = parseExistingDirectories('0\n2\n', requested);
    expect([...exists].sort()).toEqual([
      '/root/git/dtc-website/import',
      '/root/git/red-stamp-sound',
    ]);
  });

  it('drops anything that is not a bare index', () => {
    // A login shell's banner, an out-of-range index, a number with a suffix.
    // Reading any of these as a position would report a directory as existing
    // on the strength of an unrelated line.
    const requested = ['/a', '/b'];
    expect([...parseExistingDirectories('Welcome to Ubuntu\n1abc\n7\n1\n', requested)]).toEqual([
      '/b',
    ]);
  });
});
