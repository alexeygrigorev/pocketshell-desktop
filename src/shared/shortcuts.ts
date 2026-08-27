/**
 * Every keyboard chord this app claims, as DATA.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The user asked, in as many words: "i also want to see the shortcuts and make
 * them configurable because I asked you about them but I don't know what we
 * have". That is not a feature request so much as a bug report about the
 * repository. Chords accumulated one commit at a time — the clipboard pair,
 * then the typing intercept, then the composer's toggle and its size ladder,
 * then Ctrl+S/L/F in Files, then the zoom fix, then tab cycling — and each one
 * was justified in a comment beside the `if` that implemented it. Several were
 * chosen by asking "what is already taken?", and the answer to that question
 * lived in a conversation rather than anywhere a later reader could check it.
 * FilesView's own comment is the proof: it states that the composer's chords
 * "are not live on this tab, which hides the composer entirely", and that is
 * false — the composer registers its handler on `window` with `capture: true`
 * in `onMounted`, and the workspace keeps it MOUNTED behind a `v-show` while a
 * Files tab is showing, precisely so a tab switch cannot cost a draft. The
 * chord is live; only the panel it toggles is invisible. A mental map cannot
 * catch that. A table can.
 *
 * So: one module, one list, and every call site consults it. That is what makes
 * the Settings screen truthful rather than a second copy of the truth, and it
 * is what stops the NEXT chord being picked against a stale memory of this one.
 *
 * ---------------------------------------------------------------------------
 * WHAT A "CHORD" IS HERE
 * ---------------------------------------------------------------------------
 * `Ctrl` in this file always means Ctrl-OR-Command. Every existing call site
 * spells the test `e.ctrlKey || e.metaKey`, so there has never been a chord in
 * this app that distinguished them, and inventing the distinction now would
 * make the registry disagree with the code it is supposed to describe.
 * {@link formatChordParts} renders it as `Cmd` on macOS purely for display.
 *
 * Matching is on `KeyboardEvent.key`, not on `code`, for the reason spelled out
 * at length in `src/shared/zoomKeys.ts`: `key` is the character the user's
 * LAYOUT actually produced, and matching physical positions turns an unrelated
 * character into a shortcut the moment somebody uses a non-US keyboard. The one
 * documented exception in this app — the numeric keypad's `+`/`-`/`0` — belongs
 * to the zoom matcher, which is a main-process concern and stays there; this
 * registry names those chords for the LIST without claiming to be their
 * implementation. See {@link ShortcutSpec.owner}.
 *
 * ---------------------------------------------------------------------------
 * THE SHIFTED-PUNCTUATION CAVEAT, STATED RATHER THAN HIDDEN
 * ---------------------------------------------------------------------------
 * Because matching is on `key`, Shift changes the key of a punctuation chord:
 * Ctrl+Shift+` arrives as `{ key: '~', shift: true }`, not as
 * `{ key: '`', shift: true }`. A chord captured from a real keypress therefore
 * round-trips exactly — capture and match read the same field — but a chord
 * TYPED into a config file as `Ctrl+Shift+\`` would never fire. That is why the
 * rebinding UI captures a keypress instead of accepting typed text, and why
 * {@link parseChord} is tolerant rather than clever: it is a loader for values
 * this app produced, not a parser for a keybinding language.
 */

/**
 * The screens a chord can belong to.
 *
 * These are not "components". They are the answer to one question — while the
 * user is looking at X, which chords are live? — because that is the question
 * conflict detection has to answer, and a component tree does not answer it
 * (see {@link surfacesCollide}).
 */
export type ShortcutSurface = 'global' | 'workspace' | 'terminal' | 'composer' | 'files' | 'doodle';

/** Display order and prose for each surface, for the Settings list. */
export interface SurfaceSpec {
  id: ShortcutSurface;
  label: string;
  /** One sentence saying WHEN these chords are live. */
  blurb: string;
}

export const SURFACES: readonly SurfaceSpec[] = [
  {
    id: 'global',
    label: 'Everywhere',
    blurb:
      'Live on every screen, including the host list before anything is connected. Recognised in the main process, before the page sees the key.',
  },
  {
    id: 'workspace',
    label: 'Tabs',
    blurb:
      'The tab bar of a folder or host workspace. Caught by one window-level handler in capture, so the chord works with focus in the terminal, the file tree or the composer alike.',
  },
  {
    id: 'terminal',
    label: 'Terminal',
    blurb:
      'A session pane with focus. Everything not listed here reaches the shell untouched — that is the default, and it is the point.',
  },
  {
    id: 'composer',
    label: 'Prompt composer',
    blurb:
      'The composer panel. Its toggles listen on the window rather than on the panel, so they stay live while the panel is closed — that is how you open it.',
  },
  {
    id: 'files',
    label: 'Files',
    blurb: 'The Files tab: the tree, the path bar and the open file.',
  },
  {
    id: 'doodle',
    label: 'Annotate',
    blurb: 'The drawing surface that opens over the composer.',
  },
] as const;

/**
 * Which surfaces are live AT THE SAME TIME.
 *
 * "Two commands on one chord in the same surface must be refused" is only a
 * usable rule once "same surface" is defined, and in this app the surfaces
 * genuinely overlap:
 *
 *   - The composer FLOATS OVER the terminal. Both are live together; that is
 *     the entire design of the panel.
 *   - The composer is also live on the FILES TAB, which is the finding that
 *     started this module. `FolderWorkspaceView` mounts it once, outside the
 *     tab body, behind a `v-show` — so its window-level capture handler keeps
 *     running while Files is showing. FilesView's comment says otherwise; the
 *     comment is wrong and the call-site diff corrects it.
 *   - The Files tab has NO terminal — the panes are hidden, and nothing routes
 *     a key to xterm — so `Ctrl+S` can save a file there while staying XOFF at
 *     a shell. That asymmetry is the reason this is a graph and not a flat
 *     "everything collides with everything".
 *   - Tab chords are handled by ONE window listener in capture, not by the
 *     terminal's custom key handler — that is the only way a single
 *     implementation serves the terminal, the Files tree and the composer
 *     alike, and it is why they work on a Files tab at all. They still
 *     collide with terminal chords, because a tab chord fires while a
 *     terminal is showing and both would claim the keystroke.
 *   - The annotate surface opens over the composer and covers it, but the
 *     composer's window handler is still attached underneath.
 *
 * The relation is symmetric and reflexive; `tests/unit/shortcuts.test.ts`
 * proves both, because an asymmetric collision table would refuse a binding in
 * one direction and allow it in the other, which is worse than no check at all.
 */
