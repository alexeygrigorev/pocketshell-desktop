/**
 * Project-folder-first session creation — the desktop half of the flow the
 * Android app already ships.
 *
 * A session is not named, it is *placed*. The user picks a project folder on
 * the remote host by one of three routes — an existing folder, a new empty
 * folder, or a fresh GitHub clone — and the session name is DERIVED from that
 * folder (see ./sessionName.ts). That derivation is the same one `tmuxctl` and
 * the phone use, so `~/git/pocketshell` is `git-pocketshell` everywhere and
 * the three clients agree about which session belongs to which folder.
 *
 * ## Browsing folders is NOT here
 *
 * The renderer picks the existing folder with the SFTP surface that already
 * exists: `sftp:list` for the entries (filter `type === 'dir'`), `sftp:stat`,
 * `sftp:realPath`. Re-exposing a "list remote folders" channel here would be a
 * second, thinner path to the same ssh2 SFTP wrapper — one more thing to keep
 * in sync for no capability gained. The only thing this service adds for
 * browsing is {@link home}, because `$HOME` is where a picker starts and it is
 * also an input to the name derivation.
 */

import type { SshService } from '../ssh/SshService.js';
import type { PocketshellClient } from '../helper/PocketshellClient.js';
import type { CreateSessionVia } from '../helper/PocketshellClient.js';
import { pathAwareCommand } from '../helper/bootstrap.js';
import {
  HOME_COMMAND,
  directoryExistsCommand,
  freeSessionNameCommand,
  killSessionCommand,
  mkdirCommand,
  renameSessionCommand,
  resolveDirectoryCommand,
  sessionExistsCommand,
  type ReposCloneOptions,
  type ReposListOptions,
} from './commands.js';
import {
  childPath,
  normaliseProjectFolderName,
  resolveSessionName,
  sanitiseName,
} from './sessionName.js';
import {
  mergeRepos,
  type ReposListResult,
  type ReposScopeResult,
  type ReposScopeState,
} from './repos.js';

/** Resolved remote home. */
export interface HomeResult {
  ok: boolean;
  home: string | null;
  error: string | null;
}

/** Result of creating a new empty project folder. */
export interface CreateFolderResult {
  ok: boolean;
  /** Canonical absolute path of the created folder. */
  path: string | null;
  error: string | null;
}

/** Result of a clone request. */
export interface CloneResult {
  ok: boolean;
  path: string | null;
  /** True when the clone target was already on disk and we reused it. */
  alreadyExists: boolean;
  error: string | null;
  /**
   * On failure, WHY — so the UI can say "this host has no pocketshell" rather
   * than dumping a git error. Absent on success.
   */
  state?: Exclude<ReposScopeState, 'ok'>;
}

/** Progress event pushed while a clone runs. */
export interface CloneProgress {
  requestId: string;
  phase: 'started' | 'finished';
  repository: string;
  path?: string;
  error?: string;
}

/**
 * What `sessionName` means for a start request.
 *
 *  - `reuse` (default): the derived name is the EXACT name to use. If a
 *    session for this folder is already open, re-open it. This is the
 *    idempotent attach-or-create semantics `create-detached` provides and the
 *    folder-first flow depends on.
 *  - `unique`: give me a genuinely NEW session for this folder, walking
 *    `<base>`, `<base>-2`, `<base>-3`… The walk runs on the host, in one exec,
 *    immediately before the create (see {@link freeSessionNameCommand}) — the
 *    phone learned the hard way that a client-side session cache answers this
 *    question wrongly.
 */
export type SessionNamePolicy = 'reuse' | 'unique';

/** Request for {@link ProjectsService.startSession}. */
export interface StartSessionRequest {
  /** Remote folder to start in. Absolute, or `~`-relative. */
  folder: string;
  /** Optional user label; blank/punctuation-only falls back to the derived name. */
  customName?: string;
  /** Defaults to `reuse`. */
  namePolicy?: SessionNamePolicy;
}

/**
 * Why a start request failed, for a UI that wants to react rather than print.
 *
 * `name-unavailable` belongs only to the `unique` policy and only to the two
 * ways that policy can be defeated without anything having gone wrong on the
 * host: the free-name probe could not be read at all, or the create came back
 * under a different name than the one it was asked for. Both used to resolve
 * `ok: true` carrying the name of a session that was ALREADY OPEN — see
 * {@link ProjectsService.startSession} for why that is the worst answer this
 * call can give.
 */
