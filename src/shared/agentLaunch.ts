/**
 * The `pocketshell agent …` launch line, built from the helper's REAL option
 * list rather than a remembered one.
 *
 * ## What the helper actually accepts
 *
 * Captured from the pinned 0.4.44 fixture image, not from docs — the
 * `--help` output is committed verbatim at
 * `tests/unit/fixtures/v0.4.44-agent-help.txt` and
 * `…-agent-claude-help.txt`, and `tests/unit/agentLaunch.test.ts` asserts
 * this module against those files so a helper bump that moves a flag fails a
 * test instead of a user's terminal:
 *
 *     Usage: pocketshell agent claude [OPTIONS]
 *
 *     Options:
 *       --dir TEXT                      Folder to launch the agent in (its cwd).
 *                                       [required]
 *       --skip-permissions / --no-skip-permissions
 *                                       … [default: skip-permissions]
 *       --config-dir TEXT               … Mutually exclusive with --profile.
 *       --profile TEXT                  Named host profile … Mutually
 *                                       exclusive with --config-dir.
 *
 * Three facts drive every branch below.
 *
 * 1. **`--dir` is REQUIRED.** The desktop used to type a bare
 *    `pocketshell agent claude`, which exits 2 with `Error: Missing option
 *    '--dir'.` — so the session was created, the agent never started, and the
 *    user was left in a plain shell staring at a usage message. That is the
 *    bug this module exists to make unrepeatable.
 * 2. **Skip-permissions defaults to ON host-side.** So the affirmative
 *    `--skip-permissions` is never worth emitting; the only flag that carries
 *    information is the negative `--no-skip-permissions`. This matches the
 *    phone (`SessionTypePickerSheet.kt::buildAgentCommand`), and it means a
 *    host that later changes its default changes ours with it.
 * 3. **`--profile` and `--config-dir` are mutually exclusive** (exit 2). We
 *    only ever emit `--profile`, so the pair can never both appear.
 *
 * ## What the helper does NOT have
 *
 * `pocketshell agent` on 0.4.44 has exactly three subcommands — `claude`,
 * `codex`, `opencode`. There is **no `grok`**: `pocketshell agent grok` exits
 * 2 with `Error: No such command 'grok'.` (captured at
 * `v0.4.44-agent-no-such-command.stderr.txt`). {@link SessionAgentKind} still
 * carries `grok` because a session can BE a grok session — the phone launches
 * one through its own engine registry and the tmux option comes back
 * `grok` — but this desktop cannot start one through the wrapper, so
 * {@link LAUNCHABLE_KINDS} is deliberately narrower than the badge enum. The
 * `+` menu used to offer Grok and would have failed exactly like the missing
 * `--dir` did.
 */
import { shellQuote, shellQuoteRemotePath } from './shellQuote.js';
import type { SessionAgentKind } from './types.js';

/**
 * The agent kinds `pocketshell agent` can actually launch, in the order the
 * picker offers them (the phone's order: claude first, then codex, opencode).
 */
export const LAUNCHABLE_KINDS = ['claude', 'codex', 'opencode'] as const;

export type LaunchableKind = (typeof LAUNCHABLE_KINDS)[number];

