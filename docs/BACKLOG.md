# Backlog

Every request made against this app, with where it landed. Kept because the
intake outran anyone's memory: requests arrived faster than they were built,
several were reported two or three times before being understood, and two were
promised and then dropped. A list in someone's head is not a list.

**Conventions.** `✅` shipped, with the commit that did it. `🔄` in progress.
`⬜` accepted but not started. `❓` open question for the user. `🔍` a finding
worth keeping that nobody asked for.

Add to the bottom of the relevant section rather than reordering — the order
is roughly the order things were asked, and that history is useful.

---

## Shipped

### Sessions and the panel

| | Request | Landed in |
|---|---|---|
| ✅ | Folder view for the session panel | `01969c8`, `b841362` |
| ✅ | Make it a real tree (`git -> folder -> session`) | `dfd8780` |
| ✅ | Register extra roots (`~/tmp`) in Settings | `dfd8780` |
| ✅ | Sessions in `other` that belong under `git/` | `61753d7`, `6fe2619` |
| ✅ | Group git worktrees under their repository | `c614e7e` |
| ✅ | Root rows should not collapse | `1d89bf4` |
| ✅ | Session grouping was invisible on a 1:1 layout | `dfd8780` |

### The folder workspace

| | Request | Landed in |
|---|---|---|
| ✅ | One row per folder; sessions become tabs | `61753d7` |
| ✅ | Drop Conversations entirely | `61753d7` |
| ✅ | Multiple Files tabs, each with its own directory | `61753d7` |
| ✅ | Create a session with a chosen agent | `61753d7`, `00eb3e7` |
| ✅ | Strip the common prefix from tab labels | `61753d7` |
| ✅ | Rename a session from its tab | `61753d7` |
| ✅ | `main` should read `Terminal`, so `Terminal 2` follows | `1d89bf4` |
| ✅ | The `+` menu did nothing (clipped by the tab strip) | `c614e7e` |
| ✅ | Clicking a tab should focus the terminal | `1d89bf4` |
| ✅ | Tab-cycling hotkeys (`Ctrl+Tab`, `Ctrl+1`..`9`) — and the discovery that xterm DOES encode them (`docs/WORKSPACE.md` §11.2) | *this pass* |
| ✅ | Agent marks per tab, from `@ps_agent_kind`; nothing at all for `unknown` | *this pass* |
| ✅ | Closing a tab selects the previously active one, via a pruned MRU stack | *this pass* |
| ✅ | Stop a session from a tab context menu — the only destructive action, confirmed | *this pass* |
| ✅ | Drag tabs to rearrange them, plus `Ctrl+Shift+PageUp`/`PageDown` | *this pass* |
| ✅ | Drop the folder name and its `×` from the tab strip ("no need for this part") | *this pass* |
| ❌ | The folder's path in the workspace header | superseded — the user deleted the element it would have lived in |
| ✅ | `docs/WORKSPACE.md` named the `main` tab label in eight places; it is `Terminal` | *this pass* |
| ✅ | Ask for harness, permissions and profile before launching | `00eb3e7` |
| ✅ | `pocketshell agent` was missing its required `--dir` | `00eb3e7` |

### The composer

| | Request | Landed in |
|---|---|---|
| ✅ | Overlay the terminal instead of taking its rows | `f82aa06`, `cf0779b` |
| ✅ | Make it a floating card | `300dc08` |
| ✅ | Movable and resizable | `38bf971` |
| ✅ | Drop the session name from it | `38bf971` |
| ✅ | Smaller toggle, icon only | `cf0779b` |
| ✅ | The toggle was almost invisible | `bc86cf7` |
| ✅ | One toggle in one place | `c0c687b` |
| ✅ | A close `✕` at the card's top right | `cf0779b` |
| ✅ | Escape closes it; `Ctrl+\`` opens it | `bc86cf7` |
| ✅ | Typing in the terminal opens it | `cf0779b` |
| ✅ | The first typed letter appeared twice | `bc86cf7` |
| ✅ | Close on send, reopen on the next keystroke | `cf0779b` |
| ✅ | Clicking outside closes it when empty | `bc86cf7` |
| ✅ | `Ctrl+V` in the terminal routes the clipboard to it | `1d89bf4` |
| ✅ | Text and arrows in the doodle surface | `298921a` |
| ✅ | Annotate an image that is already attached | _pending_ |
| ✅ | Cancelling the doodle no longer discards it silently | _pending_ |

### Files