const SURFACE_COLLISIONS: Record<ShortcutSurface, readonly ShortcutSurface[]> = {
  global: ['global', 'workspace', 'terminal', 'composer', 'files', 'doodle'],
  workspace: ['global', 'workspace', 'terminal', 'composer', 'files'],
  terminal: ['global', 'workspace', 'terminal', 'composer'],
  composer: ['global', 'workspace', 'terminal', 'composer', 'files', 'doodle'],
  files: ['global', 'workspace', 'composer', 'files'],
  doodle: ['global', 'composer', 'doodle'],
};

/** Whether two surfaces can be live at the same moment. @see SURFACE_COLLISIONS */
export function surfacesCollide(a: ShortcutSurface, b: ShortcutSurface): boolean {
  return SURFACE_COLLISIONS[a].includes(b);
}

/**
 * Surfaces where a keystroke can end up in front of a shell.
 *
 * Everything that collides with `terminal` qualifies, which is exactly the set
 * that must not be allowed to swallow SIGINT — see {@link RESERVED_CHORDS}.
 */
function reachesAShell(surface: ShortcutSurface): boolean {
  return surfacesCollide(surface, 'terminal');
}

// ---------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------

/**
 * One chord. `ctrl` is Ctrl-or-Command; see the file header.
 *
 * Frozen at construction so a chord handed out of the registry cannot be
 * mutated by a consumer into something the registry never validated.
 */
export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The canonical key token. @see canonicalKey */
  key: string;
}

/**
 * The subset of `KeyboardEvent` a chord is read from. Structural so the rules
 * can be tested without a DOM, exactly as `ZoomKeyInput` is.
 */
export interface ChordKeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * The canonical spelling of a key token.
 *
 * Letters are upper-cased because a browser reports `v` or `V` for the same
 * physical key depending on Shift and Caps Lock, and the existing call sites
 * already test both spellings by hand (`e.key === 'V' || e.key === 'v'`). A
 * bare space becomes `Space` so a chord string can use `+` as its separator
 * without a token that is invisible in a config file. Named keys keep the DOM's
 * own spelling — `Escape`, `ArrowUp`, `Backspace` — so there is one vocabulary
 * rather than a translation layer nobody can remember the direction of.
 */
export function canonicalKey(key: string): string {
  if (key === ' ' || key === 'Space' || key === 'Spacebar') return 'Space';
  // `Array.from` rather than `.length`, so an astral character counts as one
  // and is not truncated into half a surrogate pair.
  const chars = Array.from(key);
  if (chars.length === 1) return key.toUpperCase();
  return key;
}

/** A chord from a real key event. Ctrl and Cmd are the same modifier here. */
export function chordFromEvent(e: ChordKeyInput): Chord {
  return Object.freeze({
    ctrl: e.ctrlKey === true || e.metaKey === true,
    alt: e.altKey === true,
    shift: e.shiftKey === true,
    key: canonicalKey(e.key),
  });
}

/**
 * A chord's stored spelling: modifiers in a fixed order, then the key.
 *
 * Fixed order is what makes the string a KEY rather than a rendering —
 * `Ctrl+Shift+V` and `Shift+Ctrl+V` are one chord, and two spellings of it
 * would be two entries in an override map and a conflict check that missed
 * them.
 */
export function chordToString(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(chord.key);
  return parts.join('+');
}

/**
 * Read a stored chord back, or `null` for anything this build cannot trust.
 *
 * Deliberately narrow. This parses values THIS APP WROTE — the defaults below
 * and whatever the capture field produced — out of user-writable JSON on disk.
 * It is not a keybinding language, so an unknown modifier name, a missing key
 * or a duplicate modifier is simply rejected rather than guessed at. A rejected
 * override costs that one binding its custom chord and nothing else; see the
 * settings store's per-entry degradation.
 */
export function parseChord(raw: string): Chord | null {
  if (typeof raw !== 'string') return null;
  // A lone `+` is a legal key token, so the split cannot be naive: peel the
  // modifiers off the front and treat the whole remainder as the key.
  let rest = raw.trim();
  if (rest === '') return null;
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (;;) {
    const plus = rest.indexOf('+');
    // No separator left, or the separator IS the key (`Ctrl++`): stop peeling.
    if (plus <= 0) break;
    const head = rest.slice(0, plus);
    const lower = head.toLowerCase();
    if (lower === 'ctrl' || lower === 'cmd' || lower === 'control' || lower === 'command') {
      if (ctrl) return null;
      ctrl = true;
    } else if (lower === 'alt' || lower === 'option') {
      if (alt) return null;
      alt = true;
    } else if (lower === 'shift') {
      if (shift) return null;
      shift = true;
    } else {
      // Not a modifier, so this is the key and it contained a `+`. That is not
      // a spelling this app produces.
      return null;
    }
    rest = rest.slice(plus + 1);
  }
  if (rest === '') return null;
  return Object.freeze({ ctrl, alt, shift, key: canonicalKey(rest) });
}

/** Whether a key event is this chord. */
export function chordMatches(chord: Chord, e: ChordKeyInput): boolean {
  const pressed = chordFromEvent(e);
  return (
    pressed.ctrl === chord.ctrl &&
    pressed.alt === chord.alt &&
    pressed.shift === chord.shift &&
    pressed.key === chord.key
  );
}

/**
 * How a key token is SHOWN, which is not how it is stored.
 *
 * Arrow keys are spelled out as words rather than drawn as `↑`/`↓`, and that is
 * a rule with a test behind it: `tests/unit/designGates.test.ts` bans glyphs
 * doing an icon's job in renderer templates, with a single grandfathered
 * exemption for the composer's `Ctrl+Shift+↑` tooltip copy. A shortcut list is
 * the exact place that exemption would be quietly widened into a habit, so this
 * one says "Up". It also reads better in a `<kbd>` chip, which is what the
 * Settings list renders each part as.
 */
const KEY_LABELS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Del',
  Tab: 'Tab',
  Space: 'Space',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

/**
 * The chord as a list of parts, one per `<kbd>` chip.
 *
 * A list rather than a string because the Settings screen styles each key
 * separately; joining here and splitting there would put the separator in two
 * places. `mac` renders the Ctrl-or-Command modifier as `Cmd`, which is display
 * only — the stored spelling stays `Ctrl` on every platform, so a settings file
 * copied between machines keeps working.
 */
