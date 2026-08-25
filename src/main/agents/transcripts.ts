/**
 * Resolving "which conversation belongs to THIS tmux session".
 *
 * ## Why this file has to exist
 *
 * `pocketshell agent-log` is addressed as `--engine E --session S`, and `S` is
 * **not** the tmux session name: it is the engine's own transcript id, i.e.
 * the stem of the JSONL file on disk (`demo-claude` for
 * `~/.claude/projects/-workspace-demo/demo-claude.jsonl`, a uuid on a real
 * host). Nothing the helper *lists* hands that id back either — `sessions
 * list` is IDX/SESSION/CREATED and `sessions resumable` is
 * ENGINE/PROJECT/WHEN/LABEL. So a UI that only knows "the user is looking at
 * tmux session `main`" cannot call `agent-log` at all, which is exactly why
 * the Conversation tab used to make the user type an id or pick a resumable
 * chip.
 *
 * The one thing we *do* know about a session is its cwd and its recorded
 * `@ps_agent_kind` (both already carried on {@link SessionSummary}), so the id
 * is recovered by looking at the engines' on-disk layouts directly:
 *
 *   - claude:   `~/.claude/projects/<cwd with the separators turned into '-'>/<id>.jsonl`
 *   - codex:    `~/.codex/sessions/<YYYY>/<MM>/<DD>/<id>.jsonl`
 *   - opencode: `~/.local/share/opencode/<id>.jsonl`
 *
 * This is the ONE place in the app that depends on those layouts rather than
 * on the helper's command contract, and it is deliberately confined to a
 * single probe command plus the pure functions below — reading the transcript
 * still goes through `agent-log`, so per-engine decoding stays the helper's
 * job.
 *
 * ## Only claude's path proves a cwd
 *
 * Claude encodes the project directory in the path; codex and opencode do not
 * (their cwd lives *inside* the file). That asymmetry is load-bearing for
 * {@link pickTranscript}: for claude we can require proof and refuse to guess,
 * for the other two the best we can honestly do is "the newest transcript of
 * the engine this session is actually running", which the UI then labels as
 * unverified rather than presenting as certain.
 */

import type { SessionAgentKind } from '../../shared/types.js';

/** The three engines `pocketshell agent-log --engine` accepts. */
export type TranscriptEngine = 'claude' | 'codex' | 'opencode';

/** One transcript file found on the host. */
export interface TranscriptCandidate {
  engine: TranscriptEngine;
  /** Absolute path on the host. */
  path: string;
  /** The id `agent-log --session` takes: the file stem. */
  id: string;
  /**
   * True only when the PATH ITSELF proves this transcript belongs to the
   * session's cwd. Never true for codex/opencode — see the file header.
   */
  cwdVerified: boolean;
}

/**
 * Where each engine keeps its JSONL, as the path fragment that identifies it.
 * Matched against the absolute path the probe prints, so a user whose $HOME is
 * somewhere unusual still classifies correctly.
 */
const ENGINE_ROOTS: ReadonlyArray<readonly [TranscriptEngine, string]> = [
  ['claude', '/.claude/projects/'],
  ['codex', '/.codex/sessions/'],
  ['opencode', '/.local/share/opencode/'],
];

/** Engines whose transcript path encodes the conversation's cwd. */
const ENGINE_ENCODES_CWD: Record<TranscriptEngine, boolean> = {
  claude: true,
  codex: false,
  opencode: false,
};

/**
 * The single probe: every candidate transcript on the host, newest first.
 *
 * `ls -1t` rather than `find -printf`: this runs on whatever the host has, and
 * the Alpine test image's busybox `find` has no `-printf` at all. `ls` sorts
 * ALL of its file arguments together by mtime, so one invocation gives a
 * globally ordered list across the three engines instead of three ordered
 * lists we would have to merge without mtimes.
 *
 * A glob that matches nothing is passed through literally and makes `ls`
 * complain on stderr about that one argument while still listing the others —
 * hence `2>/dev/null` and the deliberate non-check of the exit code, which is
 * non-zero whenever ANY engine is not installed (the common case).
 *
 * No user data is interpolated: every argument is a fixed glob, so there is
 * nothing here to quote or inject through.
 */
export const TRANSCRIPT_PROBE_COMMAND =
  'ls -1t ' +
  '"$HOME"/.claude/projects/*/*.jsonl ' +
  '"$HOME"/.codex/sessions/*.jsonl ' +
  '"$HOME"/.codex/sessions/*/*/*/*.jsonl ' +
  '"$HOME"/.local/share/opencode/*.jsonl ' +
  '"$HOME"/.local/share/opencode/*/*.jsonl ' +
  '2>/dev/null | head -n 500';

/**
 * Narrow a recorded `@ps_agent_kind` to an engine `agent-log` can read.
 *
 * `shell`, `grok`, the transient detector states and an absent option all
 * become null — "we do not know", which {@link pickTranscript} treats as
 * "only accept a transcript whose path proves the cwd". A session we did not
 * launch can still be running claude, so an unknown kind must not mean "no
 * conversation exists"; it means "do not take our word for which one".
 */
