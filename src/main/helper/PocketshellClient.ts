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
  parseResumableTable,
  parseAgentLogJson,
  parseSessionEnrichment,
  mergeSessionEnrichment,
  SESSION_ENRICHMENT_COMMAND,
  type UsageRow,
  type ResumableSession,
  type AgentLogEnvelope,
  type SessionEnrichment,
} from './parsers.js';
import { pathAwareCommand } from './bootstrap.js';
import { shellQuote, shellQuoteRemotePath } from './shellQuote.js';
import {
  TRANSCRIPT_PROBE_COMMAND,
  describeUnresolved,
  parseTranscriptProbe,
  pickTranscript,
  type TranscriptEngine,
} from '../agents/transcripts.js';
import {
  createSessionCommand,
  fallbackCreateSessionCommand,
  reposCloneCommand,
  reposListCommand,
  type ReposCloneOptions,
  type ReposListOptions,
} from '../projects/commands.js';
import {
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
 * The Conversation tab's whole answer for one session.
 *
 * A discriminated union rather than a bag of nullables, so a caller cannot
 * render `lines` without having gone through `ok` first — and so the failure
 * arm is *required* to carry an `error` sentence. An empty conversation pane
 * with no explanation is the exact bug this shape rules out.
 */
export type SessionConversation =
  | {
      ok: true;
      engine: TranscriptEngine;
      /** The `agent-log --session` id we resolved for this tmux session. */
      transcriptId: string;
      /** Absolute path of the transcript on the host. */
      path: string;
      /** Raw JSONL lines, oldest first, for `renderConversation`. */
      lines: string[];
      /**
       * False when the transcript was matched by engine + recency alone
       * because its path cannot encode a cwd (codex/opencode). The UI says so
       * rather than implying certainty it does not have.
       */
      cwdVerified: boolean;
      error: null;
    }
  | {
      ok: false;
      engine: null;
      transcriptId: null;
      path: null;
      lines: [];
      cwdVerified: false;
      /** Always set, always showable to the user. */
      error: string;
    };

/**
 * One-shot helper invocations over a connected host. Stateless: pass the
 * SshService + connectionId into each call.
 */
export class PocketshellClient {
  constructor(private readonly ssh: SshService) {}

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
        return mergeSessionEnrichment(parsed, enrichment);
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
      return mergeSessionEnrichment(parseTmuxListSessionsFallback(tmux.stdout), enrichment);
    }
    // "no server running" / "not found" -> empty (not an error).
    return [];
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
   * What is left is the one case the helper cannot handle for us: the helper
   * is not installed at all, or is too old to have the subcommand. That is
   * detected by {@link isHelperMissing} — narrowly, so a genuine create
   * failure is reported rather than being silently downgraded to an uncapped
   * session — and only then do we run the raw tmux create. `via` in the result
   * tells the caller which path ran, so the UI can say "created without a
   * memory cap" honestly.
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
    if (!isHelperMissing(res.exitCode, `${res.stdout}\n${res.stderr}`)) {
      return {
        ok: false,
        name: null,
        via: 'helper',
        error: res.stderr.trim() || res.stdout.trim() || `sessions create exited ${res.exitCode}`,
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

  /** Resumable AI-CLI conversations. Returns [] if the helper is absent. */
  async listResumable(connectionId: string, allProjects = true): Promise<ResumableSession[]> {
    const flag = allProjects ? ' --all' : '';
    const res = await this.ssh.exec(
      connectionId,
      pathAwareCommand(`pocketshell sessions resumable${flag}`),
    );
    if (res.exitCode !== 0) return [];
    return parseResumableTable(res.stdout);
  }

  /** Read a per-engine agent conversation log (`--json` envelope). */
  async agentLog(
    connectionId: string,
    engine: 'claude' | 'codex' | 'opencode',
    session: string,
    cwd?: string,
  ): Promise<AgentLogEnvelope | null> {
    const cwdArg = cwd ? ` --cwd '${cwd.replace(/'/g, "'\\''")}'` : '';
    const res = await this.ssh.exec(
      connectionId,
      pathAwareCommand(
        `pocketshell agent-log --engine ${engine} --session '${session.replace(/'/g, "'\\''")}'${cwdArg} --json`,
      ),
    );
    if (res.exitCode !== 0) return null; // 66 = not found
    return parseAgentLogJson(res.stdout);
  }

  /**
   * The conversation belonging to ONE tmux session, resolved end to end.
   *
   * This is what the Conversation tab calls, and it exists because
   * {@link agentLog} cannot be called from a session name alone: `--session`
   * wants the engine's transcript id, which no helper listing returns. See
   * agents/transcripts.ts for why the id is recovered from the on-disk layout.
   *
   * Two round-trips in the happy path (probe, then `agent-log`) and never
   * more. Every failure comes back as `ok: false` with a sentence fit to show
   * the user — a caller must never be able to render an empty pane because
   * this returned "nothing" without saying why.
   */
  async sessionConversation(
    connectionId: string,
    opts: { session: string; engine: TranscriptEngine | null; cwd: string | null },
  ): Promise<SessionConversation> {
    const fail = (error: string): SessionConversation => ({
      ok: false,
      engine: null,
      transcriptId: null,
      path: null,
      lines: [],
      cwdVerified: false,
      error,
    });

    // The probe's exit code is deliberately ignored: `ls` reports non-zero
    // whenever ANY of its fixed globs matched nothing, which is the normal
    // state of a host that has only one of the three engines installed.
    const probe = await this.ssh.exec(connectionId, pathAwareCommand(TRANSCRIPT_PROBE_COMMAND));
    const candidates = parseTranscriptProbe(probe.stdout, opts.cwd);
    const pick = pickTranscript(candidates, opts.engine, opts.cwd);
    if (!pick) {
      return fail(describeUnresolved(opts.session, opts.engine, opts.cwd, candidates.length));
    }

    const envelope = await this.agentLog(
      connectionId,
      pick.engine,
      pick.id,
      opts.cwd ?? undefined,
    );
    if (envelope && envelope.lines.length) {
      return {
        ok: true,
        engine: pick.engine,
        transcriptId: pick.id,
        path: envelope.path || pick.path,
        lines: envelope.lines,
        cwdVerified: pick.cwdVerified,
        error: null,
      };
    }

    // `agent-log` came back empty for a file we can see. Rather than report
    // "no conversation" for a transcript that demonstrably exists, read it
    // directly — the helper's search roots are its own business and have
    // drifted from the documented contract before (see the 0.4.8 -> 0.4.44
    // notes in docs/ANALYSIS.md). Only if BOTH routes come up empty is there
    // genuinely nothing to show.
    const tail = await this.ssh.exec(
      connectionId,
      pathAwareCommand(`tail -n 4000 ${shellQuote(pick.path)}`),
    );
    const lines = tail.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'));
    if (lines.length) {
      return {
        ok: true,
        engine: pick.engine,
        transcriptId: pick.id,
        path: pick.path,
        lines,
        cwdVerified: pick.cwdVerified,
        error: null,
      };
    }
    return fail(
      `Found this session's ${pick.engine} transcript (${pick.path}) but could not read any ` +
        `conversation out of it: \`pocketshell agent-log --engine ${pick.engine} --session ` +
        `${pick.id}\` returned nothing and the file has no JSON lines.`,
    );
  }

  /**
   * Agent config-dir profiles (`pocketshell profiles list --json`).
   *
   * 0.4.44 emits a `{"profiles": [...]}` ENVELOPE, not the bare array the
   * v0.4.8 contract documented — so the old `Array.isArray` guard silently
   * returned `[]` for every profile on a current host. Both shapes are
   * accepted so the call keeps working on either helper version.
   */
  async listProfiles(connectionId: string): Promise<unknown[]> {
    const res = await this.ssh.exec(connectionId, pathAwareCommand('pocketshell profiles list --json'));
    if (res.exitCode !== 0) return [];
    try {
      const parsed: unknown = JSON.parse(res.stdout.trim());
      // Array.isArray narrows `unknown` to `any[]`, so each branch is cast
      // back to `unknown[]` rather than leaking `any` to the caller.
      if (Array.isArray(parsed)) return parsed as unknown[];
      const envelope = (parsed as { profiles?: unknown } | null)?.profiles;
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
