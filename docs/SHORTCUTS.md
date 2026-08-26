# Keyboard

Every chord this app claims, where it is implemented, and what it cost.

This document exists because the user asked a question the repository could not
answer: *"i also want to see the shortcuts and make them configurable because I
asked you about them but I don't know what we have"*. That is fair criticism.
Chords accumulated one commit at a time, each justified in a comment beside the
`if` that implemented it, and several were chosen by asking "what is already
taken?" against a list that lived in a conversation rather than in the repo.

The list is now **data**, in `src/shared/shortcuts.ts`, and it is rendered
verbatim in Settings → Keyboard. This file is the reasoning behind it.

---

## 1. The audit

What was actually bound, before any of this was built. `Ctrl` means
Ctrl-or-Command everywhere: every call site in the app spells the test
`e.ctrlKey || e.metaKey`, so the distinction has never existed here.

### 1.1 The terminal pane — `TerminalView.vue`, `onCustomKey`

| Chord | Does | Note |
|---|---|---|
| `Ctrl+V` | Put the clipboard in the composer | Costs readline's `quoted-insert`. `Ctrl+Alt+V` is left alone — that is AltGr. |
| `Ctrl+Shift+V` | Put the clipboard in the composer | The same command. It used to paste into the shell; see below. |
| `Ctrl+Shift+C` | Copy the selection | Only when there is a selection; falls through otherwise. |
| *any printable key* | Opens the composer with the keystroke | Not a chord. Gated on the `typingOpensComposer` setting and on the composer being closed. |
| right-click | Paste into the shell | Not a chord, and now the ONLY route to the shell's own paste. |
| mouse-up after a drag | Copy the selection | Ditto. |

**Both paste chords go to the composer; the split is keyboard-vs-mouse, not
chord-vs-chord.** `Ctrl+Shift+V` pasted into the shell until a user reported
reaching for it and having the clipboard land there: it is the chord every
terminal emulator trains into the hand, so it is the one pressed first, and a
pane where one paste chord opens the composer while its twin feeds the shell is
not two features — it is a coin toss the user cannot call until the clipboard
has already gone somewhere, and one of those somewheres is a shell.

Both chords are cancelled with `preventDefault()`, and that is load-bearing for
both: `Ctrl+Shift+V` is `pasteAndMatchStyle` in Chromium's default menu and
`Ctrl+V` is an ordinary paste, so an un-cancelled event gets acted on a second
time by the browser — into xterm's textarea before, into the composer's draft
now. Measured in Electron as two writes for one keypress (`3628090`).

`onCustomKey` also *declines* the tab chords (§1.2) so that a pane mounted
outside a folder workspace cannot turn one into shell input.

Plus xterm's own `Shift+PageUp` / `Shift+PageDown`, which scroll the pane's
buffer, and — since the tab-move chord was removed — `Ctrl+Shift+PageUp` /
`PageDown` as well. Not this app's.

### 1.2 Tabs — `FolderWorkspaceView.vue`, `onWindowKeydown`

One `keydown` on `window` in **capture**, so the chord works with focus in the
terminal, the file tree or the composer alike — three different keyboard owners
that would otherwise need three implementations of one gesture.

| Chord | Does |
|---|---|
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab; wraps; Files tabs included |
| `Ctrl+1`..`Ctrl+9` | Jump to that tab; out of range does nothing |
| `Ctrl+Shift+PageUp` / `PageDown` | Move the active tab |

### 1.3 The Files tab — `FilesView.vue`, `onKeydown`

| Chord | Does |
|---|---|
| `Ctrl+S` | Save the open file (only when dirty) |
| `Ctrl+L` | Put the caret in the path bar |
| `Ctrl+F` | Focus the tree filter |

Plus, inside the tree's own two fields (`FileTree.vue`): `Enter` commits,
`Escape` cancels, blur cancels.

Plus CodeMirror's entire `defaultKeymap` + `historyKeymap` + `indentWithTab`
inside an open file (`CodeEditor.vue`). That is a keymap this app configures but
does not write; the two entries that matter to a reader are `Ctrl+Z` / `Ctrl+Y`
for undo/redo and `Ctrl+M` for the tab-focus escape hatch (which Electron's
menu also claims — see §3).

### 1.4 The prompt composer — `PromptComposer.vue`

