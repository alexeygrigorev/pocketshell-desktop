/**
 * Client for the server-side `pocketshell` helper. Runs subcommands over an
 * existing SSH connection (via SshService.exec) and parses their output.
 *
 * Mirrors the Android `HostTmuxSessionsGateway` / `PocketshellClient`
 * pattern: try the helper first, fall back to raw tmux when the helper is
 * absent (or returns non-zero).
 */

import type { SshService } from '../ssh/SshService.js';
import type { ExecResult, SessionSummary } from '../../shared/types.js';
import {
  parseSessionsList,
  parseTmuxListSessionsFallback,
  parseUsageNdjson,
  parseSessionEnrichment,
  diagnoseSessionPaths,
  mergeSessionEnrichment,
  SESSION_ENRICHMENT_COMMAND,
  SESSION_SOCKET_DIAGNOSTIC_COMMAND,
  type UsageRow,
  type SessionEnrichment,
} from './parsers.js';
import { pathAwareCommand } from './bootstrap.js';
import { gitRepoProbeCommand, HOME_COMMAND } from '../projects/commands.js';
import { parseWorktreeRoots } from '../projects/worktrees.js';
import {
  directoryExistsProbeCommand,
  parseExistingDirectories,
  sessionDirCandidates,
} from '../projects/sessionDirs.js';
import { log } from '../log.js';
import { shellQuote, shellQuoteRemotePath } from '../../shared/shellQuote.js';
import {
  createSessionCommand,
  fallbackCreateSessionCommand,
  reposCloneCommand,
  reposListCommand,
  type ReposCloneOptions,
  type ReposListOptions,
} from '../projects/commands.js';
import {
  annotateHelperRejection,
  classifyReposFailure,
  isHelperMissing,
  parseReposJson,
  type ReposScopeResult,
  type ReposScopeState,
} from '../projects/repos.js';

/** How a session create was satisfied. */
export type CreateSessionVia = 'helper' | 'tmux-fallback';

/** Outcome of {@link PocketshellClient.createSession}. Never thrown. */
export interface CreateSessionOutcome {
  ok: boolean;
  /** The name the host actually used (the helper echoes it back). */
  name: string | null;
  via: CreateSessionVia;
  error: string | null;
}

/** Outcome of {@link PocketshellClient.reposClone}. Never thrown. */
export interface CloneOutcome {
  ok: boolean;
  /** Absolute path of the clone on the host. */
  path: string | null;
  /** True when the clone was already there and we recovered its path. */
  alreadyExists: boolean;
  error: string | null;
  /** Set on failure so the UI can distinguish "install gh" from a git error. */
  state?: Exclude<ReposScopeState, 'ok'>;
}

