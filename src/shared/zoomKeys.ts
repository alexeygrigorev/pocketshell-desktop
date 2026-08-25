/**
 * Which zoom the user asked for, from a raw key event.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL — the Ctrl+= bug
 * ---------------------------------------------------------------------------
 * Nothing in this app ever built a menu, so every zoom shortcut that worked
 * came from Electron's DEFAULT application menu. Its roles are, verbatim from
 * the shipped bundle (electron 33.3.1, `zoomin`/`zoomout`/`resetzoom`):
 *
 *     zoomin:    accelerator "CommandOrControl+Plus",  zoomLevel += 0.5
 *     zoomout:   accelerator "CommandOrControl+-",     zoomLevel -= 0.5
 *     resetzoom: accelerator "CommandOrControl+0",     zoomLevel  = 0
 *
 * Electron parses `Plus` as SHIFTED `VKEY_OEM_PLUS` — measured, not assumed:
 * feeding the accelerator's key through `sendInputEvent` and reading it back
 * off `before-input-event` reports `{ key: '+', code: 'Equal', shift: true }`.
 * So `CommandOrControl+Plus` means Ctrl+Shift+`=` on a standard layout, and a
 * plain Ctrl+`=` — which is what almost everyone actually presses, and what
 * every browser accepts — matched nothing. Zoom out and reset were spelled
 * with unshifted characters and worked, which is exactly the asymmetry the
 * user reported: "ctrl - makes it smaller but ctrl + doesn't".
 *
 * ---------------------------------------------------------------------------
 * WHY A KEY MATCHER RATHER THAN A MENU TEMPLATE
 * ---------------------------------------------------------------------------
 * A menu item carries exactly ONE accelerator, and "zoom in" has four
 * spellings a user might reasonably produce (Ctrl+=, Ctrl+Shift+=, Ctrl++ on a
 * layout with a dedicated +, and the numeric keypad's +). Four hidden menu
 * items to express one intent is not a design; it is an accelerator table
 * turned inside out — and this app deliberately shows no menu bar, so the
 * items would exist purely as a keybinding carrier.
 *
 * `before-input-event` sees the event BEFORE the menu does, hands over
 * `key` and `code` so every spelling can be recognised in one place, and its
 * `preventDefault()` is documented to suppress the page event AND the menu
 * shortcut — which is what disarms the default menu's zoom roles. That last
 * part is not optional: while those roles are live they drive Chromium's zoom
 * DIRECTLY, behind the settings store's back, and the Settings display would
 * become a lie the moment the user pressed Ctrl+-.
 *
 * `globalShortcut` was the third candidate and is simply the wrong tool: it
 * registers with the OS and steals the chord from every other application,
 * not just from this window's menu.
 */

/** What a matched chord means. Deliberately an intent, not a value. */
export type ZoomCommand = 'in' | 'out' | 'reset';

/**
 * The fields of Electron's `before-input-event` payload this matcher reads.
 * Structural rather than imported so the rules can be unit-tested without
 * dragging Electron into a test process.
 */
export interface ZoomKeyInput {
  /** `'keyDown'` / `'keyUp'`, in Electron's camelCase spelling. */
  type: string;
  /** The CHARACTER produced, after the layout and modifiers: `'='`, `'+'`. */
  key: string;
  /** The PHYSICAL key, layout-independent: `'Equal'`, `'NumpadAdd'`. */
  code: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
}

/**
 * The zoom command a key event asks for, or null for everything else.
 *
 * Matching is on `key` — the character the layout actually produced — with
 * `code` used ONLY for the three numeric-keypad keys. That split is the whole
 * layout story: on a German keyboard `+` sits on its own key and reports
 * `key: '+'` with `code: 'BracketRight'`, so key-matching gets it right and
 * code-matching would have missed it; conversely the keypad emits `key: '+'`
 * anyway, so its codes are belt and braces rather than the primary rule.
 * Matching `code: 'Equal'` was deliberately NOT added — on a layout where that
 * physical key is not `=`, it would turn an unrelated character into zoom.
 *
 * Shift is ignored rather than required or forbidden, because `+` IS Shift+`=`
 * — the entire bug being fixed. `_` is deliberately not a zoom-out spelling
 * for the mirror-image reason: Ctrl+Shift+`-` is Ctrl+`_`, which readline
 * binds to undo, and swallowing it would break a chord inside the terminal to
 * buy a fourth way to press a key that already has three.
 */
export function zoomCommandForInput(input: ZoomKeyInput): ZoomCommand | null {
  if (input.type !== 'keyDown') return null;
  // meta covers macOS Cmd. Alt is excluded so Ctrl+Alt+<key>, which layouts
  // use as AltGr, keeps producing whatever character it produces.
  if (!(input.control || input.meta) || input.alt) return null;

  if (input.key === '+' || input.key === '=' || input.code === 'NumpadAdd') return 'in';
  if (input.key === '-' || input.code === 'NumpadSubtract') return 'out';
  if (input.key === '0' || input.code === 'Numpad0') return 'reset';
  return null;
}