Window-level, `capture: true`, registered in `onMounted` (`onGlobalKey`):

| Chord | Does |
|---|---|
| `Ctrl+\`` | Toggle the composer |
| `Ctrl+Shift+K` | Toggle the composer |
| `Ctrl+Shift+Up` | Grow — costs `ESC [ 1 ; 6 A` at the pane; see §3.4 |
| `Ctrl+Shift+Down` | Shrink, and close past `docked` |
| `Ctrl+Shift+A` | Attach a file |

In the draft textarea (`onDraftKeydown`):

| Chord | Does |
|---|---|
| `Enter`, `Ctrl+Enter` | Send |
| `Shift+Enter` | Newline |
| `Ctrl+Shift+Backspace` | Discard the draft |
| `Escape` | The ladder: close the slash dropdown, else close the panel |
| `Up` / `Down` / `Tab` / `Enter` | Move and accept in the slash-command dropdown, while it is open |

### 1.5 The annotate surface — `DoodleCanvas.vue`

| Chord | Does |
|---|---|
| `Ctrl+Z` | Undo the last mark |
| `Escape` | **Commits** the open caption (this app's Escape never destroys work) |
| `Ctrl+Enter` | Commits the open caption |

### 1.6 Everywhere

| Chord | Does | Where |
|---|---|---|
| `Ctrl+=`, `Ctrl++`, `Ctrl+Shift+=`, keypad `+` | Zoom in | `before-input-event` in main, decided in `zoomKeys.ts` |
| `Ctrl+-`, keypad `-` | Zoom out | ditto |
| `Ctrl+0`, keypad `0` | Reset zoom | ditto |
| `Ctrl+Shift+W` | Close the window | `before-input-event` in main, decided in `windowKeys.ts` |
| `Ctrl+Shift+I` | Toggle DevTools | ditto |
| `Escape` | Close the panel in front | `OverlayPanel.vue`, `PopupMenu.vue` |

The two `Ctrl+Shift+` chords are new, and they exist because §1.7's menu is
gone. Both were admitted on the same test: driven against the real xterm, each
produces **nothing** at the terminal (`onData` is empty), so claiming them costs
the shell no key. Anything matched in `before-input-event` is taken from the
terminal *everywhere*, because `preventDefault()` there suppresses the page's
keydown as well as the accelerator — which is why that test is the entry
requirement rather than a nicety.

### 1.7 Electron's default menu — bound, never declared, now removed

**This app built no menu**, so every accelerator Electron's default menu
carried was live and none of it appeared anywhere in this repo. That is not a
footnote: `Ctrl+=` silently did nothing for months because the default `zoomin`
role carries `CommandOrControl+Plus` and Electron parses `Plus` as *shifted*
`=`; and `Ctrl+W` closed the window where readline expects delete-word.

The role table, read out of the shipped binary rather than remembered
(`node_modules/electron/dist/electron.exe`, electron 33.3.1):

```
CommandOrControl+W   close          CommandOrControl+A   selectAll
CommandOrControl+Q   quit           CommandOrControl+X   cut
CommandOrControl+M   minimize       CommandOrControl+C   copy
CmdOrCtrl+R          reload         CommandOrControl+V   paste
Shift+CmdOrCtrl+R    forceReload    Shift+CommandOrControl+V  pasteAndMatchStyle
Ctrl+Shift+I / F12   toggleDevTools CommandOrControl+Z   undo
Alt+Command+I        toggleDevTools Control+Y            redo (Windows)
F11                  togglefullscreen
CommandOrControl+0 / +Plus / +-     resetZoom / zoomIn / zoomOut
```

Not all of that is live on Windows, and the difference matters. Walking the
real `Menu.getApplicationMenu()` of a running window shows the *default menu*
carries a subset: `File > Exit` has **no** accelerator (Alt+F4 is the platform's
job), DevTools is `Ctrl+Shift+I` only, and `cut`, `copy` and `paste` carry
`registerAccelerator: false` — Electron draws them and registers no key,
because Chromium's editor owns those chords already.

**The whole menu is now gone on Windows and Linux** —
`Menu.setApplicationMenu(null)` in `src/main/index.ts`, with the reasoning in
`src/shared/windowKeys.ts`. darwin keeps its menu: there the chord is `Cmd+W`,
which is the platform convention, and the app menu carries Quit/Hide/Services.

What that changed, measured chord by chord against the real xterm:

| Chord | In the terminal | Everywhere else, before | Now |
|---|---|---|---|
| `Ctrl+W` | `` — xterm cancelled the keydown, so the menu never saw it | **closed the window** | reaches the focused element; nothing closes |
| `Ctrl+M` | `
` | minimised the window | reaches the focused element |
| `Ctrl+R` | `` | reload (not reproduced in a probe, but bound) | nothing |
| `F11` | `[23~` | full-screened the window | reaches the focused element |
| `Ctrl+Z` / `Ctrl+Y` / `Ctrl+X` / `Ctrl+A` | their C0 bytes | undo / redo / cut / select-all | unchanged — Chromium's editor, not the menu |
| `Ctrl+C` / `Ctrl+V` / `Ctrl+Shift+V` | `` / `` / a real paste | copy / paste | unchanged, same reason. Both `V` chords are this app's now (§1.1) and cancel their own keydown, which is what stops the menu's `paste` / `pasteAndMatchStyle` firing on top |
| `Ctrl+0` / `+Plus` / `+-` | — | zoom, behind the settings store's back | this app's own, since `31019f2` |

The load-bearing row is the first one. **The terminal was never the victim**:
xterm cancels the keydown as part of its ctrl-letter mapping, and a cancelled
keydown never reaches an accelerator. The surfaces that lost the whole app to
one keystroke were the ones with no delete-word to perform — the composer's
draft, the Files path box, the tree filter, the code editor, Settings. So the
tempting fix ("swallow `Ctrl+W` while the terminal has focus") would have
changed nothing at all.

---

## 2. The registry

`src/shared/shortcuts.ts`. One `ShortcutSpec` per binding:

```ts
{
  id:         'terminal.pasteIntoShell',   // stable; it is the key on disk
  surface:    'terminal',
  label:      'Paste into the shell',      // what it DOES, in the user's words
  defaults:   ['Ctrl+Shift+V'],
  owner:      'app' | 'main' | 'menu' | 'library',
  rebindable: true,
  note:       '…why this chord and not another…',
  ladders:    ['escape'],                  // rungs share a chord by design
}
```

`owner` is the honest half of "configurable". A chord recognised in the main
process cannot read the renderer's `localStorage`; a chord in CodeMirror's own
keymap is not ours to move. Both are still **listed**, because a key that does
something in this app is a key the user is asking about.

`Chord` is `{ ctrl, alt, shift, key }`, matched on `KeyboardEvent.key` — the
character the layout produced — for the reason `zoomKeys.ts` sets out at length.
Its stored spelling is `Ctrl+Shift+V`, modifiers in a fixed order so that one
chord has exactly one string and cannot appear twice in an override map.

### 2.1 Surfaces, and what "same surface" means

Conflict detection needs "two commands on one chord in the same surface" to be
decidable, and in this app the surfaces genuinely overlap. `SURFACE_COLLISIONS`
is the graph; it is symmetric and reflexive, and a test proves both.

| | global | workspace | terminal | composer | files | doodle |
|---|---|---|---|---|---|---|
| **global** | • | • | • | • | • | • |
| **workspace** | • | • | • | • | • | |
| **terminal** | • | • | • | • | | |
| **composer** | • | • | • | • | • | • |
| **files** | • | • | | • | • | |
| **doodle** | • | | | • | | • |

Two entries in that table are findings rather than transcription:

- **The composer is live on the Files tab.** `FolderWorkspaceView` mounts it
  once, outside the tab body, behind a `v-show`, precisely so a tab switch
  cannot cost a draft — and its handler is on `window` with `capture: true`,
  registered in `onMounted`. So `Ctrl+\`` on the Files tab toggles a panel
  the user cannot see. `FilesView.vue`'s own comment says the opposite ("not
  live on this tab, which hides the composer entirely"); the comment is wrong,
  and the call-site diff in §6 corrects it.
- **The Files tab has no terminal behind it.** Which is why `Ctrl+S` may be Save
  there and may never be anything at a shell, where it is XOFF. That asymmetry
  is the entire reason this is a graph and not "everything collides with
  everything".

### 2.2 Ladders

`Escape` is handled by the doodle's caption editor, by the composer, and by the
overlay chrome, each calling `stopPropagation` before it reaches the next one
out — so one keypress closes the innermost thing that is open. `Enter` is the
same shape: the slash dropdown takes it while open, the send handler otherwise.

Rungs share a chord **by design**, so conflict detection must not report them,
and every rung is `rebindable: false` — what makes a ladder work is the order
the handlers run in, which a chord picker cannot express.

The field is a *list* because a binding can be a rung of two ladders at once,
and one is: the doodle's caption editor finishes on `Escape` **and** on
`Ctrl+Enter`. The conflict check found that pair on its first run and reported
it as a duplicate, which is exactly the shape of question the field answers.

---

## 3. What cannot be bound, and why

Ordered from the most specific cause to the least, so a chord that is both
reserved *and* already taken reports the reason it can never be had.

### 3.1 Chords that belong to the shell

Refused on every surface that collides with `terminal`. All of them are **bare
Ctrl** chords, which is not an oversight: a terminal encodes `Ctrl+letter` as a
single control byte and has no way to express `Ctrl+Shift+letter` at all. That
is why every app chord in this repo that sits next to a terminal wears Shift,
and why `Ctrl+Shift+C` is fine while `Ctrl+C` is not.

| Chord | Why |
|---|---|
| `Ctrl+C` | SIGINT — the only way to stop a running program. |
| `Ctrl+D` | End of input — the only way to exit a shell or a REPL. |
| `Ctrl+Z` | SIGTSTP — suspends the foreground job. |
| `Ctrl+B` | tmux's default prefix. Without it there is no tmux. |
| `Ctrl+A` | The other tmux prefix in common use, and readline's beginning-of-line. |
| `Ctrl+\` | SIGQUIT — the stop that works when SIGINT does not. |
| `Ctrl+S` | XOFF. Freezes the terminal, and `Ctrl+Q` is the only way back. |
| `Ctrl+Q` | XON — the way back out of a frozen terminal. |

The list is deliberately short: it covers being unable to **stop, exit, suspend
or unfreeze** a program, and being unable to reach tmux at all. Keys that merely
annoy (`Ctrl+R`'s reverse search, `Ctrl+U`'s kill-line) are not here — refusing
those would be this app deciding how somebody edits their command line.

A **bare `Alt` chord** is refused on the same surfaces: `Alt` is Meta at a
terminal, sending `ESC` and then the key, which readline and every
Emacs-flavoured program read.

### 3.2 Accelerators Electron's menu owns

Split by whether a cancelled keydown takes them back. That split is measured,
not assumed — it is exactly what `preventDefault()` fixed in the doubled-paste
bug (`3628090`).

- **Editing roles** — `undo`, `redo`, `cut`, `copy`, `paste`,
  `pasteAndMatchStyle`, `selectAll` — act on whatever holds focus, and a
  cancelled keydown suppresses them. **Bindable**, with the standing
  requirement in §4.
- **Window and app roles** — `Ctrl+W`, `Ctrl+Q`, `Ctrl+M`, `Ctrl+R`,
  `Ctrl+Shift+R`, `Ctrl+Shift+I`, `F11`, `F12` — are handled by the menu, and
  `preventDefault()` in the renderer does not reach it. Binding a command to one
  of these gets you the command **and** the role. **Refused.**
- **Zoom roles** — already disarmed by main and already owned by
  `zoom.in` / `zoom.out` / `zoom.reset`. **Refused** because they are taken.

### 3.3 Chords that are not shortcuts

- No `Ctrl` and no `Alt`: it would swallow ordinary typing.
- A modifier pressed on its own.

### 3.4 What a terminal *can* send — and the premise that turned out false

`terminalCanEncode()` is an annotation, not a refusal: it answers "what did I
just lose?", which is the first question a terminal user has when an app claims
a Ctrl chord. The Settings list shows the answer beside every terminal and tab
binding, **both ways round**, derived from the chord currently in force rather
than written down — because rebinding changes the answer.

The tab chords were briefed as affordable because *"terminals cannot encode most
`Ctrl+digit` or `Ctrl+Tab`"*. Measured against the xterm this app actually ships
(`node_modules/@xterm/xterm/src/common/input/Keyboard.ts`,
`evaluateKeyboardEvent`), that is **false**:

| Chord | What xterm emits |
|---|---|
| `Ctrl+Tab` | `HT` — `case 9` is reached before the ctrl branch and is gated only on Shift, so Ctrl is ignored. At a prompt that is completion. |
| `Ctrl+Shift+Tab` | `ESC [ Z` (back-tab) |
| `Ctrl+3`..`Ctrl+7` | `ESC`, `FS`, `GS`, `RS`, `US` — keyCodes 51-55 map to `keyCode - 51 + 27` |
| `Ctrl+8` | `DEL` |
| `Ctrl+1`, `Ctrl+2`, `Ctrl+9` | nothing — the only free digits |
| `Ctrl+Shift+<arrow>` | `ESC [ 1 ; 6 <A-D>` — modifiers ride in the CSI parameter |
| `Ctrl+Shift+PageUp` | xterm's own scrollback, not bytes |
| `Ctrl+Shift+2` / `Ctrl+Shift+-` | `NUL` / `US` — matched on the character `@` / `_`, after Shift has changed it |
| `Ctrl+Shift+<letter>` | **nothing** |

That last row is the rule the app's chords actually rely on: every branch that
could encode a letter demands `!ev.shiftKey`, and the character fallback demands
`!ev.ctrlKey`. So `Ctrl+Shift+V`, `Ctrl+Shift+C`, `Ctrl+Shift+K` and
`Ctrl+Shift+A` really are free — and the tab chords really do cost something.
Both facts are in the list rather than in a belief. `zoomKeys.ts` had already
found one corner of this independently, which is why it refuses `Ctrl+Shift+-`
as a zoom-out spelling.

---

## 4. The non-negotiable: `preventDefault()` **and** `return false`

Wherever a chord is intercepted in the terminal, both. Three bugs came from
`return false` alone:

> xterm's `_keyDown` bails at the custom handler and, unlike `_keyPress`, never
> calls its own `cancel()`. So returning false stops **xterm** and leaves the
> DOM event live, and the browser goes on to perform its own default action.

That produced the doubled first letter (`bc86cf7`) and the doubled paste
(`3628090`). Both have regression tests —
`tests/unit/terminalTypingIntercept.test.ts` and
`tests/unit/terminalPasteChord.test.ts` — which assert `defaultPrevented`
rather than a byte count, because jsdom performs no default action and cannot
reproduce the second write. What it *can* assert is the thing that makes the
second write impossible.

Every new interception in `onCustomKey` copies that shape.

---

## 5. Persistence

`shortcutOverrides: Record<string, string>` in `src/renderer/stores/settings.ts`,
added by the store's own three-step recipe (field on `AppSettings`, entry in
`SETTING_SPECS`, control in `SettingsView.vue`).

**Only the differences are stored, never the whole table.** A stored full table
would freeze whatever shipped on the day the user first opened the screen, so a
later build that moved a chord would never reach them. Resetting a binding
therefore **deletes** its override rather than writing today's default into it:
absence is the only spelling of "whatever the app currently thinks is right".

Degradation is per entry, like every other collection this app stores. An
override naming an id this build dropped, a value that is not a chord, or one
naming a binding this build made *fixed*, costs that entry and nothing else.
Full validation — reserved chords, menu accelerators, conflicts — runs inside
`resolveBindings` while the resolved map is being built, because that is the
only point at which every other binding is known.

---

## 6. Call sites

The registry is only the truth if the handlers read it. The shape every
`if (e.ctrlKey && e.key === 'x')` becomes:

```ts
const settings = useSettingsStore();

if (isShortcut(settings.shortcutBindings, 'terminal.pasteIntoShell', e)) {
  e.preventDefault();          // AND return false, in the terminal. §4.
  void pasteFromClipboard();
  return false;
}
```

`settings.shortcutBindings` is a computed, so a rebinding takes effect on the
next keystroke rather than on the next mount. `chordsFor` falls back to the
defaults for a handler that resolved before the store was ready, so a binding
can never end up missing and silently stop working.

**Not yet wired.** Six other agents held the call-site files when this landed,
so the registry ships with the Settings list reading from it and the handlers
still spelling their chords inline. Until the diffs in the handover land, the
following still hold their own copies:

| File | Bindings |
|---|---|
| `components/TerminalView.vue` | `terminal.*`, and the declining branch for `tabs.*` |
| `views/FolderWorkspaceView.vue` | `tabs.next`, `tabs.previous`, `tabs.jumpToIndex`, `tabs.move` |
| `views/FilesView.vue` | `files.save`, `files.gotoPath`, `files.filterTree` |
| `components/PromptComposer.vue` | `composer.*` |
| `components/DoodleCanvas.vue` | `doodle.*` |
| `main/index.ts`, `shared/zoomKeys.ts` | `zoom.*` (locked; main cannot read the store) |

---

## 7. The call-site diffs

Written against the working tree at the time the registry landed. Anchored on
surrounding text rather than on line numbers, because six other agents held
these files.

Every one of them follows the same two rules:

1. **No chord is spelled inline.** `isShortcut(bindings, id, e)` is the whole
   test. That is what makes the Settings list the truth rather than a second
   copy of it.
2. **In the terminal, `preventDefault()` AND `return false`.** Both. See §4.

### 7.1 `src/renderer/components/TerminalView.vue`

The store is already imported and instantiated (`const settings =
useSettingsStore();`), so only the registry import is new.

```diff
 import { isTypingKey } from '../../shared/composerText';
+import { isShortcut } from '../../shared/shortcuts';
 import type { ConnectionId, ShellId } from '../../shared/types';
```

Declining the tab chords — the family stops being re-spelled here:

```diff
-  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'Tab' || /^[1-9]$/.test(e.key))) {
-    // Digits only without Shift — Ctrl+Shift+<digit> is a different chord and
-    // is nobody's here — while Tab takes Shift as its direction.
-    if (e.key === 'Tab' || !e.shiftKey) {
-      e.preventDefault();
-      return false;
-    }
-  }
+  // The chords are DATA (src/shared/shortcuts.ts) and this branch only declines
+  // them. Reading the registry rather than restating the family is the point:
+  // this copy and FolderWorkspaceView's are the two that would otherwise drift,
+  // and a chord chosen against a drifted copy is exactly what produced a
+  // keyboard nobody could look up.
+  //
+  // `!e.altKey` still guards the whole branch here rather than living in each
+  // chord: Ctrl+Alt is AltGr on European layouts, where the digit row carries
+  // printable characters on several of them.
+  if (
+    !e.altKey &&
+    (isShortcut(settings.shortcutBindings, 'tabs.next', e) ||
+      isShortcut(settings.shortcutBindings, 'tabs.previous', e) ||
+      isShortcut(settings.shortcutBindings, 'tabs.jumpToIndex', e))
+  ) {
+    e.preventDefault();
+    return false;
+  }
```

Paste into the shell:

```diff
-  const mod = e.ctrlKey || e.metaKey;
-  if (mod && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
+  if (isShortcut(settings.shortcutBindings, 'terminal.pasteIntoShell', e)) {
     // Same defect as the typing branch above, and the same fix: returning
```

Paste into the composer — the `!e.altKey` guard has to stay, because it is not
part of the chord. `Ctrl+Alt+V` is a *printable character* on several layouts,
not a modified `Ctrl+V`, and no chord table can express "and definitely not
AltGr":

```diff
-  if (mod && !e.shiftKey && !e.altKey && (e.key === 'V' || e.key === 'v')) {
+  if (!e.altKey && isShortcut(settings.shortcutBindings, 'terminal.pasteIntoComposer', e)) {
     e.preventDefault();
     emit('paste-into-composer');
     return false;
   }
```

Copy — **and this branch is missing its `preventDefault()`**, which is the
defect §4 is about, sitting in the same function as the three comments
explaining it:

```diff
-  if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
-    if (term?.hasSelection()) {
-      void copyToClipboard(term.getSelection());
-      return false;
-    }
-  }
+  if (isShortcut(settings.shortcutBindings, 'terminal.copySelection', e)) {
+    // Only WITH a selection, deliberately: with nothing selected the chord
+    // falls through and reaches the pane, which is the behaviour that shipped.
+    //
+    // `preventDefault()` was missing here and is the fourth instance of the
+    // same defect (bc86cf7, 3628090, and the Ctrl+V route after them):
+    // returning false stops xterm — `_keyDown` bails at the custom handler and
+    // never calls its own `cancel()` — and leaves the DOM event LIVE for
+    // Chromium to act on. Both, always.
+    if (term?.hasSelection()) {
+      e.preventDefault();
+      void copyToClipboard(term.getSelection());
+      return false;
+    }
+  }
```

`const mod = ...` is now unused; delete the line.

### 7.2 `src/renderer/views/FolderWorkspaceView.vue`

```diff
 import { useSettingsStore } from '../stores/settings';
+import { isShortcut } from '../../shared/shortcuts';
```

```diff
 function onWindowKeydown(e: KeyboardEvent): void {
   if (!e.ctrlKey && !e.metaKey) return;
   if (e.altKey) return;
   if (renaming.value !== null) return;
 
-  if (e.key === 'Tab') {
-    const next = nextWorkspaceTabId(tabs.value, activeTab.value?.id ?? null, e.shiftKey ? -1 : 1);
+  const bindings = settings.shortcutBindings;
+  const forward = isShortcut(bindings, 'tabs.next', e);
+  if (forward || isShortcut(bindings, 'tabs.previous', e)) {
+    const next = nextWorkspaceTabId(tabs.value, activeTab.value?.id ?? null, forward ? 1 : -1);
     e.preventDefault();
     e.stopPropagation();
     if (next !== null) goToTab(next);
     return;
   }
```

```diff
-  if (e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
+  if (isShortcut(bindings, 'tabs.move', e)) {
     e.preventDefault();
     e.stopPropagation();
     nudgeActiveTab(e.key === 'PageDown' ? 1 : -1);
     return;
   }
```

```diff
-  if (e.shiftKey) return;
-  // `e.key`, not `e.code`: the user pressed the character `4`, wherever their
-  // layout keeps it. `Ctrl+1`..`Ctrl+9`; there is no `Ctrl+0` because there is
-  // no zeroth tab, and clamping it to the last one is the "jump to the end"
-  // gesture nobody asked for.
-  if (!/^[1-9]$/.test(e.key)) return;
+  // `Ctrl+1`..`Ctrl+9`, from the registry. There is no `Ctrl+0` because there
+  // is no zeroth tab, and clamping it to the last one is the "jump to the end"
+  // gesture nobody asked for. Matching is on the CHARACTER, wherever the
+  // layout keeps it — the registry matches `key`, never `code`.
+  if (!isShortcut(bindings, 'tabs.jumpToIndex', e)) return;
   const target = tabIdAtIndex(tabs.value, Number(e.key) - 1);
```

### 7.3 `src/renderer/views/FilesView.vue`

The store is already imported and instantiated.

```diff
+import { isShortcut } from '../../shared/shortcuts';
```

The comment being replaced is **wrong**, and its wrongness is the reason the
registry exists — see §2.1:

```diff
 function onKeydown(e: KeyboardEvent): void {
-  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
+  const bindings = settings.shortcutBindings;
+  if (isShortcut(bindings, 'files.save', e)) {
     e.preventDefault();
     if (files.dirty) void onSave();
   }
-  // Ctrl+L is the address-bar chord everywhere else the user types a path, and
-  // nothing in this app claims it: Ctrl+S saves here, and the composer's
-  // Ctrl+` / Ctrl+Shift+K / Ctrl+Shift+Down are not live on this tab, which
-  // hides the composer entirely. The shell's own Ctrl+L (clear screen) is a
-  // TERMINAL binding and this handler only sees keys from inside the Files pane.
-  if ((e.metaKey || e.ctrlKey) && (e.key === 'l' || e.key === 'L')) {
+  // Ctrl+L is the address-bar chord everywhere else the user types a path. The
+  // shell's own Ctrl+L (clear screen) is untouched: this handler only ever sees
+  // keys from inside the Files pane.
+  //
+  // This comment used to claim the composer's chords "are not live on this tab,
+  // which hides the composer entirely". THAT IS FALSE and it was false when it
+  // was written: FolderWorkspaceView mounts the composer once, outside the tab
+  // body, behind a `v-show` — precisely so a tab switch cannot cost a draft —
+  // and its handler is on `window` with `capture: true`, registered in
+  // `onMounted`. Ctrl+backtick on this tab toggles a panel nobody can see. The
+  // registry models that overlap (`SURFACE_COLLISIONS`, composer/files) so the
+  // next chord chosen here is checked against it rather than against a comment.
+  if (isShortcut(bindings, 'files.gotoPath', e)) {
     e.preventDefault();
     treeRef.value?.editPath();
   }
   // Ctrl+F filters the TREE, not the open file: CodeEditor loads no
   // @codemirror/search extension, so nothing else in this pane claims it.
-  if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
+  if (isShortcut(bindings, 'files.filterTree', e)) {
     e.preventDefault();
     treeRef.value?.focusSearch();
   }
 }
```

### 7.4 `src/renderer/components/PromptComposer.vue`

The store is already imported and instantiated.

```diff
+import { isShortcut } from '../../shared/shortcuts';
```

```diff
 function onGlobalKey(e: KeyboardEvent): void {
   if (!(e.ctrlKey || e.metaKey)) return;
+  const bindings = settings.shortcutBindings;
 
-  // Ctrl+` — the VS Code panel chord, and the primary toggle here. Deliberately
-  // NOT a Shift chord: it is the one users already have in their fingers, and
-  // it collides with nothing the terminal needs.
-  if (!e.shiftKey && e.key === '`') {
-    onToggleRail();
-    e.preventDefault();
-    e.stopPropagation();
-    return;
-  }
-
-  if (!e.shiftKey) return;
-  const lower = e.key.toLowerCase();
-  if (lower === 'k') {
+  // Two chords for one command, so the toggle takes both ids. Which of them is
+  // the "primary" one is a fact about the registry now, not about the order of
+  // the branches here.
+  if (
+    isShortcut(bindings, 'composer.toggle', e) ||
+    isShortcut(bindings, 'composer.toggleAlt', e)
+  ) {
     onToggleRail();
-  } else if (e.key === 'ArrowUp') {
+  } else if (isShortcut(bindings, 'composer.grow', e)) {
     composer.grow();
     focusDraft();
-  } else if (e.key === 'ArrowDown') {
+  } else if (isShortcut(bindings, 'composer.shrink', e)) {
     const wasOpen = mode.value !== 'hidden';
     composer.shrink();
     // Shrinking past `docked` closes it, and a close hands focus back. Read the
     // store directly: `mode.value` was narrowed by the line above and TS cannot
     // see that `shrink()` changed it.
     if (wasOpen && composer.mode === 'hidden') emit('focus-terminal');
-  } else if (lower === 'a') {
+  } else if (isShortcut(bindings, 'composer.attach', e)) {
     void onAttachClick();
   } else {
     return;
   }
   e.preventDefault();
   e.stopPropagation();
 }
```

The `if (!e.shiftKey) return;` early exit goes with it: it was a hand-rolled
stand-in for "these are all Shift chords", which is now the chord's own
business, and keeping it would silently refuse any rebinding without Shift.

In `onDraftKeydown`:

```diff
-  if (mod && e.shiftKey && e.key === 'Backspace') {
+  if (isShortcut(settings.shortcutBindings, 'composer.discard', e)) {
     e.preventDefault();
     onDiscard();
   }
```

`Enter` / `Shift+Enter` / `Escape` and the slash-dropdown arrows stay spelled
inline. They are listed in the registry and marked fixed: `Enter` in a text box
is what a text box means, and the Escape rungs work by ORDER rather than by
chord (§2.2).

### 7.5 `src/renderer/components/DoodleCanvas.vue`

```diff
+import { useSettingsStore } from '../stores/settings';
+import { isShortcut } from '../../shared/shortcuts';
+
+const settings = useSettingsStore();
```

```diff
 function onKeydown(e: KeyboardEvent): void {
   // Ctrl/Cmd+Z only. Escape is the overlay's to handle, and it already does —
   // except while a text editor is open, where the textarea stops it first.
-  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && canUndo.value) {
+  if (isShortcut(settings.shortcutBindings, 'doodle.undo', e) && canUndo.value) {
     e.preventDefault();
     undo();
   }
 }
```

`onEditorKeydown` is untouched. Its `Escape` and `Ctrl+Enter` are ladder rungs
(§2.2) and its `Ctrl+Z` pass-through is deliberately *not* the same command —
it lets the textarea's own undo run, which means "undo my typing", not "delete
the arrow I drew a minute ago".

### 7.6 Not diffed

`src/main/index.ts` and `src/shared/zoomKeys.ts` keep their own matcher. Main
cannot read the renderer's `localStorage`, so `zoom.*` is listed and locked
rather than wired — and the four spellings of "zoom in", plus the keypad's
physical key codes, are a shape this registry deliberately does not model.