export function formatChordParts(chord: Chord, mac = false): string[] {
  const parts: string[] = [];
  if (chord.ctrl) parts.push(mac ? 'Cmd' : 'Ctrl');
  if (chord.alt) parts.push(mac ? 'Option' : 'Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(KEY_LABELS[chord.key] ?? chord.key);
  return parts;
}

/** One-line spelling, for prose, titles and test failure messages. */
export function formatChord(chord: Chord, mac = false): string {
  return formatChordParts(chord, mac).join('+');
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Who actually implements a binding. This is the honest half of "configurable":
 * a chord recognised in the main process cannot read the renderer's
 * localStorage, and a chord owned by a third-party keymap is not ours to move.
 */
export type ShortcutOwner =
  /** A renderer handler that reads this registry. Rebindable. */
  | 'app'
  /** `before-input-event` in the main process. Listed, not rebindable. */
  | 'main'
  /** Electron's default application menu. Listed so the collision is visible. */
  | 'menu'
  /** CodeMirror's own keymap, or xterm's. Listed, not ours. */
  | 'library';

/** One binding, as data. */
export interface ShortcutSpec {
  /** Stable id. Used as the override key on disk, so it may not be renamed. */
  id: string;
  surface: ShortcutSurface;
  /** What it DOES, in the user's words, not the function's name. */
  label: string;
  /**
   * Default chords, in the stored spelling. More than one only where a single
   * intent genuinely has several spellings (zoom in) or where the app has long
   * offered two ways to say the same thing (the composer's toggle).
   */
  defaults: readonly string[];
  owner: ShortcutOwner;
  /** True only for `owner: 'app'` bindings the user may move. */
  rebindable: boolean;
  /**
   * Why this chord and not another, where the answer is not obvious. Shown in
   * the Settings list, because "it is subtle" is exactly the information that
   * was previously only in a code comment.
   */
  note?: string;
  /**
   * The LADDERS this binding is a rung of, if any.
   *
   * The one case where two commands on one chord in overlapping surfaces is
   * correct rather than a bug. Escape is the app's clearest example: the
   * doodle's caption editor, the composer and the overlay chrome all handle it,
   * each calling `stopPropagation` before it reaches the next one out, so one
   * keypress closes the innermost thing that is open. Enter is the second: the
   * slash-command dropdown takes it while open, and the send handler takes it
   * otherwise.
   *
   * A LIST rather than one id, because a binding can be a rung of two ladders
   * at once and one of them is — the doodle's caption editor finishes on Escape
   * AND on Ctrl+Enter, so it stands in the Escape ladder above the composer's
   * dismiss and in the Enter ladder above the composer's send. The conflict
   * check found that pair on its first run and reported it as a duplicate,
   * which is precisely the shape of question this field exists to answer.
   *
   * Rungs share a chord BY DESIGN, so conflict detection must not report them
   * — and every rung is `rebindable: false`, because what makes a ladder work is
   * the ORDER the handlers run in, which is not something a chord picker can
   * express. Naming the ladder here is what stops the next reader "fixing" the
   * duplicate.
   */
  ladders?: readonly ('escape' | 'enter')[];
}

/**
 * Every chord this app claims — including the ones it does not implement.
 *
 * The ones it does not implement are the reason the list is trustworthy.
 * Electron's DEFAULT MENU binds accelerators this app never declared, and that
 * is not a footnote: `Ctrl+=` silently did nothing for months because the
 * default `zoomin` role carries `CommandOrControl+Plus` and Electron parses
 * `Plus` as SHIFTED `=`, and `Ctrl+W` still closes the window where readline
 * expects delete-word. A list that only showed what this app wrote would have
 * shown neither, and both are things the user experiences as this app's
 * keyboard behaviour.
 */
export const SHORTCUTS: readonly ShortcutSpec[] = [
  // --- Everywhere ---------------------------------------------------------
  {
    id: 'zoom.in',
    surface: 'global',
    label: 'Zoom the whole window in',
    defaults: ['Ctrl+=', 'Ctrl++'],
    owner: 'main',
    rebindable: false,
    note: 'Four spellings for one intent, matched in the main process: Ctrl+=, Ctrl+Shift+=, a layout with a dedicated + key, and the numeric keypad. Electron’s default menu bound only CommandOrControl+Plus, which is SHIFTED = — so plain Ctrl+= matched nothing for months, which is the bug that started this. The keypad is matched by physical key code, the one place in the app that looks at code rather than key.',
  },
  {
    id: 'zoom.out',
    surface: 'global',
    label: 'Zoom the whole window out',
    defaults: ['Ctrl+-'],
    owner: 'main',
    rebindable: false,
    note: 'Ctrl+Shift+- is deliberately NOT a second spelling: that chord is Ctrl+_, which readline binds to undo, and swallowing it would cost a key inside the terminal to buy a fourth way to press one that already has three.',
  },
  {
    id: 'zoom.reset',
    surface: 'global',
    label: 'Reset zoom to 100%',
    defaults: ['Ctrl+0'],
    owner: 'main',
    rebindable: false,
  },
  {
    id: 'window.close',
    surface: 'global',
    label: 'Close the window',
    defaults: ['Ctrl+Shift+W'],
    owner: 'main',
    rebindable: false,
    note:
      'Relocated from Ctrl+W, which Electron\'s default menu held and which is readline\'s delete-word. That menu is gone on Windows and Linux; Alt+F4 and the title bar still close. Admitted because Ctrl+Shift+W produces nothing at the terminal.',
  },
  {
    id: 'window.devTools',
    surface: 'global',
    label: 'Toggle DevTools',
    defaults: ['Ctrl+Shift+I'],
    owner: 'main',
    rebindable: false,
    note:
      'The chord the removed default menu carried, re-provided in before-input-event. Also dead at the terminal.',
  },
  {
    id: 'overlay.close',
    ladders: ['escape'],
    surface: 'global',
    label: 'Close the panel in front (Settings, Ports, Usage, a dialog)',
    defaults: ['Escape'],
    owner: 'app',
    rebindable: false,
    note: 'Escape is a ladder, not a chord: it closes the innermost thing that is open, and each surface stops it before it reaches the next one out. Rebinding a rung would break the ordering rather than move a key.',
  },
  {
    id: 'text.deleteWordBackward',
    surface: 'global',
    label: 'Delete the word before the caret — inside a text field',
    defaults: ['Ctrl+W'],
    owner: 'app',
    rebindable: false,
    note:
      'Readline’s unix-word-rubout (`\\x17`), made good everywhere EXCEPT the shell: Electron’s default menu held this chord for Close until `169cf60` disarmed that menu, leaving every text field with a dead key the hand still reaches for. The handler only ever fires in an `<input>` or `<textarea>` — it stands down inside `.xterm`, so the terminal keeps sending `\\x17` to the shell, and inside the code editor, whose keymap is CodeMirror’s. On macOS the default menu stays and Cmd+W still means Close there, so this does not install on darwin. Not rebindable because its TRUE reach is “plain text fields”, which no surface models: rebinding it as if it were live over the whole workspace would let conflict detection promise things about a terminal it never touches.',
  },

  // --- Tabs ---------------------------------------------------------------
  {
    id: 'tabs.stepLeftRight',
    surface: 'workspace',
    label: 'The tab to the left, the tab to the right',
    defaults: ['Ctrl+ArrowLeft', 'Ctrl+ArrowRight'],
    owner: 'app',
    rebindable: false,
    note: 'Asked for as half of one gesture — "ctrl left goes to the left tab right to the right tab", with Ctrl+Up/Down for the workspaces — and the pairing is the point: horizontal is the tab bar, vertical is the panel down the side, which is where each of those lists actually sits. A PAIR of chords, so it is fixed for the same reason a pair always is here: an override replaces a binding’s chords outright and would lose one. It CLAMPS at both ends. What it costs is readline’s backward-word / forward-word in the pane (xterm sends ESC [ 1 ; 5 D / C); Alt+B and Alt+F are the same two commands and are untouched. It stands down inside a real text field, where Ctrl+arrow is an editing gesture — but NOT inside the terminal, whose xterm-helper-textarea would otherwise exempt the one surface this is for.',
  },
  {
    id: 'workspaces.stepUpDown',
    surface: 'global',
    label: 'The workspace above, the workspace below',
    defaults: ['Ctrl+ArrowUp', 'Ctrl+ArrowDown'],
    owner: 'app',
    rebindable: false,
    note: 'The other half of the same gesture: it walks the session panel’s folder rows, flat across roots (a root header is a label, not a stop), and opens each one’s workspace. Owned by HostWorkspaceView, because it changes WHICH workspace is mounted and that view owns the route — surface "global" for the same reason. Clamps at both ends. The cheaper half at the terminal: xterm sends ESC [ 1 ; 5 A / B, which readline leaves unbound by default. Same text-field exemption as the tab arrows, kept in step deliberately.',
  },

  // `tabs.move` (Ctrl+Shift+PageUp/PageDown), `tabs.jumpToIndex`
  // (Ctrl+1..Ctrl+9) and the tab CYCLE (`tabs.next`/`tabs.previous`,
  // Ctrl+Tab / Ctrl+Shift+Tab) USED TO BE HERE and were removed at the user's
  // request — "Move the active tab left or right remove this too", "remove
  // ctrl 1 2 3 hotkey", "remove these hotkeys let's keep only ctrl left and
  // ctrl right" — when the arrow chords arrived to do the navigating.
  //
  // Recorded here because each removal HAND KEYS BACK to the pane, and a
  // future reader wondering why those chords are free needs to know they were
  // deliberately released rather than never claimed: Ctrl+3..Ctrl+8 are the C0
  // controls ESC, FS, GS, RS, US and DEL (Ctrl+3 is a common stand-in for
  // Escape); Ctrl+Shift+PageUp/PageDown reach xterm's own scrollback; and
  // Ctrl+Tab is C0.HT (completion at a shell prompt, since xterm ignores Ctrl
  // on Tab) while Ctrl+Shift+Tab is ESC [ Z, back-tab.
  //
  // Moving a tab from the keyboard went with its chord. The DRAG
  // (docs/WORKSPACE.md §15) is untouched and is the way to reorder.

  // --- Terminal -----------------------------------------------------------
  {
    id: 'terminal.pasteIntoShell',
    surface: 'terminal',
    label: 'Paste into the shell (right-click)',
    defaults: [],
    owner: 'app',
    rebindable: false,
    note: 'NO CHORD, on purpose — this is the right-click, and it is the only route left to the shell’s own paste. Ctrl+Shift+V used to be here and moved to pasteIntoComposer on a user report: it is the chord every terminal emulator trains into the hand, so it is the one reached for first, and a pane where one paste chord opens the composer while its twin feeds the shell is a coin toss the user cannot call before the clipboard has already landed somewhere. Listed with no default rather than deleted, because the action still exists and a reader of this table needs to find out how to reach it.',
  },
  {
    id: 'terminal.copySelection',
    surface: 'terminal',
    label: 'Copy the selection',
    defaults: ['Ctrl+Shift+C'],
    owner: 'app',
    rebindable: true,
    note: 'Bare Ctrl+C is SIGINT and can never be this. Selecting with the mouse already copies on mouse-up, so this chord is the keyboard route to something the mouse does for free.',
  },
  {
    id: 'terminal.pasteIntoComposer',
    surface: 'terminal',
    label: 'Put the clipboard in the prompt composer',
    defaults: ['Ctrl+V', 'Ctrl+Shift+V'],
    owner: 'app',
    rebindable: false,
    note: 'BOTH paste chords, which is the point: a user reported reaching for Ctrl+Shift+V — the chord every terminal emulator trains into the hand — and having the clipboard go to the shell instead. Ctrl+V was affordable only because it was measured: plain Ctrl+V in this pane produced a single SYN byte through xterm’s own ctrl-letter mapping and pasted nothing. What it costs is readline’s literal-next (quoted-insert); Ctrl+Q is bound to the same command in vi mode. Ctrl+Alt+V is left alone — Ctrl+Alt is how AltGr arrives on European layouts, where V sits under a printable character. Both chords are cancelled with preventDefault(), measured: without it Ctrl+Shift+V fires twice (Chromium’s own paste-as-plain-text lands a second copy) and Ctrl+V pastes natively into the draft on top of the staged one.',
  },
  {
    id: 'terminal.scrollback',
    surface: 'terminal',
    label: 'Scroll the pane’s buffer',
    defaults: ['Shift+PageUp', 'Shift+PageDown'],
    owner: 'library',
    rebindable: false,
    note: 'xterm’s own, not this app’s — listed because a user pressing it is using this app’s keyboard, and because it is what the tab-move chord had to stay clear of.',
  },
  {
    id: 'terminal.typingOpensComposer',
    surface: 'terminal',
    label: 'Typing opens the prompt composer',
    defaults: [],
    owner: 'app',
    rebindable: false,
    note: 'Not a chord: ANY printable key, when the setting above is on and the composer is closed. Anything with Ctrl, Alt or Cmd held falls through to the shell untouched, and so does every named key and a bare space — that one rule is what keeps Ctrl+C, tmux’s prefix and the pager’s space out of it.',
  },

  // --- Prompt composer ----------------------------------------------------
  {
    id: 'composer.toggle',
    surface: 'composer',
    label: 'Open or close the composer',
    defaults: ['Ctrl+`'],
    owner: 'app',
    rebindable: true,
    note: 'The VS Code panel chord, deliberately NOT a Shift chord: it is the one users already have in their fingers, and a terminal wants nothing from Ctrl+`. Live on the Files tab too — the composer stays mounted there so a tab switch cannot cost a draft.',
  },
  {
    id: 'composer.toggleAlt',
    surface: 'composer',
    label: 'Open or close the composer (second chord)',
    defaults: ['Ctrl+Shift+K'],
    owner: 'app',
    rebindable: true,
    note: 'Shift is what makes it safe: bare Ctrl+K is a real terminal key (readline kill-line) and must keep reaching the pane.',
  },
  {
    id: 'composer.grow',
    surface: 'composer',
    label: 'Make the composer bigger',
    defaults: ['Ctrl+Shift+ArrowUp'],
    owner: 'app',
    rebindable: true,
    note: 'One of the few Shift chords that is NOT free at a terminal: an arrow carries its modifiers in the escape sequence, so Ctrl+Shift+Up would otherwise reach the shell as ESC [ 1 ; 6 A, which vim and tmux both read.',
  },
  {
    id: 'composer.shrink',
    surface: 'composer',
    label: 'Make the composer smaller, and close it past the bottom',
    defaults: ['Ctrl+Shift+ArrowDown'],
    owner: 'app',
    rebindable: true,
    note: 'Shrinking past docked closes the panel and hands focus back to the terminal, so this is also the way back from a maximized composer.',
  },
  {
    id: 'composer.attach',
    surface: 'composer',
    label: 'Attach a file',
    defaults: ['Ctrl+Shift+A'],
    owner: 'app',
    rebindable: true,
    note: 'Shift again, for the same reason: bare Ctrl+A is beginning-of-line in readline and the other common tmux prefix.',
  },
  {
    id: 'composer.send',
    ladders: ['enter'],
    surface: 'composer',
    label: 'Send the prompt',
    defaults: ['Enter', 'Ctrl+Enter'],
    owner: 'app',
    rebindable: false,
    note: 'Enter is what a text box means, not a chord this app assigned. Shift+Enter is the newline; Ctrl+Enter sends too, for people whose muscle memory came from a chat client. An IME composing text is left alone.',
  },
  {
    id: 'composer.newline',
    surface: 'composer',
    label: 'Newline inside the prompt',
    defaults: ['Shift+Enter'],
    owner: 'app',
    rebindable: false,
  },
  {
    id: 'composer.discard',
    surface: 'composer',
    label: 'Discard the draft',
    defaults: ['Ctrl+Shift+Backspace'],
    owner: 'app',
    rebindable: true,
    note: 'The one control in the composer that throws work away, which is why it is a three-key chord and why Escape is not it.',
  },
  {
    id: 'composer.dismiss',
    ladders: ['escape'],
    surface: 'composer',
    label: 'Close the composer, keeping the draft',
    defaults: ['Escape'],
    owner: 'app',
    rebindable: false,
    note: 'A rung of the Escape ladder: it closes the slash-command dropdown first if one is open, then the panel. It never destroys the draft — Discard is the only control that does.',
  },
  {
    id: 'composer.slashNext',
    surface: 'composer',
    label: 'Move through the slash-command list',
    defaults: ['ArrowDown', 'ArrowUp'],
    owner: 'app',
    rebindable: false,
    note: 'Bare arrows, live only while the dropdown is open.',
  },
  {
    id: 'composer.slashAccept',
    ladders: ['enter'],
    surface: 'composer',
    label: 'Accept the highlighted slash command',
    defaults: ['Tab', 'Enter'],
    owner: 'app',
    rebindable: false,
  },

  // --- Files --------------------------------------------------------------
  {
    id: 'files.save',
    surface: 'files',
    label: 'Save the open file',
    defaults: ['Ctrl+S'],
    owner: 'app',
    rebindable: true,
    note: 'Safe HERE and nowhere else. Ctrl+S at a terminal is XOFF and freezes the screen, which is why this binding is refused on any surface a shell can be behind — and why the Files tab, which has no terminal, may have it.',
  },
  {
    id: 'files.gotoPath',
    surface: 'files',
    label: 'Type a path to go to',
    defaults: ['Ctrl+L'],
    owner: 'app',
    rebindable: true,
    note: 'The address-bar chord. The shell’s own Ctrl+L (clear screen) is untouched: this handler only ever sees keys from inside the Files pane.',
  },
  {
    id: 'files.filterTree',
    surface: 'files',
    label: 'Filter this folder',
    defaults: ['Ctrl+F'],
    owner: 'app',
    rebindable: true,
    note: 'Filters the TREE, not the open file — the editor loads no search extension, so nothing else in this pane wants the chord.',
  },
  {
    id: 'files.editorUndo',
    surface: 'files',
    label: 'Undo in the open file',
    defaults: ['Ctrl+Z'],
    owner: 'library',
    rebindable: false,
    note: 'CodeMirror’s own history keymap, listed because a user pressing it is using this app’s keyboard. Moving it means reconfiguring the editor’s extensions, not changing a line here.',
  },
  {
    id: 'files.editorRedo',
    surface: 'files',
    label: 'Redo in the open file',
    defaults: ['Ctrl+Y', 'Ctrl+Shift+Z'],
    owner: 'library',
    rebindable: false,
  },
  {
    id: 'files.editorTabFocus',
    surface: 'files',
    label: 'Let Tab move focus out of the editor again',
    defaults: ['Ctrl+M'],
    owner: 'library',
    rebindable: false,
    note: 'CodeMirror’s accessibility escape hatch, kept intact because Tab indents in this editor. Electron’s default menu also binds Ctrl+M to Minimize, and the menu wins — see the collisions section.',
  },

  // --- Annotate -----------------------------------------------------------
  {
    id: 'doodle.undo',
    surface: 'doodle',
    label: 'Undo the last mark',
    defaults: ['Ctrl+Z'],
    owner: 'app',
    rebindable: true,
    note: 'The way to take back an annotation, since Escape on this surface COMMITS rather than cancels. While a caption caret is open the textarea keeps its own Ctrl+Z — undo there means "undo my typing".',
  },
  {
    id: 'doodle.commitText',
    ladders: ['escape', 'enter'],
    surface: 'doodle',
    label: 'Finish the caption you are typing',
    defaults: ['Escape', 'Ctrl+Enter'],
    owner: 'app',
    rebindable: false,
    note: 'Escape COMMITS here, because nothing in this app’s Escape ladder destroys work. Ctrl+Enter matches the composer’s "modifier plus Enter finishes this".',
  },
] as const;

/** Lookup by id. Built once; the registry is a constant. */
const BY_ID = new Map(SHORTCUTS.map((spec) => [spec.id, spec]));

export function shortcutById(id: string): ShortcutSpec | undefined {
  return BY_ID.get(id);
}

/** The registry's ids, in declaration order. */
export function shortcutIds(): string[] {
  return SHORTCUTS.map((spec) => spec.id);
}

/** Every spec on one surface, in declaration order. */
export function shortcutsForSurface(surface: ShortcutSurface): ShortcutSpec[] {
  return SHORTCUTS.filter((spec) => spec.surface === surface);
}

// ---------------------------------------------------------------------------
// What may not be bound, and why
// ---------------------------------------------------------------------------

/**
 * Chords a user must never be able to take away from their own shell.
 *
 * These are refused on every surface a terminal can be behind
 * ({@link reachesAShell}) and permitted elsewhere — `Ctrl+S` is the case that
 * proves the rule, since it is XOFF at a shell and Save on the Files tab, which
 * has no shell.
 *
 * All of them are BARE Ctrl chords, and that is not an oversight: a terminal
 * encodes Ctrl+letter as a single control byte and has no way to express
 * Ctrl+SHIFT+letter at all, which is why every app chord in this repo that sits
 * next to a terminal wears Shift. Ctrl+Shift+C is therefore fine while Ctrl+C
 * is not, and the two are genuinely different keys as far as the shell is
 * concerned.
 *
 * The list is deliberately short. It covers being unable to STOP, EXIT, SUSPEND
 * or UNFREEZE a program, and being unable to reach tmux at all — the four ways
 * a user gets locked out of their own session with no keyboard route back.
 * Keys that merely annoy (Ctrl+R’s reverse search, Ctrl+U’s kill-line)
 * are not here: refusing those would be this app deciding how somebody edits
 * their command line.
 */
export const RESERVED_CHORDS: readonly { chord: string; why: string }[] = [
  { chord: 'Ctrl+C', why: 'SIGINT — the only way to stop a running program.' },
  { chord: 'Ctrl+D', why: 'End of input — the only way to exit a shell or a REPL.' },
  { chord: 'Ctrl+Z', why: 'SIGTSTP — suspends the foreground job.' },
  { chord: 'Ctrl+B', why: 'tmux’s default prefix. Without it there is no tmux.' },
  {
    chord: 'Ctrl+A',
    why: 'The other tmux prefix in common use, and readline’s beginning-of-line.',
  },
  { chord: 'Ctrl+\\', why: 'SIGQUIT — the stop that works when SIGINT does not.' },
  {
    chord: 'Ctrl+S',
    why: 'XOFF. Freezes the terminal, and Ctrl+Q is the only way back.',
  },
  { chord: 'Ctrl+Q', why: 'XON — the way back out of a frozen terminal.' },
] as const;

/**
 * Accelerators Electron's DEFAULT application menu binds, split by whether the
 * renderer can take them back.
 *
 * This app builds no menu, so every one of these is live and none of them was
 * declared here. Read out of the shipped binary rather than remembered
 * (`electron 33.3.1`, `node_modules/electron/dist/electron.exe`).
 *
 * The split is the useful part, and it is the difference between two bug
 * classes this repo has already paid for:
 *
 *   - EDITING roles (`undo`, `redo`, `cut`, `copy`, `paste`,
 *     `pasteAndMatchStyle`, `selectAll`) act on whatever holds focus, and a
 *     cancelled keydown suppresses them. That is measured, not assumed: it is
 *     exactly what `preventDefault()` fixed in the doubled-paste bug. So these
 *     are BINDABLE, with the standing requirement that the handler cancels the
 *     event.
 *   - WINDOW and APP roles (`close`, `quit`, `minimize`, `reload`,
 *     `forceReload`, `toggleDevTools`, `togglefullscreen`) are handled by the
 *     menu itself, and `preventDefault()` in the renderer does not reach it.
 *     Binding an app command to one of these gets you the command AND the role
 *     — the window closes, the page reloads — so they are refused.
 *   - ZOOM roles are a third case: the app already disarmed them from the main
 *     process, and the chords now belong to `zoom.in`/`zoom.out`/`zoom.reset`.
 *     Refused because they are taken, not because they cannot work.
 */
export const MENU_CLAIMED_UNSUPPRESSIBLE: readonly { chord: string; role: string }[] = [
  { chord: 'Ctrl+W', role: 'close — shuts the window. readline wants it for delete-word.' },
  { chord: 'Ctrl+Q', role: 'quit — exits the app.' },
  { chord: 'Ctrl+M', role: 'minimize.' },
  { chord: 'Ctrl+R', role: 'reload — throws away the whole renderer, terminals included.' },
  { chord: 'Ctrl+Shift+R', role: 'forceReload.' },
  { chord: 'Ctrl+Shift+I', role: 'toggleDevTools.' },
  { chord: 'F12', role: 'toggleDevTools.' },
  { chord: 'F11', role: 'togglefullscreen.' },
] as const;

/** Menu roles a cancelled keydown DOES suppress. Bindable; see the note. */
export const MENU_CLAIMED_SUPPRESSIBLE: readonly { chord: string; role: string }[] = [
  { chord: 'Ctrl+Z', role: 'undo' },
  { chord: 'Ctrl+Y', role: 'redo' },
  { chord: 'Ctrl+X', role: 'cut' },
  { chord: 'Ctrl+C', role: 'copy' },
  { chord: 'Ctrl+V', role: 'paste' },
  { chord: 'Ctrl+Shift+V', role: 'pasteAndMatchStyle' },
  { chord: 'Ctrl+A', role: 'selectAll' },
] as const;

/**
 * Chords the zoom commands already own.
 *
 * Both spellings of the shifted `=` are here — `Ctrl+Shift+=` as a config file
 * would write it, `Ctrl+Shift++` as a real keypress reports it — because Shift
 * changes `key` for punctuation and the capture field produces the second one.
 * Missing that is how a user would be allowed to bind something to a chord that
 * then silently lost to zoom.
 */
const ZOOM_OWNED = new Set([
  'Ctrl+=',
  'Ctrl++',
  'Ctrl+Shift+=',
  'Ctrl+Shift++',
  'Ctrl+-',
  'Ctrl+0',
]);

/**
 * Keys whose modifiers xterm folds into a CSI parameter rather than dropping.
 *
 * This is the set that makes `Ctrl+Shift+<arrow>` a REAL key at a terminal:
 * `evaluateKeyboardEvent` reaches `case 38` long before any ctrl branch and
 * emits `ESC [ 1 ; <mods+1> A`, so Ctrl+Shift+Up is `ESC [ 1 ; 6 A`, which vim
 * and tmux both read.
 */
const CSI_MODIFIED_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Delete',
  'Insert',
]);

