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
| ✅ | Pick the agent when starting a session from the panel — chained, with the create deferred behind BOTH answers (`docs/SESSIONLIST.md` §13a supersedes §13) | `169cf60` |
| ✅ | A search box in the folder browser | *this pass* |

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
| ✅ | Annotate an image that is already attached | `5a2f622` |
| ✅ | Cancelling the doodle no longer discards it silently | `06adbd7` |
| ✅ | Annotation text was too small to read | `fa2d510` |
| ✅ | The text tool's caret did not land where it was clicked | `fa2d510` |

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
| ✅ | …but it over-corrected into `~ / … /v…previews / olya-…` | `fffc105` |
| ✅ | Cap at 100 rows with "load more" and search | `2f684dd` |
| ✅ | Preview HTML | `384f66a` |
| ✅ | Serve a folder over HTTP | `8d17f90` |
| ✅ | Markdown preview | `435ddcf` |

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
| ✅ | Escape should not suppress the typing intercept; the plain-terminal hatch moved to a press in the terminal (`docs/COMPOSER.md` §12.2) | `de7a8c1` |
| ✅ | Move Ports / Usage / Settings into the panel | `c614e7e` |
| ✅ | A Settings screen | `176e92f` |
| ✅ | A default host, connected at startup | `176e92f` |
| ✅ | Font family and size | `2a52e8f`, `4c0f555` |
| ✅ | `Ctrl+=` did not zoom in | `31019f2` |
| ✅ | Zoom in Settings | `31019f2` |
| ✅ | `Ctrl+W` closed the window | `169cf60` |
| ✅ | Light theme, then multiple palettes | `448ad7a` |
| ✅ | Drop the "force a new session" checkbox | `cde5dd5` |
| ✅ | See every shortcut, grouped by surface, in Settings | `b36ba69` |
| ✅ | Rebind a shortcut, with conflicts named and the shell protected | `b36ba69` |
| ✅ | Drop the Ctrl+Tab / Ctrl+Shift+Tab tab cycle; keep only `Ctrl+←`/`Ctrl+→`, handing completion and back-tab back to the shell (`docs/WORKSPACE.md` §11.0b) | `7447cc4` |
| ✅ | Every chord handler reads that registry, so a rebinding takes effect on the next keystroke (`docs/SHORTCUTS.md` §6) | `86bf3dc`, `836eb6b`, `aaec2cd`, `e456a08`, `549c44b` |
| ✅ | A readline habit restored: delete-word-backward on `Ctrl+W` in text fields, with bash's semantics and the terminal's `\x17` untouched (`docs/SHORTCUTS.md`, `text.deleteWordBackward`) | `10276a3` |
| ✅ | CodeMirror's baked `dark: true` | `435ddcf` |

### Housekeeping

| | Request | Landed in |
|---|---|---|
| ✅ | Remove old code and backwards compatibility | `88cc932`, `67fdcf5` |
| ✅ | Commit regularly, in focused commits | ongoing |
| ✅ | CodeMirror duplicated into the installer | `169cf60` |
| ✅ | `keytar` and `ssh2-sftp-client` shipped without a single import | `169cf60` |

---

## In progress

_Nothing._ The two items that sat here moved up: the root-row `+` landed
earlier (`4c4b9bf`) and the chord handlers now read the shortcut registry
(`86bf3dc`, `836eb6b`, `aaec2cd`, `e456a08`, `549c44b`), which is why
`docs/SHORTCUTS.md` §6 no longer says "Not yet wired".

---

## Accepted, not started