/** Display names for the picker. Title-case; the phone uses lowercase CLI names. */
export const KIND_LABELS: Record<LaunchableKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Narrow a badge-level {@link SessionAgentKind} to something we can launch. */
export function isLaunchableKind(kind: SessionAgentKind | null): kind is LaunchableKind {
  return kind !== null && (LAUNCHABLE_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether the kind's per-action approval prompts can be turned off.
 *
 * The helper's own help says the flag is a "No-op for opencode", so offering
 * the toggle there would be a control that does nothing. The phone hides the
 * row outright for opencode and never emits the flag; we do the same.
 */
export function supportsSkipPermissions(kind: LaunchableKind): boolean {
  return kind !== 'opencode';
}

/**
 * Whether a profile can be chosen for the kind.
 *
 * `pocketshell profiles list --engine` accepts only `claude|codex`, and
 * `agent --profile` is documented "Ignored for opencode" — opencode has no
 * config-dir env var at all (helper `profiles.py`: "opencode has no profile
 * env var, so it is out of scope").
 */
export function supportsProfiles(kind: LaunchableKind): boolean {
  return kind !== 'opencode';
}

/** One row of `pocketshell profiles list --json`'s `{"profiles": [...]}`. */
export interface AgentProfile {
  name: string;
  engine: string;
  /** `null` for the engine's built-in default location. */
  configDir: string | null;
  /** The engine's default profile; the picker pre-selects it. */
  default: boolean;
}

/**
 * Parse the `{"profiles": [...]}` envelope 0.4.44 emits.
 *
 * The rows arrive over IPC as `unknown[]` ({@link
 * PocketshellClient.listProfiles} unwraps the envelope but does not type the
 * rows), so this is where they become data. A row with no usable `name` or
 * `engine` is DROPPED rather than defaulted: a nameless profile cannot be
 * passed to `--profile`, and inventing a name for it would produce a launch
 * line the host rejects with `unknown claude profile`.
 */
export function parseProfileRows(rows: readonly unknown[]): AgentProfile[] {
  const out: AgentProfile[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const name = typeof r['name'] === 'string' ? r['name'].trim() : '';
    const engine = typeof r['engine'] === 'string' ? r['engine'].trim() : '';
    if (name === '' || engine === '') continue;
    const rawDir = r['config_dir'];
    out.push({
      name,
      engine,
      configDir: typeof rawDir === 'string' && rawDir.trim() !== '' ? rawDir.trim() : null,
      default: r['default'] === true,
    });
  }
  return out;
}

/** The profiles that apply to one kind, host order preserved (default first). */
export function profilesFor(
  kind: LaunchableKind,
  profiles: readonly AgentProfile[],
): AgentProfile[] {
  if (!supportsProfiles(kind)) return [];
  return profiles.filter((p) => p.engine === kind);
}

/**
 * The name to put in `--profile` for a picked profile, or null for none.
 *
 * Null for the engine's DEFAULT profile, matching the phone
 * (`launchCommand`'s `.takeUnless { it.default }`): the default is what the
 * agent uses when `--profile` is absent, so naming it adds a flag that can
 * fail — `unknown claude profile` if the host renames it — in exchange for no
 * change in behaviour. Null too for a remembered name the host no longer
 * lists, which is how a profile deleted on the host stops haunting the
 * dialog.
 */
export function profileFlagName(
  picked: string | null,
  available: readonly AgentProfile[],
): string | null {
  if (!picked) return null;
  const match = available.find((p) => p.name === picked);
  if (!match || match.default) return null;
  return match.name;
}

/** Everything the picker collects. */
export interface LaunchChoice {
  kind: LaunchableKind;
  /** Folder the agent starts in. May be a literal `~/…`. */
  dir: string;
  /** Per-action approval prompts disabled. Host default is `true`. */
  skipPermissions: boolean;
  /** Profile NAME as the host reports it, or null for the engine default. */
  profile: string | null;
}

/**
 * The literal line typed into the session's PTY (no trailing `\r`).
 *
 * Quoting, which is the whole reason this is not a template string at the
 * call site:
 *
 * - **`--dir` uses {@link shellQuoteRemotePath}**, not a plain quote. This is
 *   the one deliberate divergence from the phone, which single-quotes the
 *   directory flat. A desktop folder key can be a literal, unexpanded `~/git/x`
 *   — tmux reports cwds that way and `stripTilde` in stores/files.ts exists
 *   because of it — and `'~/git/x'` inside single quotes is four literal
 *   characters the shell will not expand, so the helper would look for a
 *   directory named `~`. `shellQuoteRemotePath` emits `$HOME/'git/x'`: the
 *   prefix expands, the rest is inert data, and a folder called
 *   `wei'rd $(touch /tmp/PWNED)` still travels as text.
 * - **`--profile` uses a plain {@link shellQuote}.** A profile name is data,
 *   never a path — the host's own discovery produces names like
 *   `Claude (Z.AI)`, with a space and parentheses, which unquoted would split
 *   into three words and fail as `unknown claude profile: 'Claude'`.
 *
 * Flags are emitted only when they carry information (see the header): the
 * host defaults skip-permissions ON, so only the negative is spoken, and
 * never for opencode where it is a no-op.
 *
 * The engine's DEFAULT profile is passed as `profile: null` by the caller,
 * not stripped here — see {@link profileFlagName}. Naming it and omitting it
 * are the same launch, and this function stays a dumb renderer of the choice
 * it is handed so that what you read here is what the host receives.
 */
export function buildLaunchCommand(choice: LaunchChoice): string {
  const parts = ['pocketshell', 'agent', choice.kind, '--dir', shellQuoteRemotePath(choice.dir)];
  if (supportsSkipPermissions(choice.kind) && !choice.skipPermissions) {
    parts.push('--no-skip-permissions');
  }
  const profile = choice.profile?.trim();
  if (supportsProfiles(choice.kind) && profile) {
    parts.push('--profile', shellQuote(profile));
  }
  return parts.join(' ');
}

/**
 * Why {@link buildLaunchCommand} would produce a line the host rejects, or
 * null when it would not.
 *
 * Called BEFORE the session is created, which is the point: the old flow
 * created a session and only then discovered the command was malformed,
 * leaving a shell plus a usage message in the terminal. A launch that cannot
 * work should cost the user nothing.
 */
export function launchBlocker(choice: Partial<LaunchChoice>): string | null {
  if (!choice.kind || !isLaunchableKind(choice.kind)) {
    return 'Pick an agent to launch.';
  }
  // `--dir` is required and the helper resolves it host-side; a blank one
  // would make `shellQuoteRemotePath` fall back to `$HOME`, silently starting
  // the agent in the home directory instead of the folder the user is in.
  if (!choice.dir || choice.dir.trim() === '') {
    return 'This folder has no known directory on the host, so an agent cannot be launched in it.';
  }
  return null;
}