/**
 * Whether a terminal could have encoded this chord at all.
 *
 * Not a refusal — an ANNOTATION. A chord a shell can never receive is a chord
 * this app can claim for free, and saying so beside a binding answers the first
 * question a terminal user has when an app takes a Ctrl chord: what did I just
 * lose?
 *
 * ---------------------------------------------------------------------------
 * THE PREMISE THIS FUNCTION WAS ASKED TO ENCODE IS FALSE, AND SAYING SO IS THE
 * POINT OF HAVING IT IN CODE
 * ---------------------------------------------------------------------------
 * The tab chords were briefed as affordable because "terminals cannot encode
 * most Ctrl+digit or Ctrl+Tab". Measured against the xterm this app actually
 * ships — @xterm/xterm 6, `src/common/input/Keyboard.ts::evaluateKeyboardEvent`
 * — that is not true:
 *
 *   - `Ctrl+Tab` is `HT`. `case 9` is reached before the ctrl branch and is
 *     gated only on Shift, so Ctrl is simply ignored: Tab produces `	` and
 *     Ctrl+Shift+Tab produces `ESC [ Z`. At a shell prompt that is completion.
 *   - `Ctrl+3`..`Ctrl+8` are C0 controls — keyCodes 51-55 map to
 *     `ESC`, `FS`, `GS`, `RS`, `US`, and 56 to `DEL`. `Ctrl+3` in particular is
 *     a widely used stand-in for Escape. Only `Ctrl+1`, `Ctrl+2` and `Ctrl+9`
 *     genuinely encode nothing.
 *   - `Ctrl+Shift+<arrow>` is a modified CSI sequence, not nothing.
 *   - `Ctrl+Shift+2` is `@` is `NUL`, and `Ctrl+Shift+-` is `_` is `US` — those
 *     two run in a branch matched on the CHARACTER, after Shift has changed it.
 *     `zoomKeys.ts` already refuses `Ctrl+Shift+-` as a zoom-out spelling for
 *     exactly this reason.
 *
 * What IS free is `Ctrl+Shift+<letter>`: every branch that could encode it
 * demands `!ev.shiftKey`, and the character fallback demands `!ev.ctrlKey`. So
 * the app's Shift-wearing chords cost the shell nothing, and the tab chords do
 * cost it something. Both facts belong in the list rather than in a belief.
 *
 * Answered for the `Ctrl` spelling, which is the conservative one: xterm's ctrl
 * branch tests `ctrlKey` specifically, so the Cmd spelling of the same chord
 * encodes less, never more.
 */
