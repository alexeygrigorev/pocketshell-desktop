/**
 * The folder workspace's tab model, as pure functions (docs/WORKSPACE.md §3).
 *
 * Everything the tab bar decides — what a tab is called, what order the tabs
 * sit in, how two tabs that want the same name are told apart — is decided
 * here, with no Vue, no store and no DOM. It is separated for the usual reason
 * this repo separates things (a rule with a unit test beats a rule inside a
 * template), and for one specific one: the labelling rule is the part of this
 * design the user described in the most detail and the part a reader is most
 * likely to disagree with, so it should be readable in one file.
 *
 * ## The prefix is the FOLDER'S name, not the sessions' common prefix
 *
 * The user said "we remove the prefix — the prefix is common for them". It is
 * common because every session in a folder is named after that folder:
 * `sessionBaseName('~/git/dtc-website', home)` is `git-dtc-website`, and
 * `tmuxctl`, the phone and this app all derive it the same way, which is the
 * whole point of that function existing in `shared/`.
 *
 * Taking the LITERAL longest common prefix of the names instead would be
 * shorter to write and wrong in the case that matters. A folder holding
 * `git-dtc-website` and a hand-made session called `git-scratch` has a literal
 * common prefix of `git-`, so both tabs would be relabelled — `dtc-website`
 * and `scratch` — inventing a shared identity out of a coincidence of
 * spelling, and renaming a tab whose name was never derived from anything.
 * The folder's own base name cannot do that: a session either starts with it
 * or it does not.
 */

/** A session tab, before labelling. */
export interface SessionTabInput {
  /** The tmux session name — the join key, and this tab's identity. */
  name: string;
  /** Epoch seconds of creation. Drives tab order; see {@link buildWorkspaceTabs}. */
  created: number;
}

/** A Files tab, before labelling. */
export interface FilesTabInput {
  /** Stable identity, unique within the workspace. */
  id: string;
  /** The directory this tab is looking at, when it has one yet. */
  path?: string | null;
}

export type WorkspaceTab =
  | {
      kind: 'session';
      /** Stable identity. For a session tab this IS the session name. */
      id: string;
      session: string;
      label: string;
      /**
       * The part of the label the user may edit, i.e. the remainder after the
       * folder prefix was stripped. Null when the session's name is not
       * derived from the folder at all, in which case a rename edits the whole
       * name (docs/WORKSPACE.md §4.3).
       */
      remainder: string | null;
      created: number;
    }
  | { kind: 'files'; id: string; label: string; path: string | null };

/** What a tab bar with no session tabs still needs a name for. */
export const MAIN_LABEL = 'main';

/** Files tabs all read `Files`; a second one becomes `Files 2` by §3.4. */
export const FILES_LABEL = 'Files';

/**
 * Strip [prefix] off [name], returning the remainder, or null when [name] is
 * not derived from [prefix] at all.
 *
 * The `-` boundary is required and is not a detail: without it a prefix of
 * `git-red-stamp` would claim `git-red-stampede`, which is a different folder's
 * session that merely starts with the same letters. `sessionBaseName` joins
 * components with `-`, so `-` is the only boundary a derived name can have.
 *
 * An exact match returns the empty string — a real remainder, distinct from
 * null, and the one the `main` label is for.
 */
export function stripSessionPrefix(name: string, prefix: string): string | null {
  if (prefix.length === 0) return null;
  if (name === prefix) return '';
  if (name.startsWith(`${prefix}-`)) return name.slice(prefix.length + 1);
  return null;
}

/**
 * The label a remainder reads as, before collisions are resolved.
 *
 * Two rewrites, both from the user's own words:
 *
 *   ""   -> `main`     "if there is no prefix left we can call it main"
 *   "2"  -> `Terminal 2`
 *
 * The digit rule is not a flourish. `freeSessionNameCommand`
 * (src/main/projects/commands.ts) walks `<base>-2`, `<base>-3` when a folder
 * needs a second session, so the remainder of the second session in
 * `~/git/dtc-website` is literally `2`. A tab labelled `2` sitting beside a tab
 * labelled `import` says nothing at all; `Terminal 2` says what it is. The user
 * spelled out the condition — "if it's just a number".
 *
 * Anything else is the remainder verbatim: "if there is a clear name then we
 * have a clear name."
 */
export function labelForRemainder(remainder: string): string {
  if (remainder === '') return MAIN_LABEL;
  if (/^\d+$/.test(remainder)) return `Terminal ${remainder}`;
  return remainder;
}