| | Request | Landed in |
|---|---|---|
| ✅ | PDF and audio support | `4fded07`, `c9d4039` |
| ✅ | Playing an mp3 froze the app | `c9d4039` |
| ✅ | Never show binary as text — say so and offer download | `c9d4039` |
| ✅ | Open in the session's directory, not `~` | `d702342`, `3ac7abc`, `1d89bf4` |
| ✅ | Keep the directory across tab switches | `c9d4039` |
| ✅ | Syntax highlighting | `c2fe2bb` |
| ✅ | Type or paste a path to navigate | `04e2a5e` |
| ✅ | Right-click → open in a new panel | `c614e7e` |
| ✅ | Fixed-width file browser panel | `c614e7e` |
| ✅ | Breadcrumb on one line | `2f684dd` |
| ✅ | …but it over-corrected into `~ / … /v…previews / olya-…` | _pending_ |
| ✅ | Cap at 100 rows with "load more" and search | `2f684dd` |
| ✅ | Preview HTML | `384f66a` |
| ✅ | Serve a folder over HTTP | `8d17f90` |
| ✅ | Markdown preview | this change |

### Terminal and connection

| | Request | Landed in |
|---|---|---|
| ✅ | Sessions would not open; Files showed an empty directory | `db82d48` |
| ✅ | Join through the helper, not raw tmux | `f6b9887` |
| ✅ | Faster switching between sessions | `516b488` |
| ✅ | Switching still re-attached every time | `a598b7c`, `9a93590` |
| ✅ | VS Code-instant tab switching | `9a93590`, `fe5b1bd` |
| ✅ | Pasting pasted twice | `3628090` |
| ✅ | Stale rows below tmux's status bar | `1b64555` |
| ✅ | Clickable file paths in terminal output | `e1f9c75`, `04e2a5e` |
| ✅ | Write logs so failures can be diagnosed | `9a766d8` |

### Chrome, settings and appearance

| | Request | Landed in |
|---|---|---|
| ✅ | Remove the tool chips; ask to install instead | `16413b6` |
| ✅ | Remove the host topbar; host in the window title | `ca79ae2` |
| ✅ | Merge the session bar into the tab row | `38bf971` |
| ✅ | Escape should not suppress the typing intercept; the plain-terminal hatch moved to a press in the terminal (`docs/COMPOSER.md` §12.2) | *this pass* |
| ✅ | Move Ports / Usage / Settings into the panel | `c614e7e` |
| ✅ | A Settings screen | `176e92f` |
| ✅ | A default host, connected at startup | `176e92f` |
| ✅ | Font family and size | `2a52e8f`, `4c0f555` |
| ✅ | `Ctrl+=` did not zoom in | `31019f2` |
| ✅ | Zoom in Settings | `31019f2` |
| ✅ | Light theme, then multiple palettes | `448ad7a` |
| ✅ | Drop the "force a new session" checkbox | `cde5dd5` |
| ✅ | See every shortcut, grouped by surface, in Settings | this change |
| ✅ | Rebind a shortcut, with conflicts named and the shell protected | this change |
| ✅ | CodeMirror's baked `dark: true` | this change |

### Housekeeping

| | Request | Landed in |
|---|---|---|
| ✅ | Remove old code and backwards compatibility | `88cc932`, `67fdcf5` |
| ✅ | Commit regularly, in focused commits | ongoing |

---

## In progress

| | Item |
|---|---|
| 🔄 | A `+` on each root row, and one for anywhere; retire "New session" |
| 🔄 | `Ctrl+W` closes the window instead of deleting a word |
| 🔄 | CodeMirror duplicated into the installer |
| 🔄 | Point the chord handlers at the shortcut registry — they still spell chords inline (`docs/SHORTCUTS.md` §6) |

---

## Accepted, not started

| | Item | Why it is worth doing |
|---|---|---|
| ⬜ | A `serve` subcommand in the pocketshell CLI | Filed as `alexeygrigorev/pocketshell#2333`. The desktop side ships on `python3 -m http.server`; retiring that costs one function. |
| ⬜ | A durable session→folder registry | The phone has `pocketshell tree get/upsert/reconcile`. It would replace the name-and-`test -d` heuristic that currently places sessions with no reported cwd. `docs/SESSIONLIST.md` §11 has the cost estimate. |
| ⬜ | `Ctrl+W` closes the window | Electron's default menu binds it, and readline uses it for delete-word. A real hazard in a terminal app. |
| ⬜ | Launch an agent from `NewSessionDialog` | It creates shell-only sessions; launching needs a pending launch carried across a route change. |
| ⬜ | CodeMirror in `dependencies` | Duplicates ~9.6 MB of already-bundled source into the installer. Wants an electron-builder `files` exclusion. |

---

## Open questions