export function terminalCanEncode(chord: Chord): boolean {
  const key = chord.key;

  // Encoded whatever is held: the modifier never reaches the branch.
  if (key === 'Tab' || key === 'Enter' || key === 'Escape' || key === 'Backspace') return true;
  // Modifiers folded into a CSI parameter. @see CSI_MODIFIED_KEYS
  if (CSI_MODIFIED_KEYS.has(key)) return true;
  if (/^F([1-9]|1[0-2])$/.test(key)) return true;

  // Alt is Meta: an ESC prefix in front of whatever the key would have been.
  if (chord.alt) return true;

  if (!chord.ctrl) return false;

  // Matched on the character, so Shift does not save these two.
  if (key === '_' || key === '@') return true;

  // Everything below is the ctrl branch, which is gated on Shift being absent —
  // which is the whole reason every app chord next to a terminal wears Shift.
  if (chord.shift) return false;
  if (key === 'Space') return true;
  if (key.length !== 1) return false;
  // A-Z -> ^A..^Z; 3-8 -> ESC FS GS RS US DEL; [ \ ] -> ESC FS GS.
  return /[A-Z3-8[\\\]]/.test(key);
}

/** Why a binding was refused. `kind` is what the UI switches on. */
export type BindingRefusal =
  | { kind: 'unknown'; message: string }
  | { kind: 'locked'; message: string }
  | { kind: 'no-modifier'; message: string }
  | { kind: 'modifier-only'; message: string }
  | { kind: 'reserved'; message: string }
  | { kind: 'menu'; message: string }
  | { kind: 'conflict'; message: string; withId: string };