| | Item | Why it is worth doing |
|---|---|---|
| ⬜ | A `serve` subcommand in the pocketshell CLI | Filed as `alexeygrigorev/pocketshell#2333`. The desktop side ships on `python3 -m http.server`; retiring that costs one function. |
| ⬜ | A durable session→folder registry | The phone has `pocketshell tree get/upsert/reconcile`. It would replace the name-and-`test -d` heuristic that currently places sessions with no reported cwd. `docs/SESSIONLIST.md` §11 has the cost estimate. |

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
| ✅ | ~~`electron-builder` was never run; the asar path for lazily-loaded CodeMirror chunks is reasoned about rather than executed.~~ Run, and executed: the packaged `win-unpacked` build boots from `app.asar`, and `import('./assets/toml-*.js')` inside it resolves and returns the grammar. Same run confirmed `Menu.getApplicationMenu()` is `null`, `Ctrl+W` leaves the window open and `Ctrl+Shift+W` closes it. |
| 🔍 | Only Python was eyeballed for syntax highlighting; the other 40 grammars are covered headlessly. |
| 🔍 | Terminal palettes were verified as colour values, not against real `ls --color` or a tmux status line in every theme. |
| ✅ | ~~**The panel→agent chain is only half-wired until `FolderWorkspaceView` collects the parked launch.** The picker, the deferred commit and the handoff slot are in and unit-tested; the ~20-line collector in `FolderWorkspaceView.vue` was written but not applied (another agent held the file). Until it lands, choosing an agent from the panel creates the session and parks a launch nobody takes — a plain shell, which is what it would have been anyway.~~ Landed complete in `169cf60` — verified: `takeAgentLaunch(...)` runs in `FolderWorkspaceView.vue`, covered by `tests/unit/pendingAgentLaunch.test.ts`. |

---

## Findings worth keeping

Things nobody asked about that turned out to matter.