export type StartSessionFailure = 'folder-missing' | 'create-failed' | 'name-unavailable';

/** Result of {@link ProjectsService.startSession}. Never thrown. */
export interface StartSessionResult {
  ok: boolean;
  /** The session name on the host — what to attach to. */
  sessionName: string | null;
  /** The canonical folder the session was started in. */
  folder: string | null;
  /** True when a session for this folder was already open and got reused. */
  reused: boolean;
  /** Which create path ran; `tmux-fallback` means no memory cap. */
  via: CreateSessionVia | null;
  error: string | null;
  code: StartSessionFailure | null;
}

/** Why a rename was refused, for a UI that wants to react rather than print. */
export type RenameSessionFailure = 'illegal-name' | 'name-taken' | 'rename-failed';

/** Result of {@link ProjectsService.renameSession}. Never thrown. */
export interface RenameSessionResult {
  ok: boolean;
  /** The name the session now has on the host. */
  sessionName: string | null;
  error: string | null;
  code: RenameSessionFailure | null;
}

/** Why a kill was refused. `not-found` is the one a stale tab bar produces. */
export type KillSessionFailure = 'not-found' | 'kill-failed';

/** Result of {@link ProjectsService.killSession}. Never thrown. */
export interface KillSessionResult {
  ok: boolean;
  error: string | null;
  code: KillSessionFailure | null;
}

/** Request for {@link ProjectsService.createFolder}. */
export interface CreateFolderRequest {
  /** Existing parent directory. */
  parent: string;
  /** Single folder name to create under it. */
  name: string;
}

/** Request for {@link ProjectsService.reposList}. */
export interface ReposListRequest {
  /** Which scopes to run. Defaults to `both`. */
  scope?: 'local' | 'remote' | 'both';
  /** Local scan roots (replaces the helper default `~/git`). */
  roots?: string[];
  /** Local scan depth. */
  maxDepth?: number;
  /** Cap on remote rows. */
  limit?: number;
}

export class ProjectsService {
  /**
   * Remote `$HOME` per connection. It cannot change for the life of a
   * connection, and it is read on every name derivation, so caching it keeps
   * the picker from spending a round-trip per keystroke.
   */
  private readonly homes = new Map<string, string>();

  constructor(
    private readonly ssh: SshService,
    private readonly helper: PocketshellClient,
  ) {}

  /** Drop cached per-connection state. Call on disconnect. */
  evict(connectionId: string): void {
    this.homes.delete(connectionId);
  }

  /** Resolve (and cache) the remote `$HOME`. */
  async home(connectionId: string): Promise<HomeResult> {
    const cached = this.homes.get(connectionId);
    if (cached != null) return { ok: true, home: cached, error: null };
    const res = await this.ssh.exec(connectionId, pathAwareCommand(HOME_COMMAND));
    const home = res.stdout.trim();
    if (res.exitCode !== 0 || home.length === 0) {
      return {
        ok: false,
        home: null,
        error: res.stderr.trim() || 'could not resolve $HOME on the host',
      };
    }
    this.homes.set(connectionId, home);
    return { ok: true, home, error: null };
  }

  /**
   * The session name a folder WOULD get, for previewing in the picker.
   *
   * This is the derived base name only — it does not consult the host, so it
   * carries no `-2` suffix even under a `unique` policy. Resolving that
   * suffix requires the host and belongs at create time.
   */
  async deriveSessionName(
    connectionId: string,
    folder: string,
    customName?: string,
  ): Promise<string> {
    const { home } = await this.home(connectionId);
    return resolveSessionName(customName ?? null, folder, home);
  }

  /**
   * Create a new empty project folder under [parent] and return its canonical
   * path. Does not start a session — the renderer chains
   * {@link startSession} on the returned path.
   */
  async createFolder(
    connectionId: string,
    request: CreateFolderRequest,
  ): Promise<CreateFolderResult> {
    const safeName = normaliseProjectFolderName(request.name);
    if (safeName === null) {
      return { ok: false, path: null, error: 'Enter a single folder name (no "/" or "..").' };
    }
    const target = childPath(request.parent, safeName);
    const made = await this.ssh.exec(connectionId, pathAwareCommand(mkdirCommand(target)));
    if (made.exitCode !== 0) {
      return {
        ok: false,
        path: null,
        error: made.stderr.trim() || made.stdout.trim() || `mkdir exited ${made.exitCode}`,
      };
    }
    return { ok: true, path: await this.canonicalise(connectionId, target), error: null };
  }