/** Key tokens that are only ever a modifier — not a chord on their own. */
const MODIFIER_KEYS = new Set(['CONTROL', 'SHIFT', 'ALT', 'META', 'OS', 'ALTGRAPH', 'CAPSLOCK']);

/**
 * Whether [chord] may be bound to [id], given every other binding in force.
 *
 * Returns `null` for "yes". The refusals are ordered from the most specific
 * cause to the least, so a chord that is both reserved AND already taken is
 * reported as reserved — the user needs the reason they cannot have it at all,
 * not a suggestion that freeing the other binding would help.
 *
 * [inForce] is the RESOLVED map — defaults with overrides applied — not the
 * defaults, because a conflict against a chord the user already moved away from
 * is not a conflict.
 */
export function validateBinding(
  id: string,
  chord: Chord,
  inForce: ReadonlyMap<string, readonly Chord[]>,
): BindingRefusal | null {
  const spec = shortcutById(id);
  if (!spec) return { kind: 'unknown', message: `No shortcut is called ${id}.` };
  if (!spec.rebindable) {
    return {
      kind: 'locked',
      message:
        spec.owner === 'main'
          ? 'This chord is recognised in the main process, before the page sees the key, so it cannot be changed from here.'
          : spec.owner === 'library'
            ? 'This belongs to the editor’s own keymap, not to PocketShell.'
            : 'This one is fixed. See the note beside it for why.',
    };
  }

  if (MODIFIER_KEYS.has(chord.key.toUpperCase())) {
    return { kind: 'modifier-only', message: 'That is a modifier on its own. Hold it and press a key.' };
  }

  const spelling = chordToString(chord);

  if (ZOOM_OWNED.has(spelling)) {
    return {
      kind: 'menu',
      message: `${formatChord(chord)} is one of the zoom chords, which the main process handles before the page sees the key.`,
    };
  }

  const menu = MENU_CLAIMED_UNSUPPRESSIBLE.find((entry) => entry.chord === spelling);
  if (menu) {
    return {
      kind: 'menu',
      message: `Electron’s built-in menu owns ${formatChord(chord)} (${menu.role}) and the page cannot take it back — you would get both.`,
    };
  }

  // Checked AFTER the menu, so `F12` is reported as "the menu owns it" rather
  // than as "add a modifier" — which would be true, useless, and would send the
  // user off to try Ctrl+F12, which the menu also owns.
  //
  // Every rebindable binding sits on a surface where SOMETHING else wants the
  // keyboard — a shell, a text box, a tree. A chord with no Ctrl and no Alt is
  // therefore not a shortcut, it is a keystroke being stolen from whatever the
  // user is typing into.
  if (!chord.ctrl && !chord.alt) {
    return {
      kind: 'no-modifier',
      message: 'A shortcut needs Ctrl or Alt. Without one it would swallow ordinary typing.',
    };
  }

  if (reachesAShell(spec.surface)) {
    const reserved = RESERVED_CHORDS.find((entry) => entry.chord === spelling);
    if (reserved) {
      return {
        kind: 'reserved',
        message: `${formatChord(chord)} belongs to the shell: ${reserved.why}`,
      };
    }
    // Alt+letter is how a terminal spells Meta — it sends ESC then the letter,
    // which readline and every Emacs-flavoured editor read as a real key.
    if (chord.alt && !chord.ctrl) {
      return {
        kind: 'reserved',
        message: 'A bare Alt chord is Meta at a terminal — it sends ESC and the key, which programs read. Add Ctrl.',
      };
    }
  }

  const clash = conflictingBinding(id, chord, inForce);
  if (clash) {
    const other = shortcutById(clash)!;
    return {
      kind: 'conflict',
      withId: clash,
      message: `${formatChord(chord)} is already ${other.label} (${surfaceLabel(other.surface)}), and both are live at the same time.`,
    };
  }

  return null;
}