/**
 * Append ` 2`, ` 3`… to every label after the first that wants it.
 *
 * In place, in the array's own order, which is TAB ORDER. Numbering by tab
 * order rather than alphabetically is what makes the numbers stable: a session
 * created now lands at the end of the bar and cannot renumber the tabs already
 * on it. Alphabetical numbering would let a new `git-foo-aardvark` take the
 * plain label away from a tab that has had it all day.
 *
 * Note the `main` label cannot collide with itself — two sessions with an empty
 * remainder would both be named exactly `<prefix>`, and tmux permits only one
 * session per name. Collisions are real between a stripped remainder and a
 * foreign session that happens to be called the same thing, which is why the
 * rule is applied uniformly instead of special-cased per label kind.
 */
export function numberCollisions<T extends { label: string }>(tabs: T[]): T[] {
  const seen = new Map<string, number>();
  for (const tab of tabs) {
    const n = (seen.get(tab.label) ?? 0) + 1;
    seen.set(tab.label, n);
    if (n > 1) tab.label = `${tab.label} ${n}`;
  }
  return tabs;
}

/**
 * The whole tab bar for one folder workspace.
 *
 * Order: session tabs, then Files tabs — "the tabs are always ordered: first
 * agent sessions, then files."
 *
 * Session tabs sort by CREATION time, oldest first, and this is the one place
 * in the app that does not sort by activity. A tab bar is a set of targets:
 * the user aims at a tab and then clicks it, and a bar that reorders under the
 * session store's refresh timer moves the target between those two moments.
 * The panel can sort by recency because its rows are read; the tab bar cannot,
 * because its rows are hit. Creation order is also what makes "session one is
 * one tab, session two is another tab" literally true, since `sessions create`
 * walks `<base>`, `<base>-2`, `<base>-3` in exactly that order. Ties break on
 * the name so the order is total even on a host whose table reports one
 * timestamp for everything (`parseSessionsList` sets `activity === created`,
 * because the helper's table carries three columns and no more).
 *
 * Files tabs keep the order they were opened in, which is the order the caller
 * hands them over in.
 */
export function buildWorkspaceTabs(
  sessions: readonly SessionTabInput[],
  prefix: string,
  files: readonly FilesTabInput[] = [],
): WorkspaceTab[] {
  const sessionTabs: WorkspaceTab[] = [...sessions]
    .sort((a, b) => a.created - b.created || a.name.localeCompare(b.name))
    .map((s) => {
      const remainder = stripSessionPrefix(s.name, prefix);
      return {
        kind: 'session' as const,
        id: s.name,
        session: s.name,
        // A name that is not derived from this folder keeps its own name in
        // full. Stripping is not applicable to it, and pretending otherwise is
        // how `nightly-build` would become `build`.
        label: remainder === null ? s.name : labelForRemainder(remainder),
        remainder,
        created: s.created,
      };
    });

  const filesTabs: WorkspaceTab[] = files.map((f) => ({
    kind: 'files' as const,
    id: f.id,
    label: FILES_LABEL,
    path: f.path ?? null,
  }));

  // Numbered across the WHOLE bar, not per kind: a session legitimately called
  // `Files` and a Files tab are two tabs reading identically, and which of them
  // keeps the plain label is decided by position like every other collision.
  return numberCollisions([...sessionTabs, ...filesTabs]);
}

/**
 * The full session name a tab rename commits, given what the user typed into
 * the label.
 *
 * The field edits the LABEL and commits the NAME, and re-applying the prefix
 * here is what stops a rename detaching a session from its folder. Editing
 * `import` to `staging` in `~/git/dtc-website` renames
 * `git-dtc-website-import` to `git-dtc-website-staging`, so the session stays
 * grouped where it was and its tab keeps stripping.
 *
 * Two escapes:
 *   - a tab whose label IS the session name (`remainder === null`) commits the
 *     raw typed name, because there is no prefix to re-apply;
 *   - clearing the field renames the session TO the bare prefix, which is the
 *     `main` tab — the one way to promote a session to its folder's default.
 *
 * Returns null when the input cannot become a legal session name at all, which
 * the caller must treat as "refuse", not as "use the fallback". The predicate
 * is `resolveSessionName`'s: at least one letter or digit survives sanitising.
 * A name this app accepts is therefore a name this app can also derive — and,
 * more importantly, one `tmuxctl <name>` can still join (docs/WORKSPACE.md
 * §4.1).
 */
export function renamedSessionName(
  typed: string,
  prefix: string,
  remainder: string | null,
  sanitise: (part: string) => string,
): string | null {
  const clean = sanitise(typed.trim());
  if (remainder === null) return /[A-Za-z0-9]/.test(clean) ? clean : null;
  if (clean === '') return /[A-Za-z0-9]/.test(prefix) ? prefix : null;
  const full = `${prefix}-${clean}`;
  return /[A-Za-z0-9]/.test(full) ? full : null;
}