  /**
   * Run `repos list` for the requested scopes and merge them.
   *
   * The two scopes are independent execs on one connection, so they are issued
   * together: the local scan touches the filesystem and the remote one calls
   * the GitHub API, and serialising them would add the slower of the two to
   * every picker open for nothing.
   *
   * A missing or unauthenticated `gh` leaves `remote.state` set to
   * `gh-missing` / `gh-unauthenticated` with no rows, and `ok` stays true for
   * the local scope — the picker still lists local clones. Only a genuine
   * failure of a requested scope clears `ok`.
   */
  async reposList(connectionId: string, request: ReposListRequest = {}): Promise<ReposListResult> {
    const scope = request.scope ?? 'both';
    const wantLocal = scope === 'local' || scope === 'both';
    const wantRemote = scope === 'remote' || scope === 'both';

    const localOptions: ReposListOptions = {
      scope: 'local',
      roots: request.roots,
      maxDepth: request.maxDepth,
    };
    const remoteOptions: ReposListOptions = { scope: 'remote', limit: request.limit };

    const [local, remote] = await Promise.all([
      wantLocal ? this.helper.reposList(connectionId, localOptions) : Promise.resolve(null),
      wantRemote ? this.helper.reposList(connectionId, remoteOptions) : Promise.resolve(null),
    ]);

    return {
      ok: scopeOk(local) && scopeOk(remote),
      repos: mergeRepos(local?.repos ?? [], remote?.repos ?? []),
      local,
      remote,
    };
  }