/**
 * The id of a binding that already holds [chord] somewhere [id] can be pressed,
 * or null.
 *
 * Split out of {@link validateBinding} so the same rule answers two questions.
 * The UI asks "may the user set this?", which stops at the first refusal and
 * never reaches the conflict check for a locked binding. The test suite asks
 * "do the SHIPPED defaults collide?", which has to run over every pair
 * including the locked ones — and that is the check that would have caught a
 * chord being chosen against a stale mental map, which is the whole reason this
 * module exists.
 */
export function conflictingBinding(
  id: string,
  chord: Chord,
  inForce: ReadonlyMap<string, readonly Chord[]>,
): string | null {
  const spec = shortcutById(id);
  if (!spec) return null;
  const spelling = chordToString(chord);
  for (const [otherId, chords] of inForce) {
    if (otherId === id) continue;
    const other = shortcutById(otherId);
    if (!other) continue;
    if (!surfacesCollide(spec.surface, other.surface)) continue;
    // Two rungs of one ladder share a chord on purpose. @see ShortcutSpec.ladders
    if (spec.ladders?.some((rung) => other.ladders?.includes(rung)) === true) continue;
    if (!chords.some((c) => chordToString(c) === spelling)) continue;
    return otherId;
  }
  return null;
}

/** The prose name of a surface, for a message. */
export function surfaceLabel(surface: ShortcutSurface): string {
  return SURFACES.find((s) => s.id === surface)?.label ?? surface;
}