/** The companion tmux probe's parsed map PLUS the bytes it came from. */
interface SessionEnrichmentProbe {
  enrichment: Map<string, SessionEnrichment>;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Everything the unplaced-session log line needs, carried together.
 *
 * Grouped into one parameter rather than passed as three, because they are one
 * thing: the raw evidence for a single `listSessions` call. Splitting them let
 * an earlier version log the parsed counts without the bytes that produced
 * them, which is how the same bug survived three fixes.
 */
interface SessionListEvidence {
  enrichment: Map<string, SessionEnrichment>;
  probe: SessionEnrichmentProbe;
  /** The command that produced the NAMES: the helper, or the tmux fallback. */
  helper: ExecResult;
}

/**
 * A bounded slice of host output for the log.
 *
 * The length is reported separately by the caller, so a clipped value is never
 * mistaken for a short one - which matters, because "was the output truncated"
 * is one of the questions this evidence exists to answer.
 */
function clip(value: string, limit = 4000): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...[${value.length - limit} more bytes]`;
}

/**
 * One-shot helper invocations over a connected host. Stateless: pass the
 * SshService + connectionId into each call.
 */
export class PocketshellClient {
  constructor(private readonly ssh: SshService) {}

  /**
   * Worktree -> repository root, per connection, resolved once per directory.
   *
   * A `null` value is a REMEMBERED NEGATIVE: "we asked about this directory and
   * it is not a worktree". Without it, every folder that is an ordinary
   * checkout would be re-probed on every session refresh — and the refresh is
   * on a timer, so that would put a git process on the user's host every few
   * seconds, forever, to be told the same thing.
   *
   * Cached for the life of the connection because the answer cannot change
   * usefully while the app is open: a directory does not stop being a worktree
   * of the repository it was created from. A directory that appears later is
   * simply not in the map yet and gets asked about on the next refresh.
   */
  private readonly repoRoots = new Map<string, Map<string, string | null>>();

  /**
   * Session name -> the directory the host confirmed exists for it, per
   * connection.
   *
   * A `null` value is a REMEMBERED NEGATIVE, for the same reason as
   * {@link repoRoots}: "we asked the host about every candidate directory this
   * name could mean, and none of them exist". Without it, a session that is
   * genuinely unrecoverable would put a `test -d` batch on the user's host on
   * every timer tick, forever, to be told the same thing.
   *
   * A directory created LATER is therefore not picked up until the connection
   * is remade. That is the same trade the worktree cache takes and it is easier
   * here: a session is created IN a directory, so a session whose directory
   * does not exist yet is not a case that arises in that order.
   */
  private readonly sessionDirs = new Map<string, Map<string, string | null>>();

  /** Remote `$HOME` per connection; null means "asked, and could not tell". */
  private readonly homes = new Map<string, string | null>();

  /**
   * List live tmux sessions. Prefers `pocketshell sessions list`, falls back
   * to `tmux list-sessions` when the helper is absent. Returns [] when no
   * tmux server is running (the canonical "empty" state, not an error).
   */
  async listSessions(connectionId: string, sortBy: 'activity' | 'created' = 'activity'): Promise<SessionSummary[]> {
    // Primary + companion in ONE round-trip. `pocketshell sessions list` gives
    // names and creation times; the tmux probe gives the cwd, attached flag,
    // and recorded agent kind that the three-column table simply does not
    // carry. They are independent execs on the same connection, so issuing
    // them together costs one RTT rather than two.
    const [helper, probe] = await Promise.all([
      this.ssh.exec(connectionId, pathAwareCommand(`pocketshell sessions list --by ${sortBy}`)),
      this.sessionEnrichment(connectionId),
    ]);
    const { enrichment } = probe;
    if (helper.exitCode === 0) {
      const parsed = parseSessionsList(helper.stdout);
      if (parsed.length > 0 || /IDX\s+SESSION/.test(helper.stdout)) {
        const merged = await this.withDerivedPaths(
          connectionId,
          mergeSessionEnrichment(parsed, enrichment),
          { enrichment, probe, helper },
        );
        return this.withRepoRoots(connectionId, merged);
      }
    }
    // Fallback: raw tmux with the same `::` shape the Android gateway uses.
    const tmux = await this.ssh.exec(
      connectionId,
      pathAwareCommand(
        "tmux list-sessions -F '#{session_name}::#{session_created}::#{session_activity}::#{session_attached}::#{session_path}'",
      ),
    );
    if (tmux.exitCode === 0) {
      // Still merged: the fallback's `session_path` is the *session's* cwd,
      // and the probe's active-pane cwd is the better answer when both exist.
      const merged = await this.withDerivedPaths(
        connectionId,
        mergeSessionEnrichment(parseTmuxListSessionsFallback(tmux.stdout), enrichment),
        { enrichment, probe, helper: tmux },
      );
      return this.withRepoRoots(connectionId, merged);
    }
    // "no server running" / "not found" -> empty (not an error).
    return [];
  }

  /**
   * Write one log line for every session the probe failed to place.
   *
   * Silent when everything placed, which is the normal case and must stay
   * free. When it is not free, this is the only way to tell the three causes
   * apart from a screenshot: a session in the wrong place looks identical
   * whether the probe skipped it, reported it with empty path columns, or had
   * its key dropped by the drop-on-collision rule (see
   * {@link diagnoseSessionPaths}). The user is asked to paste these lines; the
   * `unplaced` array is the whole answer.
   *
   * The list is returned unchanged - this observes, it never decides.
   */
  /**
   * Fill in {@link SessionSummary.repoRoot} for sessions running in a linked
   * git worktree (docs/WORKSPACE.md §6.5).
   *
   * Only DIRECTORIES NOT ALREADY KNOWN are asked about, and they are asked
   * about in ONE exec — the same batching discipline as the session-enrichment
   * probe. On a steady-state host that means zero git processes per refresh,
   * because every directory is already in the cache.
   *
   * Degrades to today's behaviour, silently, on every failure path: no git, not
   * a repository, a non-zero exit, an unparseable line. All of them leave the
   * directory absent from the map, which leaves `repoRoot` unset, which leaves
   * the session grouped by its own path.
   */
  private async withRepoRoots(
    connectionId: string,
    sessions: SessionSummary[],
  ): Promise<SessionSummary[]> {
    let known = this.repoRoots.get(connectionId);
    if (!known) {
      known = new Map();
      this.repoRoots.set(connectionId, known);
    }

    const unknown = [
      ...new Set(
        sessions
          .map((s) => s.path)
          .filter((p): p is string => typeof p === 'string' && p.length > 0 && p.startsWith('/'))
          .filter((p) => !known.has(p)),
      ),
    ];

    if (unknown.length > 0) {
      const res = await this.ssh.exec(connectionId, pathAwareCommand(gitRepoProbeCommand(unknown)));
      // Even on a non-zero exit the loop may have printed rows before whatever
      // failed, so parse what came back rather than discarding it.
      const roots = parseWorktreeRoots(res.stdout, unknown);
      // Every directory we asked about is recorded, including the ones that
      // answered "not a worktree" — see `repoRoots` for why the negative is
      // worth as much as the positive.
      for (const dir of unknown) known.set(dir, roots.get(dir) ?? null);
      const remapped = [...roots.entries()].filter(([dir]) => unknown.includes(dir));
      if (remapped.length > 0) {
        log('sessions', 'worktrees grouped under their repository', {
          worktrees: remapped.map(([dir, root]) => ({ dir, root })),
        });
      }
    }

    return sessions.map((session) => {
      const root = session.path ? known.get(session.path) : null;
      return root ? { ...session, repoRoot: root } : session;
    });
  }

  /**
   * Give a still-unplaced session the directory its NAME points at, once the
   * host has confirmed that directory exists.
   *
   * ## What this is for
   *
   * The tmux probe is the real answer and this never overrides it: a session
   * that reported its own working directory is returned untouched. This runs
   * only for the rows the probe could not place at all - and on the user's host
   * that was a third of them, four of twelve, every refresh, for a whole day.
   * See ../projects/sessionDirs.ts for the evidence about WHY the probe cannot
   * see them, which is that they are not on the tmux server it reaches.
   *
   * A session with no folder is not a cosmetic problem: the folder workspace
   * keys everything on the folder, so an unplaced session has nowhere to live
   * and the user cannot open it at all. That is why this is worth a host round
   * trip on the failure path.
   *
   * ## It confirms, it does not guess
   *
   * `git-dtc-website-import` is genuinely ambiguous between
   * `~/git/dtc-website-import` and `~/git/dtc-website/import`, and that
   * ambiguity is the documented reason `rootFromSessionName` refuses to derive
   * a directory from a name. It is resolved here by ASKING: every candidate
   * goes to the host in one batched `test -d`, and only a directory that
   * actually exists is ever adopted. The first surviving candidate wins.
   *
   * ## Rows that already have an INFERRED path are re-asked
   *
   * `inferPathsFromSiblings` files `git-red-stamp-sound` under
   * `git-red-stamp`'s directory because the names look like a suffix pair. That
   * is a reasonable guess and it is marked `pathInferred` precisely because it
   * might be wrong. If the host turns out to have `~/git/red-stamp-sound`, that
   * is the session's OWN directory and it beats the sibling's - so those rows
   * are asked about too, and a confirmed hit clears the `pathInferred` flag.
   *
   * ## Cost
   *
   * One exec, only when something is unplaced, and only for names not already
   * in the per-connection cache. A steady-state host with nothing unplaced
   * makes no call at all; a host with a permanently unrecoverable session pays
   * one exec on the first refresh and none afterwards, because the negative is
   * remembered - the same discipline, and the same trade, as the worktree cache
   * above.
   */
  private async withDerivedPaths(
    connectionId: string,
    sessions: SessionSummary[],
    raw: SessionListEvidence,
  ): Promise<SessionSummary[]> {
    const report = diagnoseSessionPaths(sessions, raw.enrichment);
    if (report.unplaced.length === 0) return sessions;

    let known = this.sessionDirs.get(connectionId);
    if (!known) {
      known = new Map();
      this.sessionDirs.set(connectionId, known);
    }

    const home = await this.homeDir(connectionId);
    // Names we have never asked about. A cached `null` is "we asked the host
    // and none of this name's candidate directories exist" - see the field's
    // own comment for why remembering that matters more than it looks.
    const fresh = report.unplaced.map((u) => u.name).filter((name) => !known.has(name));

    if (home !== null && fresh.length > 0) {
      // One flat candidate list across every session, so the whole batch is a
      // single exec. `offsets` remembers where each session's slice starts, so
      // the first EXISTING candidate for a session is still that session's
      // best answer rather than whichever line the host printed first.
      const candidates: string[] = [];
      const offsets = new Map<string, [number, number]>();
      for (const name of fresh) {
        const own = sessionDirCandidates(name, home);
        offsets.set(name, [candidates.length, candidates.length + own.length]);
        candidates.push(...own);
      }
      const res = await this.ssh.exec(
        connectionId,
        pathAwareCommand(directoryExistsProbeCommand(candidates)),
      );
      // Parsed regardless of exit code, like the worktree probe: the loop may
      // have printed rows before whatever failed, and discarding them would
      // throw away an answer we already have.
      const exists = parseExistingDirectories(res.stdout, candidates);
      for (const name of fresh) {
        const [from, to] = offsets.get(name) ?? [0, 0];
        const hit = candidates.slice(from, to).find((path) => exists.has(path));
        known.set(name, hit ?? null);
      }
    }

    const placed = sessions.map((session) => {
      const derived = known.get(session.name);
      if (derived == null) return session;
      // The flag goes away with the guess it described: this path is the
      // session's own, confirmed on the host, and the UI must stop marking the
      // row as a guess.
      return { ...session, path: derived, pathInferred: false };
    });

    this.reportPaths(connectionId, placed, raw);
    return placed;
  }

  /**
   * The remote `$HOME`, resolved once per connection.
   *
   * Its own tiny cache rather than a dependency on ProjectsService: this class
   * is constructed with an SshService and nothing else, and threading a second
   * service through every call site to run `printf %s "$HOME"` would be a
   * larger change than the one line it saves. Null on any failure, which
   * simply skips the derivation and leaves today's behaviour.
   */
  private async homeDir(connectionId: string): Promise<string | null> {
    const cached = this.homes.get(connectionId);
    if (cached !== undefined) return cached;
    const res = await this.ssh.exec(connectionId, pathAwareCommand(HOME_COMMAND));
    const home = res.exitCode === 0 ? res.stdout.trim() : '';
    const value = home.startsWith('/') ? home : null;
    this.homes.set(connectionId, value);
    return value;
  }

  /**
   * Write one log line for every session that still has no working directory of
   * its own, WITH the raw host output that produced it.
   *
   * Silent when everything placed, which is the normal case and must stay free.
   *
   * ## Why the raw output is in here now
   *
   * The parsed counts alone sent three separate fixes down the wrong road. The
   * decisive number in the user's log was `probeRows: 8` against `total: 12`,
   * and `probeRows` is `enrichment.size` - the size of a map keyed by session
   * name, i.e. rows that SURVIVED the parse and were then deduplicated. It
   * cannot distinguish "tmux emitted four fewer rows" from "the parser
   * discarded four rows" from "four rows arrived under a colliding name", and
   * the previous attempts each assumed one of those and fixed it.
   *
   * A bounded slice of the actual bytes settles it in one reading, and the BYTE
   * LENGTH beside it settles the one thing a slice cannot: whether the output
   * was truncated. `stderr` and the exit code come too, because a probe that
   * half-failed looks identical to one that found nothing.
   *
   * Bounded rather than complete, deliberately. This file is the user's, it is
   * read by hand, and a probe on a busy host runs to tens of kilobytes; the cap
   * is what keeps a diagnostic from becoming the thing that needs diagnosing.
   *
   * The list is returned unchanged - this observes, it never decides.
   */
  private reportPaths(
    connectionId: string,
    sessions: SessionSummary[],
    raw: SessionListEvidence,
  ): SessionSummary[] {
    const report = diagnoseSessionPaths(sessions, raw.enrichment);
    if (report.unplaced.length === 0) return sessions;

    log('sessions', 'sessions with no reported working directory', {
      total: report.total,
      probeRows: raw.enrichment.size,
      unplaced: report.unplaced,
      unmatchedProbeKeys: report.unmatchedProbeKeys,
      // Everything below is the raw evidence, so the next report does not need
      // another round of guessing.
      probeExit: raw.probe.exitCode,
      probeBytes: raw.probe.stdout.length,
      probeStdout: clip(raw.probe.stdout),
      probeStderr: clip(raw.probe.stderr, 400),
      listBytes: raw.helper.stdout.length,
      listStdout: clip(raw.helper.stdout),
      listStderr: clip(raw.helper.stderr, 400),
    });

    // A second round trip, only ever on this path, and only to answer the one
    // question the rows above cannot: which tmux SERVER each session is on. Two
    // distinct `#{pid}` values mean two servers; a listed session appearing in
    // no row here exists on no socket we can reach. Fire-and-forget, because a
    // diagnostic must never delay the list it is diagnosing.
    void this.ssh
      .exec(connectionId, pathAwareCommand(SESSION_SOCKET_DIAGNOSTIC_COMMAND))
      .then((res) => {
        log('sessions', 'which tmux server each session is on', {
          exit: res.exitCode,
          bytes: res.stdout.length,
          stdout: clip(res.stdout),
        });
      })
      .catch(() => {
        // A diagnostic that fails is not an error the user should ever see.
      });

