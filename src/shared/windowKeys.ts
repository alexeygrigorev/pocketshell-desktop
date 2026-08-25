/**
 * The window chords this app claims for itself, and — by their absence — the
 * ones it hands back to the terminal.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — Ctrl+W was closing the app
 * ---------------------------------------------------------------------------
 * This app builds no menu, so every accelerator it has ever had came from
 * Electron's DEFAULT application menu. `31019f2` found that out through the
 * zoom roles; this is the rest of that table. Read out of the shipped binary
 * rather than inferred — `Menu.getApplicationMenu()` walked item by item under
 * electron 33.3.1 on Windows, printing each item's role and the accelerator
 * the role carries:
 *
 *     Window > Close            CommandOrControl+W      registerAccelerator
 *     Window > Minimize         CommandOrControl+M      registerAccelerator
 *     View   > Reload           CmdOrCtrl+R             registerAccelerator
 *     View   > Force Reload     Shift+CmdOrCtrl+R       registerAccelerator
 *     View   > Toggle DevTools  Ctrl+Shift+I            registerAccelerator
 *     View   > Toggle Full Screen  F11                  registerAccelerator
 *     View   > Actual Size / Zoom In / Zoom Out   Ctrl+0 / Ctrl+Plus / Ctrl+-
 *     Edit   > Undo / Redo      CommandOrControl+Z / Control+Y
 *     Edit   > Select All       CommandOrControl+A
 *     Edit   > Cut / Copy / Paste   Ctrl+X / Ctrl+C / Ctrl+V,
 *                                   all three registerAccelerator: FALSE
 *     File   > Exit             no accelerator at all on Windows
 *
 * That is a browser's accelerator table sitting underneath a terminal, and
 * nobody in this repo chose a single entry of it.
 *
 * ---------------------------------------------------------------------------
 * WHO WAS ACTUALLY BEING BITTEN — not the terminal
 * ---------------------------------------------------------------------------
 * The report was "Ctrl+W closes the window instead of deleting a word in the
 * shell". Half of that is wrong, and the half that is wrong is the half
 * everybody assumed. Driven against the real xterm this app ships, with the
 * default menu live and a chord injected through `sendInputEvent`:
 *
 *     bare page,  Ctrl+W  ->  window CLOSED
 *     xterm page, Ctrl+W  ->  window alive, onData ["\x17"]
 *
 * xterm cancels the keydown as part of its own ctrl-letter mapping
 * (0x17 IS readline's delete-word), and a cancelled keydown never reaches the menu's
 * accelerator table. So the terminal was already defending itself, and the
 * surfaces that were losing the window to one keystroke were the ones with no
 * delete-word to perform: the composer's draft, the Files path box, the tree
 * filter, the code editor, Settings. In a single-window app that quits when
 * its last window closes, that is an unconfirmed, un-undoable "throw away
 * every attached session" bound one key away from a text field — which is why
 * the answer is not "swallow it while the terminal has focus". The place it
 * fires is the place it must not.
 *
 * The same measurement disposes of the rest of the table. Ctrl+M is `\r` at
 * the terminal (readline's Enter) and MINIMISES the window anywhere else; F11
 * is `\x1b[23~` at the terminal and FULL-SCREENS the window anywhere else;
 * Ctrl+Z, Ctrl+Y, Ctrl+X, Ctrl+A and Ctrl+R all reach the shell as their
 * control bytes and drive Undo / Redo / Cut / Select All / Reload everywhere
 * else. Every one of those is a chord the app never claimed and cannot
 * document, because it belongs to a menu that is not ours.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WHOLE MENU GOES, AND WHAT COMES BACK
 * ---------------------------------------------------------------------------
 * `Menu.setApplicationMenu(null)` on Windows and Linux, rather than a template
 * with the offending items removed. A template would put a menu BAR back on
 * Alt in an app that deliberately shows none (`autoHideMenuBar`), and it would
 * leave the same table in place minus whichever entries someone had noticed so
 * far — this is the third collision found by a user tripping over it, after
 * the Ctrl+= zoom bug and the Ctrl+V paste report, and picking them off one at
 * a time is what produced three separate investigations.
 *
 * Measured cost of nulling it, on the two things that would actually hurt:
 *
 *   - Cut / Copy / Paste in an ordinary text field are UNAFFECTED, and the
 *     role table says why before the measurement does — all three carry
 *     `registerAccelerator: false`, meaning Electron draws them in the menu
 *     and never registers a key for them; Chromium's editor owns those chords.
 *     Confirmed both ways: with the menu nulled, Ctrl+V still pastes into an
 *     `<input>`, Ctrl+A still selects all in it, and Ctrl+Shift+V still fires
 *     a real `paste` event on xterm's textarea (that is the chord that pastes
 *     into the shell, and it had to keep working).
 *   - Zoom is unaffected because this app already owns it: main recognises the
 *     chords in `before-input-event` and the renderer's settings store applies
 *     them. See src/shared/zoomKeys.ts.
 *
 * What deliberately does NOT come back: Reload and Force Reload (Ctrl+R is
 * readline's reverse-i-search, and reloading the renderer of a terminal app is
 * a destructive act with no confirmation), Minimize (Ctrl+M is Enter at a
 * shell; the title bar and Win+Down still minimise), and Full Screen (F11 is a
 * function key the terminal sends; it now always reaches the shell). Each of
 * those is a collision FIXED by removing the menu, so re-binding it here would
 * be re-breaking it — anything matched below is taken from the terminal
 * everywhere, because `preventDefault()` on `before-input-event` suppresses the
 * page's keydown as well as the menu shortcut.
 *
 * Two things do come back, and both were checked against real xterm first:
 * `Ctrl+Shift+W` and `Ctrl+Shift+I` produce NOTHING at the terminal (onData
 * []), so claiming them costs the shell nothing.
 *
 * ---------------------------------------------------------------------------
 * macOS
 * ---------------------------------------------------------------------------
 * The default menu STAYS on darwin and none of this applies there. The chord
 * in question is `CommandOrControl+W` — Cmd+W on a Mac, where closing a window
 * with it is the platform convention and Ctrl+W was never bound in the first
 * place. The mac application menu also carries the app's Quit/Hide/Services
 * items, which have no other home. So the platform whose accelerator was never
 * the problem keeps its menu, and Cmd+Shift+W simply becomes a second way to
 * close.
 */