- **Every implementation of a breadcrumb that has to fit a narrow box does the two truncations in the same order, and it is the opposite of what we shipped twice.** Collapse WHOLE segments into a menu first; cut characters only out of what survives, and only out of one label. Carbon, WinUI, Spectrum ("Don't truncate multiple labels simultaneously"), Fluent, GitLab and Grafana all agree; VS Code goes further and never cuts characters at all, scrolling instead. Stacking a middle-collapse on a character-truncate is the failure `b841362` removed from the session rows and `2f684dd` reinvented in the Files breadcrumb — twice, independently, because the rule was written as "fit four cells" instead of "fit this many pixels". A cell count is tuned for one width; a drag-resizable pane has none. `docs/DESIGN.md` §5.7.1 has the ladder and the sources.
- **A running Electron instance serves the bundle it loaded at launch.** A rebuilt `out/` changes nothing for an open window. This produced a convincing false bug report: the app was sending a command that no longer existed in the source, because the instance predated the fix by fifteen minutes.
- **Four separate bugs came from geometry not reaching the far end** — the sliced status line, the font refit, the zoom refit, and stale rows below the status bar. `1b64555` gave that one owner, tracking *what the remote was last told* rather than what xterm last was.
- **The composer's chords are live on the Files tab.** `FolderWorkspaceView` mounts it once behind a `v-show` so a tab switch cannot cost a draft, and its handler is on `window` with `capture: true` — so `Ctrl+\`` there toggles a panel nobody can see. `FilesView.vue`'s own comment asserted the opposite for months. This is what a chord chosen against a mental map rather than a table looks like, and it is why `src/shared/shortcuts.ts` exists.
- **Electron's default menu binds fifteen accelerators this app never declared**, read out of the shipped binary rather than remembered. Two of them have already cost a bug (`Ctrl+=` doing nothing, `Ctrl+W` closing the window), and the useful distinction is that the *editing* roles yield to a cancelled keydown while the *window* roles do not. `docs/SHORTCUTS.md` §1.6.
- **The terminal was never the victim of `Ctrl+W`; every other surface was.** Driven against the real xterm with the default menu live: on a plain page `Ctrl+W` closed the window, and on an xterm page the window survived and the shell got `\x17`. xterm cancels the keydown as part of its ctrl-letter mapping, and a cancelled keydown never reaches an accelerator — so the pane everybody worried about was already defending itself, while the composer draft, the Files path box, the tree filter and the code editor were losing the whole app to one keystroke. A fix scoped "only while the terminal has focus" would have changed nothing at all. The same measurement says `Ctrl+M` minimises and `F11` full-screens everywhere except the terminal, for the same reason.
- **`registerAccelerator: false` is why disarming the menu is safe.** Electron's `cut`, `copy` and `paste` roles carry that flag: the item is drawn in the menu and *no key is registered for it*, because Chromium's editor owns those chords. So removing the application menu costs a text field nothing — measured, with the menu nulled: `Ctrl+V` still pastes into an `<input>`, `Ctrl+A` still selects all, and `Ctrl+Shift+V` still fires a real `paste` on xterm's textarea. It also means the menu was never a suspect in the `Ctrl+V`-to-composer report, however much it looked like one.
- **`files: out/**/*` ships whatever is lying in `out/`.** It is a gitignored scratch directory, and by the time anyone looked it had collected `tsbuildinfo/` (incremental TypeScript state, carrying absolute paths from the build machine) and `probe-async/` — 3 MB, a whole second copy of the renderer bundle left behind by a debugging session. Both were going out to users. The `files` list now names the three directories electron-vite actually emits.
- **The packaged app opens `node_modules` for exactly one package.** `ssh2`, and nothing else: everything the renderer imports is compiled into `out/renderer`, and `electron-store` and `marked` are bundled into main's chunk on purpose. So `dependencies` is not a description of what the app uses — it is a list of what gets copied into the installer, and the two had drifted by ~22 MB of package tree plus a native module (`keytar`) that no line of this app imports. Measured on real `electron-builder` runs, Windows nsis: **`app.asar` 42.19 MB → 4.67 MB**, `win-unpacked` 310 MiB → 273 MiB, **installer 89,250,784 B → 82,807,482 B** (−6.1 MiB; the installer moves least because NSIS was LZMA-compressing that duplicated source rather well).
- **Two modals stacked is one Escape closing both.** `OverlayPanel` listens for Escape on `document` and paints at a fixed `z-index: 10`, so rendering a second one inside the first gives two live listeners and no stacking order — pressing Escape on the chained agent step would have dismissed the folder picker underneath it and thrown away the browse. Rendering the second one *instead of* the first costs nothing (the picker's state lives in refs on a component that stays mounted, and the browse position lives in the projects store) and it reads better besides: one modal at a time, Escape means "back one step". Any future dialog that wants to chain has the same choice to make, and the same answer.
- **A dialog that can NAME what it is about to create can defer creating it.** `NewSessionDialog` looked as if it had to commit before it could ask a second question, because two of its three routes (mkdir, clone) produce the folder the second question is about. It did not: `targetFolder` already predicted both paths, for the session-name preview, so the second question could be asked on the prediction and the whole commit path deferred behind it. The prediction must not be *trusted* afterwards — the host's resolved folder is what gets used — but it is enough to ask with. `docs/SESSIONLIST.md` §13a; the same move is available to any wizard that ends in one create.
- **Three bugs came from `return false` in xterm's key handler** without `preventDefault()`. It stops xterm but leaves the DOM event live, because `_keyDown` bails before calling its own `cancel()`.
- **`tmux -u` and plain `tmux` spell names differently**, per display column. That desynchronised the two halves of the session/cwd join for months of session names containing non-ASCII.
- **The session list and the cwd probe can read different tmux servers.** `6fe2619` sweeps every socket rather than assuming one.
- **`http.server` binds all interfaces when `--bind` is omitted** — the default would have published a right-clicked folder to the internet from a live box.
- **An ESM-only dependency in main is a runtime bomb that every test passes.** `marked` ships ESM only; electron-vite emits CJS for main and Electron 33 is Node 20, which predates `require(esm)`. Left in `externalizeDepsPlugin`'s default set it would have thrown `ERR_REQUIRE_ESM` the first time anyone opened a `.md` — and nothing would have caught it, because Vitest loads the same import natively and succeeds. `electron-store` had already taught this lesson once; the config now names both. The general rule: for main, **check the package's `exports` before trusting externalisation**, and treat a green unit suite as saying nothing about it.
- **Revoking a capability was quietly revoking a FACT.** `releasePreview()` cleared `openHasScripts` along with the token and the asset counts, so the toolbar's "scripts are not run" line disappeared on every Reload and on every theme re-mint — leaving a document that renders as an empty shell with nothing on screen saying why, which is the precise failure that line exists to prevent. The counts describe the render being thrown away; the two source-derived flags describe the buffer, which is still open. Reading the code did not catch it; a screenshot of the app after a theme switch did.
- **The sanitiser that reads `obj[key]` reads the prototype too.** A palette payload of `{ __proto__: { '--bg': 'red' } }` has no own `--bg`, yet an index lookup returns `red` — found by a test written to assert unknown keys were dropped, which failed for a reason the test author had not thought of. Structured clone strips prototypes over IPC, so it was unreachable; it would have become reachable the first time main built one of these objects itself.