    return sessions;
  }

  /**
   * Run the companion tmux probe for cwd / attached / agent kind.
   *
   * Degrades to an empty map on ANY failure — no tmux, no server running, a
   * tmux too old to expand `#{@ps_agent_kind}`. Sessions must still list when
   * this probe comes back empty; only the folder-grouping metadata is lost.
   */
  private async sessionEnrichment(connectionId: string): Promise<SessionEnrichmentProbe> {
    const res = await this.ssh.exec(connectionId, pathAwareCommand(SESSION_ENRICHMENT_COMMAND));
    // Parsed even on a non-zero exit, which is a change and a deliberate one.
    // The probe is now a SEQUENCE - the default socket, then a loop over every
    // other socket this user has - so its exit code is whatever the last
    // iteration produced, and one stale socket whose server has died would
    // otherwise throw away every row the healthy ones printed. Same reasoning
    // the worktree probe already uses: parse what came back.
    return {
      enrichment: parseSessionEnrichment(res.stdout),
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  }

  /**
   * Create a detached tmux session called [name] in [cwd].
   *
   * `--mem` is NOT passed — see {@link createSessionCommand}.
   *
   * ## Idempotency
   *
   * Both the helper path (`sessions create` -> `tmuxctl create-detached`) and
   * the fallback (`tmux new-session -A -d`) are no-op successes when the named
   * session already exists. That is load-bearing for the folder-first flow:
   * the session name is derived from the folder, so "start a session here" for
   * a folder that already has one must re-open it, not fail and not create a
   * second one.
   *
   * ## One fallback layer, not the phone's two
   *
   * The Android gateway builds a POSIX-sh wrapper that probes `command -v
   * tmuxctl` and `tmuxctl create-detached --help`, exits a sentinel 97 when
   * either fails, and falls back to raw `tmux new-session` — because the phone
   * invokes **tmuxctl directly** and therefore owns that capability question.
   * The desktop goes through `pocketshell sessions create`, which IS the
   * helper's own wrapper around tmuxctl: it already resolves the memory cap
   * from the repo's `cgroups.toml`, and on a host with no cgroup support it
   * prints "tmuxctl: systemd-run unavailable; session runs without a memory
   * cap" to stderr and exits 0 (observed on the Docker fixture). So the
   * phone's layer 2 is handled server-side and its layer 1 is the helper's
   * business, not ours.
   *
   * What is left is the one case the helper cannot handle for us: `pocketshell`
   * is not installed on the host at all. That is detected by
   * {@link isHelperMissing} — and only then do we run the raw tmux create.
   * `via` in the result tells the caller which path ran, so the UI can say
   * "created without a memory cap" honestly.
   *
   * The predicate is deliberately narrow, and got narrower: it used to also
   * fire on Click's "No such command" / "No such option" (helper too old for
   * the subcommand), which is exactly the input this fallback must NOT accept.
   * Falling back trades the repo's `cgroups.toml` memory cap for no cap at all
   * and still reports `ok: true`, so a mistyped flag would have looked like a
   * successful create while quietly ignoring a budget the repo declared for
   * itself. Those exits now return `ok: false` with the host's line plus the
   * explanation from {@link annotateHelperRejection}.
   */
  async createSession(
    connectionId: string,
    opts: { name: string; cwd: string },
  ): Promise<CreateSessionOutcome> {
    const res = await this.ssh.exec(
      connectionId,
      pathAwareCommand(createSessionCommand(opts.name, opts.cwd)),
    );
    if (res.exitCode === 0) {
      // The helper echoes the resolved name on stdout; trust it over ours.
      const printed = res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      return { ok: true, name: printed ?? opts.name, via: 'helper', error: null };
    }
    const output = `${res.stdout}\n${res.stderr}`;
    if (!isHelperMissing(res.exitCode, output)) {
      const hostMessage =
        res.stderr.trim() || res.stdout.trim() || `sessions create exited ${res.exitCode}`;
      return {
        ok: false,
        name: null,
        via: 'helper',
        error: annotateHelperRejection(hostMessage, output),
      };
    }
    const fallback = await this.ssh.exec(
      connectionId,
      pathAwareCommand(fallbackCreateSessionCommand(opts.name, opts.cwd)),
    );
    if (fallback.exitCode === 0) {
      return { ok: true, name: opts.name, via: 'tmux-fallback', error: null };
    }
    return {
      ok: false,
      name: null,
      via: 'tmux-fallback',
      error:
        fallback.stderr.trim() ||
        fallback.stdout.trim() ||
        `tmux new-session exited ${fallback.exitCode}`,
    };
  }

  /**
   * `pocketshell repos list` for ONE scope.
   *
   * Never throws and never reports a missing/unauthenticated `gh` as a
   * failure of the call — those come back as a typed `state` with an empty
   * row list, because a host without the GitHub CLI is a normal host.
   */
  async reposList(connectionId: string, options: ReposListOptions): Promise<ReposScopeResult> {
    const res = await this.ssh.exec(connectionId, pathAwareCommand(reposListCommand(options)));
    if (res.exitCode === 0) {
      return { state: 'ok', repos: parseReposJson(res.stdout), error: null };
    }
    const { state, error } = classifyReposFailure(res.exitCode, res.stdout, res.stderr);
    return { state, repos: [], error };
  }

  /**
   * `pocketshell repos clone <owner/repo>` — clone and return the path.
   *
   * Not idempotent, unlike session creation: re-cloning an existing target
   * exits 1 with "clone target already exists: <path>". That path is the
   * useful part of the answer, so it is recovered into `path` with
   * `alreadyExists: true` rather than being reported as a bare failure — the
   * folder-first flow can then just start a session in the existing clone.
   */
  async reposClone(connectionId: string, options: ReposCloneOptions): Promise<CloneOutcome> {
    const res = await this.ssh.exec(connectionId, pathAwareCommand(reposCloneCommand(options)));
    if (res.exitCode === 0) {
      const path = res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (path) return { ok: true, path, alreadyExists: false, error: null };
      return { ok: false, path: null, alreadyExists: false, error: 'clone printed no path' };
    }
    const stderr = res.stderr.trim();
    const existing = /clone target already exists:\s*(.+)$/m.exec(stderr);
    if (existing) {
      return { ok: true, path: existing[1]!.trim(), alreadyExists: true, error: null };
    }
    const { state, error } = classifyReposFailure(res.exitCode, res.stdout, res.stderr);
    return { ok: false, path: null, alreadyExists: false, error, state };
  }

  /** Provider quota via `pocketshell usage --json`. Returns [] if unavailable. */
  async usage(connectionId: string): Promise<UsageRow[]> {
    const res = await this.ssh.exec(connectionId, pathAwareCommand('pocketshell usage --json'));
    if (res.exitCode !== 0) return [];
    return parseUsageNdjson(res.stdout);
  }

  /**
   * Agent config-dir profiles (`pocketshell profiles list --json`).
   *
   * 0.4.44 emits a `{"profiles": [...]}` ENVELOPE. The bare array the stale
   * v0.4.8 docs described is not accepted: this app targets one helper version
   * and takes hard cuts over shims (ANALYSIS.md D22), and a second accepted
   * shape is a second thing that can silently return `[]` without anyone
   * noticing which branch ran.
   */
  async listProfiles(connectionId: string): Promise<unknown[]> {
    const res = await this.ssh.exec(connectionId, pathAwareCommand('pocketshell profiles list --json'));
    if (res.exitCode !== 0) return [];
    try {
      const parsed: unknown = JSON.parse(res.stdout.trim());
      const envelope = (parsed as { profiles?: unknown } | null)?.profiles;
      // Array.isArray narrows `unknown` to `any[]`, so the result is cast back
      // to `unknown[]` rather than leaking `any` to the caller.
      return Array.isArray(envelope) ? (envelope as unknown[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Env keys for a folder (`pocketshell env list --dir D --json`).
   *
   * Rows are `{file, has_value, key}` — names only, never values (the
   * helper's write-only default, D24).
   */
  async envList(connectionId: string, dir: string): Promise<unknown[]> {
    const res = await this.ssh.exec(
      connectionId,
      pathAwareCommand(`pocketshell env list --dir ${shellQuoteRemotePath(dir)} --json`),
    );
    if (res.exitCode !== 0) return [];
    try {
      // Typed `unknown`, matching listProfiles above: an untyped JSON.parse
      // leaks `any` through the return and defeats checking downstream.
      const parsed: unknown = JSON.parse(res.stdout.trim());
      return Array.isArray(parsed) ? (parsed as unknown[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Env values for a folder (`pocketshell env get --dir D --key K … --json`).
   *
   * `--key` is **required** and repeatable on 0.4.44 — `env get --dir D
   * --json` alone exits **2** with `Error: Missing option '--key'`. The old
   * call omitted it, so every lookup hit the non-zero branch and silently
   * returned `{}`: the env editor could never show a single value. Verified
   * on the fixture (`pocketshell env get --help`).
   *
   * With no `keys` the folder's whole env is read, which takes the two calls
   * the helper's write-only default forces: `env list` for the names, then
   * one `env get` revealing them. Pass `keys` to reveal only some.
   */
  async envGet(
    connectionId: string,
    dir: string,
    keys?: readonly string[],
  ): Promise<Record<string, string>> {
    const wanted = keys?.length ? [...keys] : await this.envKeyNames(connectionId, dir);
    if (wanted.length === 0) return {};
    const keyArgs = wanted.map((key) => `--key ${shellQuote(key)}`).join(' ');
    const res = await this.ssh.exec(
      connectionId,
      pathAwareCommand(
        `pocketshell env get --dir ${shellQuoteRemotePath(dir)} ${keyArgs} --json`,
      ),
    );
    if (res.exitCode !== 0) return {};
    try {
      const parsed: unknown = JSON.parse(res.stdout.trim());
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** The `key` field of every {@link envList} row, deduped and in order. */
  private async envKeyNames(connectionId: string, dir: string): Promise<string[]> {
    const rows = await this.envList(connectionId, dir);
    const names: string[] = [];
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const key = (row as { key?: unknown }).key;
      if (typeof key === 'string' && key.length > 0 && !names.includes(key)) names.push(key);
    }
    return names;
  }
}