/** What a matched chord means. An intent, like {@link ZoomCommand}. */
export type WindowCommand = 'close' | 'toggleDevTools';

/**
 * The fields of Electron's `before-input-event` payload this matcher reads.
 * Structural rather than imported, so the rules can be unit-tested without
 * dragging Electron into a test process — same contract as `ZoomKeyInput`,
 * plus `shift`, which is load-bearing here rather than ignored.
 */
export interface WindowKeyInput {
  /** `'keyDown'` / `'keyUp'`, in Electron's camelCase spelling. */
  type: string;
  /** The CHARACTER produced, after the layout and modifiers. */
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * The window command a key event asks for, or null for everything else.
 *
 * Shift is REQUIRED, which is the whole point: the unshifted spellings of both
 * chords are `\x17` and `\t` at a shell prompt and must reach it. `alt` is
 * excluded for the reason zoomKeys gives — Ctrl+Alt is how AltGr arrives on
 * European layouts, and a printable character must not be swallowed.
 *
 * Matching is on `key`, so it reads what the layout produced. With Shift held,
 * a letter key reports its UPPERCASE character (`'W'`), but Chromium is not
 * uniformly reliable about that across layouts and IMEs, so both cases are
 * accepted rather than assumed — the modifier test has already established
 * that this is a chord and not typing.
 */
export function windowCommandForInput(input: WindowKeyInput): WindowCommand | null {
  if (input.type !== 'keyDown') return null;
  // meta covers macOS Cmd, where this is a harmless second spelling of Cmd+W.
  if (!(input.control || input.meta) || input.alt || !input.shift) return null;

  const key = input.key.toLowerCase();
  if (key === 'w') return 'close';
  if (key === 'i') return 'toggleDevTools';
  return null;
}