| | Question |
|---|---|
| ❓ | Is deleting the `switch-client` machinery right? `9a93590` removed roughly three commits of it as unreachable once tabs held live clients. Reversible. |
| ❓ | Should the directory level collapse to the first segment under a root, as the phone does? Flagged as the divergence most likely to be wrong. |
| ❓ | `isHelperMissing` still treats "no such command" as a too-old helper — now the last such shim. `67fdcf5` cut the rest. |
| ❓ | Solarized Light drifts furthest from canon; Nord's error red reads pink as text. Both are the AA-compliant versions. |

---

## Needs a manual check

| | Item |
|---|---|
| 🔍 | **No stray `python3 -m http.server` after quitting.** The serve feature relies on a channel close hanging up the process — traced through code, never observed, and it runs on a production box. |
| 🔍 | `electron-builder` was never run; the asar path for lazily-loaded CodeMirror chunks is reasoned about rather than executed. |
| 🔍 | Only Python was eyeballed for syntax highlighting; the other 40 grammars are covered headlessly. |
| 🔍 | Terminal palettes were verified as colour values, not against real `ls --color` or a tmux status line in every theme. |

---

## Findings worth keeping

Things nobody asked about that turned out to matter.

- **Every implementation of a breadcrumb that has to fit a narrow box does the two truncations in the same order, and it is the opposite of what we shipped twice.** Collapse WHOLE segments into a menu first; cut characters only out of what survives, and only out of one label. Carbon, WinUI, Spectrum ("Don't truncate multiple labels simultaneously"), Fluent, GitLab and Grafana all agree; VS Code goes further and never cuts characters at all, scrolling instead. Stacking a middle-collapse on a character-truncate is the failure `b841362` removed from the session rows and `2f684dd` reinvented in the Files breadcrumb — twice, independently, because the rule was written as "fit four cells" instead of "fit this many pixels". A cell count is tuned for one width; a drag-resizable pane has none. `docs/DESIGN.md` §5.7.1 has the ladder and the sources.
- **A running Electron instance serves the bundle it loaded at launch.** A rebuilt `out/` changes nothing for an open window. This produced a convincing false bug report: the app was sending a command that no longer existed in the source, because the instance predated the fix by fifteen minutes.
- **Four separate bugs came from geometry not reaching the far end** — the sliced status line, the font refit, the zoom refit, and stale rows below the status bar. `1b64555` gave that one owner, tracking *what the remote was last told* rather than what xterm last was.
- **The composer's chords are live on the Files tab.** `FolderWorkspaceView` mounts it once behind a `v-show` so a tab switch cannot cost a draft, and its handler is on `window` with `capture: true` — so `Ctrl+\`` there toggles a panel nobody can see. `FilesView.vue`'s own comment asserted the opposite for months. This is what a chord chosen against a mental map rather than a table looks like, and it is why `src/shared/shortcuts.ts` exists.
- **Electron's default menu binds fifteen accelerators this app never declared**, read out of the shipped binary rather than remembered. Two of them have already cost a bug (`Ctrl+=` doing nothing, `Ctrl+W` closing the window), and the useful distinction is that the *editing* roles yield to a cancelled keydown while the *window* roles do not. `docs/SHORTCUTS.md` §1.6.
- **Three bugs came from `return false` in xterm's key handler** without `preventDefault()`. It stops xterm but leaves the DOM event live, because `_keyDown` bails before calling its own `cancel()`.
- **`tmux -u` and plain `tmux` spell names differently**, per display column. That desynchronised the two halves of the session/cwd join for months of session names containing non-ASCII.
- **The session list and the cwd probe can read different tmux servers.** `6fe2619` sweeps every socket rather than assuming one.
- **`http.server` binds all interfaces when `--bind` is omitted** — the default would have published a right-clicked folder to the internet from a live box.
- **An ESM-only dependency in main is a runtime bomb that every test passes.** `marked` ships ESM only; electron-vite emits CJS for main and Electron 33 is Node 20, which predates `require(esm)`. Left in `externalizeDepsPlugin`'s default set it would have thrown `ERR_REQUIRE_ESM` the first time anyone opened a `.md` — and nothing would have caught it, because Vitest loads the same import natively and succeeds. `electron-store` had already taught this lesson once; the config now names both. The general rule: for main, **check the package's `exports` before trusting externalisation**, and treat a green unit suite as saying nothing about it.
- **The sanitiser that reads `obj[key]` reads the prototype too.** A palette payload of `{ __proto__: { '--bg': 'red' } }` has no own `--bg`, yet an index lookup returns `red` — found by a test written to assert unknown keys were dropped, which failed for a reason the test author had not thought of. Structured clone strips prototypes over IPC, so it was unreachable; it would have become reachable the first time main built one of these objects itself.