/**
 * The registry's own defaults, parsed.
 *
 * Parsing rather than hand-building the objects means the default strings go
 * through the same loader a stored override does, so a typo in a default is a
 * failing test rather than a chord that silently never fires.
 * `tests/unit/shortcuts.test.ts` asserts every default parses and that the
 * defaults do not conflict with each other.
 */
export function defaultBindings(): Map<string, Chord[]> {
  const out = new Map<string, Chord[]>();
  for (const spec of SHORTCUTS) {
    const chords: Chord[] = [];
    for (const raw of spec.defaults) {
      const chord = parseChord(raw);
      if (chord) chords.push(chord);
    }
    out.set(spec.id, chords);
  }
  return out;
}

/**
 * Defaults with the user's overrides applied, per binding.
 *
 * An override REPLACES a binding's chords rather than adding to them. Every
 * rebindable entry has exactly one default, so there is nothing to merge; and a
 * user who moved a chord means the old one is free, which is the answer conflict
 * detection needs.
 *
 * Degradation is per ENTRY, like every other collection this app stores: an
 * override naming an id this build dropped, or a chord that no longer validates
 * because the registry gained a conflicting binding, falls back to that one
 * default and leaves the rest of the map alone.
 */
export function resolveBindings(overrides: Readonly<Record<string, string>>): Map<string, Chord[]> {
  const resolved = defaultBindings();
  for (const [id, raw] of Object.entries(overrides)) {
    const spec = shortcutById(id);
    if (!spec || !spec.rebindable) continue;
    const chord = parseChord(raw);
    if (!chord) continue;
    // Validated against the map AS IT IS BEING BUILT, so two overrides that
    // collide with each other cannot both land. The first one wins, which is
    // arbitrary but stable — and the UI refuses the second at the moment it is
    // set, so reaching this line at all means the file was hand-edited.
    if (validateBinding(id, chord, resolved)) continue;
    resolved.set(id, [chord]);
  }
  return resolved;
}

/**
 * The chords in force for one binding, for a call site.
 *
 * This is the function every `if (e.ctrlKey && e.key === 'x')` in the app is
 * meant to become. Falls back to the defaults for an id the caller resolved
 * before the store was ready, so a handler can never end up with NO binding and
 * silently stop working.
 */
export function chordsFor(bindings: ReadonlyMap<string, readonly Chord[]>, id: string): readonly Chord[] {
  const found = bindings.get(id);
  if (found && found.length > 0) return found;
  return defaultBindings().get(id) ?? [];
}

/**
 * Whether a key event is the binding [id].
 *
 * The shape every call site wants: one call, no chord spelled inline, and the
 * registry is the only place that knows what the chord is.
 */
export function isShortcut(
  bindings: ReadonlyMap<string, readonly Chord[]>,
  id: string,
  e: ChordKeyInput,
): boolean {
  return chordsFor(bindings, id).some((chord) => chordMatches(chord, e));
}