  /**
   * Clone a GitHub repo and return the created path.
   *
   * A clone is the one slow step in this flow — tens of seconds for a large
   * repo — so it emits lifecycle events through [onProgress] the way SFTP
   * transfers do: `started` as soon as the exec is issued, `finished` when it
   * lands. The renderer keys them by its own `requestId`, exactly as it keys
   * `sftp:event:progress` by `transferId`.
   *
   * They are lifecycle events, not byte counts, and deliberately so: `git`
   * writes its progress meter to stderr, and `SshService.exec` buffers a
   * channel to completion. Streaming real percentages would mean a new
   * raw-channel exec API on SshService for one call site. What the renderer
   * needs from this is "it started, it is still going, it finished" — which
   * these give — rather than a progress bar the helper cannot feed anyway.
   */
  async cloneRepo(
    connectionId: string,
    request: ReposCloneOptions & { requestId?: string },
    onProgress?: (progress: CloneProgress) => void,
  ): Promise<CloneResult> {
    const requestId = request.requestId ?? '';
    const repository = request.repository;
    onProgress?.({ requestId, phase: 'started', repository });
    const outcome = await this.helper.reposClone(connectionId, {
      repository,
      root: request.root,
      folder: request.folder,
      protocol: request.protocol,
    });
    const result: CloneResult = {
      ok: outcome.ok,
      path: outcome.path,
      alreadyExists: outcome.alreadyExists,
      error: outcome.error,
      ...(outcome.state ? { state: outcome.state } : {}),
    };
    onProgress?.({
      requestId,
      phase: 'finished',
      repository,
      ...(result.path ? { path: result.path } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    return result;
  }

  /**
   * Start a session in [folder] — the single entry point all three routes
   * converge on.
   *
   * Sequence:
   *  1. resolve `$HOME` (cached) and canonicalise the folder;
   *  2. confirm the folder EXISTS — the helper does not (a `-c` pointing at a
   *     missing directory still exits 0 and lands the pane in `$HOME`);
   *  3. derive the name from the folder;
   *  4. ask the host whether that session is already open, and — under the
   *     `unique` policy — for the first free `-N` variant;
   *  5. create, idempotently.
   *
   * ## Why the `unique` policy fails CLOSED and `reuse` does not
   *
   * The create underneath both policies is attach-or-create: `pocketshell
   * sessions create` is a no-op success when the name is already running, which
   * is exactly what `reuse` wants and exactly what makes `unique` dangerous when
   * anything upstream of it is uncertain. If the free-name walk cannot be read,
   * or if the helper answers with a name other than the one we asked for, the
   * name we hand back may be a session that is ALREADY OPEN in the caller's UI —
   * and the caller has no way to tell, because `ok` is true and `reused` is
   * false.
   *
   * That is not a hypothetical. It is the `+` -> New session bug: the walk asked
   * a bare `tmux has-session`, which on this host denies sessions the helper
   * lists (see {@link freeSessionNameCommand}), so `unique` answered with the
   * folder's existing session. The workspace then re-selected the tab that was
   * already selected — "nothing happened" — and, when an agent had been chosen,
   * typed its launch line into the terminal the user was already working in.
   *
   * So a `unique` request that cannot be SHOWN to have produced a new name is
   * refused with `name-unavailable` and nothing is created. The same failure
   * under `reuse` is harmless and stays harmless: re-opening a session that is
   * already open is what `reuse` means.
   */
  async startSession(
    connectionId: string,
    request: StartSessionRequest,
  ): Promise<StartSessionResult> {
    const { home } = await this.home(connectionId);
    const folder = request.folder.trim();

    const exists = await this.ssh.exec(
      connectionId,
      pathAwareCommand(directoryExistsCommand(folder)),
    );
    if (exists.exitCode !== 0) {
      return {
        ok: false,
        sessionName: null,
        folder: null,
        reused: false,
        via: null,
        error: `Start folder does not exist on the host: ${folder}`,
        code: 'folder-missing',
      };
    }
    // Canonicalise AFTER the existence check so `~` and symlinked paths derive
    // the same name as the folder the user browsed to.
    const canonical = await this.canonicalise(connectionId, folder);
    const base = resolveSessionName(request.customName ?? null, canonical, home);

    const policy = request.namePolicy ?? 'reuse';
    let name = base;
    let reused = false;
    if (policy === 'unique') {
      const free = await this.freeSessionName(connectionId, base);
      if (free === null) {
        return {
          ok: false,
          sessionName: null,
          folder: canonical,
          reused: false,
          via: null,
          error:
            `Could not ask the host for a free session name, so nothing was created. ` +
            `Starting another session here would have re-opened "${base}" instead of ` +
            `making a new one.`,
          code: 'name-unavailable',
        };
      }
      name = free;
    } else {
      const has = await this.ssh.exec(
        connectionId,
        pathAwareCommand(sessionExistsCommand(base)),
      );
      reused = has.exitCode === 0;
    }

    const created = await this.helper.createSession(connectionId, { name, cwd: canonical });
    if (!created.ok) {
      return {
        ok: false,
        sessionName: null,
        folder: canonical,
        reused: false,
        via: created.via,
        error: created.error,
        code: 'create-failed',
      };
    }
    // The helper echoes the resolved name and we normally trust it over ours
    // (../helper/PocketshellClient.ts). Under `unique` that trust has to be
    // checked rather than extended: the whole request was "a name nothing else
    // is using", and a name we did not ask for is a name nothing walked the
    // suffix chain for. It is also the shape a chatty login shell produces — the
    // echo is read as the first non-empty line of stdout, so a `.profile` that
    // greets would put its greeting here — and answering with that would be
    // worse than answering with nothing.
    if (policy === 'unique' && created.name !== name) {
      return {
        ok: false,
        sessionName: null,
        folder: canonical,
        reused: false,
        via: created.via,
        error:
          `Asked the host for a new session called "${name}" and it answered with ` +
          `"${created.name ?? ''}", so it is not clear a new session was made. Nothing ` +
          `here has been selected; check the host before trying again.`,
        code: 'name-unavailable',
      };
    }
    return {
      ok: true,
      sessionName: created.name,
      folder: canonical,
      reused,
      via: created.via,
      error: null,
      code: null,
    };
  }

  /**
   * Rename a live tmux session (docs/WORKSPACE.md §4).
   *
   * ## Why this is a service call and not a `send-keys`
   *
   * The session name is the JOIN KEY. `sessionAttachCommand` builds
   * `tmuxctl '<name>'` and there is deliberately no fallback ladder behind it,
   * so a rename that produces a name `tmuxctl` cannot resolve makes the session
   * unreachable from this app — a trap, not a bug, because the session is still
   * alive on the host and the list still shows it. Two guards make that
   * impossible, and both of them have to run somewhere the UI cannot skip:
   *
   *  1. **The alphabet.** `sanitiseName` is the port of tmuxctl's own
   *     normalisation, so a name this accepts is a name `tmuxctl <name>` can
   *     still join. A name with nothing alphanumeric left is refused outright
   *     rather than silently replaced — the caller asked for a specific name
   *     and deserves to be told it cannot have it. (`resolveSessionName` uses
   *     the same predicate to decide whether a typed label is usable at all.)
   *  2. **Uniqueness is the HOST's answer.** ./sessionName.ts explains why this
   *     module never decides it: the Kotlin removed its client-side `-2`/`-3`
   *     walk because a stale UI cache kept requesting names that were already
   *     taken. So the check is `tmux has-session -t '=<to>'` against the live
   *     server, one command before the rename, not a scan of a session list the
   *     renderer may have fetched a minute ago.
   *
   * A same-name rename is a SUCCESS, not an error: committing an unchanged tab
   * label is the commonest thing a rename field does, and making the user see a
   * failure for it would be absurd.
   *
   * What this does NOT do is move anything. tmux session options — including
   * `@ps_agent_kind`, the authoritative agent classification — are keyed to the
   * session and not to its name, so the recorded engine survives. Attached
   * clients follow the session by id and stay attached. The caller is
   * responsible for the two pieces of state the DESKTOP keys by name: the
   * composer's per-session record, and TmuxClientPool's note of which session
   * its client is showing.
   */
  async renameSession(
    connectionId: string,
    from: string,
    to: string,
  ): Promise<RenameSessionResult> {
    const target = sanitiseName(to);
    if (!/[A-Za-z0-9]/.test(target)) {
      return {
        ok: false,
        sessionName: null,
        error: `"${to.trim()}" cannot be a session name: only letters, digits, "_" and "-" survive.`,
        code: 'illegal-name',
      };
    }
    // Idempotent, and deliberately BEFORE the has-session probe — otherwise
    // committing an unchanged label would find the session itself and report
    // its own name as taken.
    if (target === from) return { ok: true, sessionName: from, error: null, code: null };

    // Locate `from` FIRST, and let its server answer both remaining questions:
    // uniqueness and the rename itself. Names are per-SERVER in the
    // per-session-server world, so "is `target` free" means "free on the
    // server the rename will run on" — the same reason the kill aims with
    // `-S`. A failed or empty sweep (`unknown`) leaves the bare default-socket
    // spelling, which is the only query that existed before this.
    const located = await this.helper.locateSession(connectionId, from);
    const socketPath = located.status === 'found' ? located.socketPath : null;

    const taken = await this.ssh.exec(
      connectionId,
      pathAwareCommand(sessionExistsCommand(target, socketPath)),
    );
    if (taken.exitCode === 0) {
      return {
        ok: false,
        sessionName: null,
        error: `A session called "${target}" is already running on this host.`,
        code: 'name-taken',
      };
    }

    const renamed = await this.ssh.exec(
      connectionId,
      pathAwareCommand(renameSessionCommand(from, target, socketPath)),
    );
    if (renamed.exitCode !== 0) {
      // tmux's own stderr is the useful sentence here ("can't find session"),
      // and it is the one thing that distinguishes a stale session list from a
      // host that cannot rename at all.
      const detail = renamed.stderr.trim() || renamed.stdout.trim();
      return {
        ok: false,
        sessionName: null,
        error: detail || `Could not rename "${from}".`,
        code: 'rename-failed',
      };
    }
    return { ok: true, sessionName: target, error: null, code: null };
  }

  /**
   * Kill a live tmux session (docs/WORKSPACE.md §14).
   *
   * **The only destructive operation this app performs**, and the only one with
   * no undo: a tmux session is usually an agent in the middle of a task, and
   * killing it takes its scrollback, its shell and its process tree with it.
   * The confirmation belongs to the UI — a service is the wrong place to ask a
   * question — but everything that makes the command safe to issue lives here
   * and in {@link killSessionCommand}, which carries the fixture evidence for
   * why it is raw tmux with an `=` and not `tmuxctl kill`.
   *
   * ## Why the caller is told the session was already gone
   *
   * `not-found` is not an edge case, it is the ordinary race: the tab bar is
   * refreshed on a timer, so the session behind a tab can have been killed from
   * the phone, from the user's own terminal, or by the agent exiting, at any
   * moment before the menu item is clicked. Reporting it as a distinct outcome
   * lets the UI say "it was already gone" and simply refresh, rather than
   * showing a failure for something that produced the state the user asked for.
   *
   * It is separated by PROBING FIRST rather than by parsing tmux's stderr,
   * because "can't find session" is a message and messages are not an API. The
   * probe is `sessionExistsCommand`'s exact `has-session -t '=<name>'`, the same
   * one the rename path uses.
   *
   * ## Why the probe is preceded by a LOCATOR, and the kill aimed by it
   *
   * Probing and killing through a bare `tmux` asks the DEFAULT socket, and the
   * helper's ecosystem now runs one tmux SERVER per session — so `git-aplexer`
   * sat alive on its own `tmuxctl-*` server while every Stop click answered
   * "already gone" against the default one, for days, silently, because
   * `not-found` is the outcome the UI is built to treat as the ordinary race.
   * The locator is one sweep of every socket (the same exec the list already
   * runs); when it saw the name, both commands carry `-S` to that server; when
   * it proves the name is nowhere, `not-found` comes back without a round trip
   * and is finally TRUE; and when the sweep itself died, the bare commands run
   * exactly as before this existed.
   *
   * ## What this does NOT clean up
   *
   * Everything the DESKTOP keys by session name: the pool's live client and its
   * PTY, the mounted terminal pane, and the composer's per-session record. All
   * three are the caller's, exactly as they are for a rename — see the ipc
   * handler and docs/WORKSPACE.md §14.3. The service reaches the host and stops
   * there.
   */
  async killSession(connectionId: string, name: string): Promise<KillSessionResult> {
    const located = await this.helper.locateSession(connectionId, name);
    if (located.status === 'absent') {
      return {
        ok: false,
        error: `"${name}" is not running on this host any more.`,
        code: 'not-found',
      };
    }
    // `unknown` keeps the bare default-socket spelling: a failed sweep proves
    // nothing, and the legacy probe is the only query left. `found` aims both
    // commands at the session's own server even when the column was missing
    // (null socket ⇒ bare form ⇒ default server, the old hosts' only one).
    const socketPath = located.status === 'found' ? located.socketPath : null;

    const alive = await this.ssh.exec(
      connectionId,
      pathAwareCommand(sessionExistsCommand(name, socketPath)),
    );
    if (alive.exitCode !== 0) {
      return {
        ok: false,
        error: `"${name}" is not running on this host any more.`,
        code: 'not-found',
      };
    }

    const killed = await this.ssh.exec(
      connectionId,
      pathAwareCommand(killSessionCommand(name, socketPath)),
    );
    if (killed.exitCode !== 0) {
      const detail = killed.stderr.trim() || killed.stdout.trim();
      return { ok: false, error: detail || `Could not stop "${name}".`, code: 'kill-failed' };
    }
    return { ok: true, error: null, code: null };
  }

  /**
   * The first free `<base>`, `<base>-2`, … on the host, or null when the host
   * did not answer.
   *
   * This used to fall back to [base] on a non-zero exit or an unreadable reply,
   * described as fail-safe on the grounds that a broken probe should never BLOCK
   * a create. That reasoning had the blast radius backwards. [base] is the one
   * answer this function must never invent, because the create it feeds is
   * attach-or-create: handing back [base] does not degrade a `unique` request
   * into a slightly worse `unique` request, it silently converts it into
   * `reuse`, and the caller is told `ok: true` with the name of a session it
   * very probably already has on screen. The only caller of this IS the `unique`
   * policy.
   *
   * So the failure is reported instead of papered over, and
   * {@link startSession} refuses. The last non-blank line is still what is read
   * on success — the walk's own `printf` is the last thing the shell runs, so
   * anything a login shell said before it is behind us.
   */
  private async freeSessionName(connectionId: string, base: string): Promise<string | null> {
    const probe = await this.ssh.exec(
      connectionId,
      pathAwareCommand(freeSessionNameCommand(base)),
    );
    if (probe.exitCode !== 0) return null;
    const lines = probe.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return lines[lines.length - 1] ?? null;
  }

  /** `cd … && pwd -P`, falling back to the input when it cannot be resolved. */
  private async canonicalise(connectionId: string, path: string): Promise<string> {
    const res = await this.ssh.exec(
      connectionId,
      pathAwareCommand(resolveDirectoryCommand(path)),
    );
    if (res.exitCode !== 0) return path;
    const line = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return line ?? path;
  }
}

/** A scope that was not requested cannot make the call fail. */
function scopeOk(scope: ReposScopeResult | null): boolean {
  if (scope === null) return true;
  // gh being absent or logged out is a normal host state, not a failed call.
  return scope.state === 'ok' || scope.state === 'gh-missing' || scope.state === 'gh-unauthenticated';
}

// Re-exported so the preload can type `window.api.projects` without reaching
// into three modules.
export type { ReposListResult, ReposScopeResult, ReposCloneOptions, CreateSessionVia };
