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

/**
 * What a folder's default session — the one named exactly after the folder —
 * reads as on the bar, and the stem the numbered ones are built from.
 */
export const TERMINAL_LABEL = 'Terminal';

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
 * null, and the one the bare `Terminal` label is for.
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
 * Two rewrites, and they are ONE family:
 *
 *   ""   -> `Terminal`
 *   "2"  -> `Terminal 2`
 *   "17" -> `Terminal 17`
 *
 * The empty remainder used to read `main`, the user's own first suggestion
 * ("if there is no prefix left we can call it main, or just terminal"). It was
 * the wrong half of the offer, and the bar said so: a folder's default session
 * read `main` and the very next one read `Terminal 2`, two unrelated words for
 * two sessions that differ only in which of them was created first. Nothing
 * about `main` predicts `Terminal 2`, and nothing about `Terminal 2` explains
 * `main`. Taking the other half of the offer makes the numbering legible —
 * `Terminal`, `Terminal 2`, `Terminal 3` is one list with a first element,
 * where the plain label reads as the unnumbered member rather than as a
 * different kind of thing. The user asked for exactly this: "for main let's
 * call it 'Terminal' so 'Terminal-2' makes more sense".
 *
 * The SPACE is deliberate, though the user typed `Terminal-2`. The hyphen is
 * real in the NAME — `freeSessionNameCommand` builds `git-red-stamp-2` and
 * `tmuxctl` joins that string — but this function returns a display label, and
 * a label that mimics the name's punctuation invites the reader to type it back
 * as one. Every other numbered label on this bar is spaced (`Files 2`, and
 * everything {@link numberCollisions} touches), so a spaced `Terminal 2` is the
 * bar's own convention rather than a second one.
 *
 * The digit rule is not a flourish. `freeSessionNameCommand`
 * (src/main/projects/commands.ts) walks `<base>-2`, `<base>-3` when a folder
 * needs a second session, so the remainder of the second session in
 * `~/git/dtc-website` is literally `2`. A tab labelled `2` sitting beside a tab
 * labelled `import` says nothing at all; `Terminal 2` says what it is. The user
 * spelled out the condition — "if it's just a number".
 *
 * Anything else is the remainder verbatim: "if there is a clear name then we
 * have a clear name." A remainder that merely CONTAINS digits (`v2`, `2fa`) is
 * a name someone chose, so it is left alone.
 */
export function labelForRemainder(remainder: string): string {
  if (remainder === '') return TERMINAL_LABEL;
  if (/^\d+$/.test(remainder)) return `${TERMINAL_LABEL} ${remainder}`;
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
 * Note the bare `Terminal` label cannot collide with itself — two sessions with
 * an empty remainder would both be named exactly `<prefix>`, and tmux permits
 * only one session per name. Collisions are real between a stripped remainder
 * and a foreign session that happens to be called the same thing, which is why
 * the rule is applied uniformly instead of special-cased per label kind.
 *
 * What the `main` -> `Terminal` rename does add is a way for this rule and
 * {@link labelForRemainder} to arrive at the same string from two directions: a
 * foreign session literally named `Terminal` sitting after the folder's default
 * is numbered to `Terminal 2`, which is also what a remainder of `2` produces.
 * That is a pre-existing shape of this one-pass counter (the same is already
 * true of a session named `Files 2` beside two Files tabs) — the counter reads
 * the labels it was handed, not the ones it writes — and it needs a folder to
 * hold a hand-made session named after the label itself before it can happen.
 * Left alone deliberately: this pass is display-only, and the ids underneath
 * stay distinct, so the cost is a repeated word on the bar and not an ambiguous
 * target.
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
 *     bare `Terminal` tab — the one way to promote a session to its folder's
 *     default.
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

/**
 * The tab a "next tab"/"previous tab" chord should land on, as a pure decision.
 *
 * Split out of the key handling for the reason every other chord in this repo
 * is split out of it (`terminalPasteChord`, the composer's send rules): a
 * keydown handler is testable only through a mounted component and a synthetic
 * event, whereas the question this answers — given these tabs and this one,
 * which one is next — is a table.
 *
 * ## Array order IS traversal order
 *
 * No sorting, no re-grouping, no skipping. {@link buildWorkspaceTabs} has
 * already put the session tabs first, oldest first, then the Files tabs, and
 * that is what the user is looking at. A cycle that visited tabs in some other
 * order — kind first, or by recency — would be a second ordering to learn for
 * no gain, and it would break the only property that makes a repeated chord
 * usable: pressing it n times from the first tab must walk left to right along
 * the bar, exactly as the eye does.
 *
 * Files tabs are therefore in the cycle. They are tabs; the bar shows them as
 * tabs; a chord that stopped at the last session would strand the user one
 * press short of the thing they can see.
 *
 * ## Wrapping, and the unknown active tab
 *
 * Both directions wrap, because a bar is a ring for this purpose: the chord's
 * whole job is to get somewhere else with a repeated press, and a press that
 * silently does nothing at the end reads as a dropped keystroke rather than as
 * a boundary.
 *
 * When [activeId] names no tab — it is null, or it is a session that just
 * disappeared out from under the bar — treat the cursor as sitting just OUTSIDE
 * the bar, on the side the user is coming from: `+1` steps onto the first tab,
 * `-1` onto the last. That is the same arithmetic as starting from index -1 and
 * from index `length` respectively, and it means the chord always moves
 * somewhere rather than refusing on a stale selection, which is precisely the
 * state a user reaches for a tab chord to escape.
 *
 * Returns null only for an empty bar — there is no tab to name. A bar of one
 * returns that one tab's id, not null: the cycle is honestly a cycle of one,
 * and the caller re-selecting the tab it is already on is a no-op, whereas a
 * null would make it write a "no such tab" branch for a case that is not an
 * error.
 */
export function nextWorkspaceTabId(
  tabs: readonly WorkspaceTab[],
  activeId: string | null,
  direction: 1 | -1,
): string | null {
  if (tabs.length === 0) return null;
  const current = activeId === null ? -1 : tabs.findIndex((t) => t.id === activeId);
  // An unknown or null active id starts the cursor just outside the bar, on the
  // side the step is coming from: index -1 for `+1`, index `length` for `-1`.
  // Both then go through the same arithmetic as a real position.
  const from = current < 0 ? (direction === 1 ? -1 : tabs.length) : current;
  // `+ tabs.length` before the modulo: `%` keeps the sign of the left operand
  // in JS, so stepping back off index 0 would otherwise land on -1.
  return tabs[(from + direction + tabs.length) % tabs.length]?.id ?? null;
}

/**
 * The tab at a 0-based position, or null when there is none.
 *
 * For the `Ctrl+1..9` direct jumps, which are the same decision as
 * {@link nextWorkspaceTabId} minus the traversal: the caller turns the digit
 * into an index and asks whether the bar is that long. Out of range returns
 * null rather than clamping to the last tab — `Ctrl+7` on a bar of three means
 * "the seventh tab", and there isn't one, so the honest answer is to do nothing
 * rather than to move the user somewhere they did not ask for.
 */
export function tabIdAtIndex(tabs: readonly WorkspaceTab[], index: number): string | null {
  return tabs[index]?.id ?? null;
}