export function transcriptEngineFromAgentKind(
  kind: SessionAgentKind | null | undefined,
): TranscriptEngine | null {
  switch (kind) {
    case 'claude':
    case 'codex':
    case 'opencode':
      return kind;
    default:
      return null;
  }
}

/**
 * Collapse a path (or an already-encoded claude project directory) to a
 * comparable key: every run of non-alphanumerics becomes one `-`.
 *
 * Claude's own encoding is documented as `/` -> `-`, but it also flattens the
 * dots and underscores a real directory name can contain, and we would rather
 * compare something both sides normalise the same way than reimplement its
 * exact table and be wrong about one character.
 */
function projectKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Does `dirName` (a claude project directory) encode `cwd`?
 *
 * An ABSOLUTE cwd must match exactly. A cwd that is still tilde-relative is
 * matched as a suffix instead, because tmux really does report an unexpanded
 * `~/git` as `session_path` (see parsers.ts) and we cannot expand it here —
 * suffix matching is the price of that, and it is only allowed in the case
 * where an exact comparison is impossible, so an absolute `/srv/git/foo` can
 * never be mistaken for `/home/me/git/foo`.
 */
export function cwdMatchesProjectDir(dirName: string, cwd: string): boolean {
  const cwdKey = projectKey(cwd.replace(/^~/, ''));
  if (!cwdKey) return false;
  const dirKey = projectKey(dirName);
  if (dirKey === cwdKey) return true;
  const relative = cwd.startsWith('~') || !cwd.startsWith('/');
  return relative && dirKey.endsWith(`-${cwdKey}`);
}

/** Classify an absolute transcript path by the engine root it sits under. */
function engineForPath(path: string): TranscriptEngine | null {
  for (const [engine, root] of ENGINE_ROOTS) {
    if (path.includes(root)) return engine;
  }
  return null;
}

/**
 * Parse {@link TRANSCRIPT_PROBE_COMMAND} output, preserving its newest-first
 * order. Anything that is not a recognisable transcript path is skipped, so
 * a stray shell warning on stdout costs nothing.
 */
export function parseTranscriptProbe(stdout: string, cwd: string | null): TranscriptCandidate[] {
  const out: TranscriptCandidate[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const path = rawLine.trim();
    if (!path.endsWith('.jsonl')) continue;
    const engine = engineForPath(path);
    if (!engine) continue;
    const segments = path.split('/');
    const file = segments[segments.length - 1] ?? '';
    const id = file.slice(0, -'.jsonl'.length);
    if (!id) continue;
    const parent = segments[segments.length - 2] ?? '';
    out.push({
      engine,
      path,
      id,
      cwdVerified: ENGINE_ENCODES_CWD[engine] && !!cwd && cwdMatchesProjectDir(parent, cwd),
    });
  }
  return out;
}

/**
 * Choose the transcript to show for a session, or null to say so out loud.
 *
 * The ladder, in order of how much we actually know:
 *
 *   1. A candidate whose path proves the session's cwd — always the answer.
 *   2. No proof and no recorded engine: REFUSE. Showing "the newest
 *      conversation on the host" for a session we cannot tie to it is worse
 *      than an error message, because it looks like it worked.
 *   3. No proof, but the engine is recorded and its layout could never have
 *      carried the cwd (codex/opencode): the newest transcript of that engine,
 *      flagged `cwdVerified: false` so the UI can say which one it picked.
 *   4. Recorded engine is claude and nothing matched the cwd: REFUSE — claude
 *      *does* encode the cwd, so "no match" means this session has no claude
 *      conversation, not that we should show another project's.
 */
export function pickTranscript(
  candidates: TranscriptCandidate[],
  engine: TranscriptEngine | null,
  cwd: string | null,
): TranscriptCandidate | null {
  const pool = engine ? candidates.filter((c) => c.engine === engine) : candidates;
  const verified = pool.find((c) => c.cwdVerified);
  if (verified) return verified;
  if (!engine) return null;
  if (cwd && ENGINE_ENCODES_CWD[engine]) return null;
  return pool[0] ?? null;
}

/**
 * The message shown when {@link pickTranscript} refuses. It names the session,
 * the engine and the cwd we searched for, because "no conversation" with no
 * further detail is indistinguishable from a bug.
 */
export function describeUnresolved(
  session: string,
  engine: TranscriptEngine | null,
  cwd: string | null,
  candidateCount: number,
): string {
  const where = cwd ? ` in ${cwd}` : ' (this session reports no working directory)';
  if (engine) {
    return (
      `No ${engine} conversation found for session "${session}"${where}. ` +
      `Searched ${candidateCount} transcript(s) under the agent log directories.`
    );
  }
  return (
    `Could not tell which conversation belongs to session "${session}"${where}: ` +
    'tmux records no agent kind for it (@ps_agent_kind), and no transcript path ' +
    'matches its working directory. Start the agent through pocketshell so the ' +
    'session is tagged, or open the session it was started from.'
  );
}
