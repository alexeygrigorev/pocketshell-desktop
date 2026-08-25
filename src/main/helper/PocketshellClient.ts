/**
 * Client for the server-side `pocketshell` helper. Runs subcommands over an
 * existing SSH connection (via SshService.exec) and parses their output.
 *
 * Mirrors the Android `HostTmuxSessionsGateway` / `PocketshellClient`
 * pattern: try the helper first, fall back to raw tmux when the helper is
 * absent (or returns non-zero).
 */

import type { SshService } from '../ssh/SshService.js';
import type { SessionSummary } from '../../shared/types.js';
import {
  parseSessionsList,
  parseTmuxListSessionsFallback,
  parseUsageNdjson,
  parseSessionEnrichment,
  diagnoseSessionPaths,
  mergeSessionEnrichment,
  SESSION_ENRICHMENT_COMMAND,
  type UsageRow,
  type SessionEnrichment,
} from './parsers.js';
import { pathAwareCommand } from './bootstrap.js';
import { gitRepoProbeCommand } from '../projects/commands.js';
import { parseWorktreeRoots } from '../projects/worktrees.js';
import { log } from '../log.js';
import { shellQuote, shellQuoteRemotePath } from './shellQuote.js';
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
    const [helper, enrichment] = await Promise.all([
      this.ssh.exec(connectionId, pathAwareCommand(`pocketshell sessions list --by ${sortBy}`)),
      this.sessionEnrichment(connectionId),
    ]);
    if (helper.exitCode === 0) {
      const parsed = parseSessionsList(helper.stdout);
      if (parsed.length > 0 || /IDX\s+SESSION/.test(helper.stdout)) {
        return this.withRepoRoots(
          connectionId,
          this.reportPaths(mergeSessionEnrichment(parsed, enrichment), enrichment),
        );
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
      return this.withRepoRoots(
        connectionId,
        this.reportPaths(
          mergeSessionEnrichment(parseTmuxListSessionsFallback(tmux.stdout), enrichment),
          enrichment,
        ),
      );
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

  private reportPaths(
    sessions: SessionSummary[],
    enrichment: Map<string, SessionEnrichment>,
  ): SessionSummary[] {
    const report = diagnoseSessionPaths(sessions, enrichment);
    if (report.unplaced.length > 0) {
      log('sessions', 'sessions with no reported working directory', {
        total: report.total,
        probeRows: enrichment.size,
        unplaced: report.unplaced,
        unmatchedProbeKeys: report.unmatchedProbeKeys,
      });
    }
    return sessions;
  }

  /**
   * Run the companion tmux probe for cwd / attached / agent kind.
   *
   * Degrades to an empty map on ANY failure — no tmux, no server running, a
   * tmux too old to expand `#{@ps_agent_kind}`. Sessions must still list when
   * this probe comes back empty; only the folder-grouping metadata is lost.
   */
  private async sessionEnrichment(connectionId: string): Promise<Map<string, SessionEnrichment>> {
    const res = await this.ssh.exec(connectionId, pathAwareCommand(SESSION_ENRICHMENT_COMMAND));
    if (res.exitCode !== 0) return new Map();
    return parseSessionEnrichment(res.stdout);
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
