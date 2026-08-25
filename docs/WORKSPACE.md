# WORKSPACE.md — the folder workspace

Status: **specified and implemented in the same pass.** Everything in this
document is in `src/`; §11 lists what is deliberately still thin.

Written against commit `bfbc98b`, from a dictated brief. The user's words, in
full, because every decision below is a reading of them and a reader should be
able to check the reading:

> "For each folder that we have in the root folders, we have exactly one line —
> and then we show the sessions as different tabs. Session one is one tab,
> session two is another tab, and then we can have a tab for inspecting files,
> and we can also have multiple tabs for inspecting files. Each tab would have
> its own state. That makes the interface easier to navigate.
>
> Plus, in a particular folder workspace — we can call it a workspace — I can
> create a new session with an agent, and I can choose what agent it is. The
> tabs are always ordered: first agent sessions, then files.
>
> For agent sessions we remove the prefix — the prefix is common for them, so we
> remove it. If there is no prefix left we can call it `main`, or just
> `terminal`; if we add another one it can be `Terminal 2` or something like
> that, if it's just a number. If there is a clear name then we have a clear
> name.
>
> If I click on the tab I can rename it, and this renames the session — like
> `tmux rename-session`."

and, on a screenshot of the panel taken the same day:

> "also some sessions are not merged into one"

and, separately, about the tab this design would otherwise have had to find a
home for:

> "let's drop conversations completely - also remove it completely from the
> code"

---

## 1. What changes, in one paragraph

The session panel loses its third level. It is `root -> folder`, one row per
folder, and clicking a folder row opens a **folder workspace** in the right
pane instead of a per-session workspace. The workspace is a tab bar over one
pane: one tab per tmux session in that folder, then one or more Files tabs.
A session tab **is** a terminal — there is no sub-navigation inside it, because
the Conversation view that used to compete for that space has been deleted
outright (§9). Tab labels are the session name with the folder's derived prefix
stripped. Clicking the active tab renames it, and renames the tmux session
underneath.

---

## 2. Why the session level goes, and why this is not revision 2 coming back

`docs/SESSIONLIST.md` revision 3 (commit `dfd8780`) made the panel
`root -> folder -> session`, unconditionally, and its §1 measurement is the
reason that decision needed defending: on this user's host there were **11
folders holding 11 sessions**, a 1:1 distribution, so the folder level spent a
row per session saying nothing the session row did not already say.

Revision 3's answer was that the structure the user asked to SEE is the
deliverable, and that a tree whose nodes collapse whenever they hold one child
does not read as a tree. That answer was right **for the navigation model it
was written against**, and the navigation model is exactly what this document
changes.

The load-bearing sentence in revision 3 is this one:

> the directory row is always a header with its sessions nested beneath it, and
> it is no longer selectable: clicking it expands.

The session leaf had to exist because **it was the only way to reach a
session**. Selecting a session was a panel operation, so the panel needed a row
per session to select. That is no longer true: the folder row opens a workspace
that already contains every session in the folder, as tabs, one click away and
always visible. The leaf now spends a row on a navigation step something else
already performs.

**This is not revision 2's conditional collapse.** Revision 2 removed the
folder header *when a folder held one session* and kept it otherwise, so the
panel's shape depended on its contents and changed under the refresh timer.
The rule here is unconditional in the other direction: **there is no session
level, for any folder, whatever it holds.** A folder with four sessions renders
as one row exactly like a folder with one. The panel is always two deep. A
reader can predict its shape without knowing what is running.

The §1 measurement is not overturned and is not re-argued. It said a level must
earn its rows; the session level no longer earns them, because the tab bar took
its job. Under the same measurement, the panel now costs **11 rows for 11
sessions** instead of 22 — and the count is now stable under fan-out too: a
folder growing a fourth session costs zero extra rows in the panel.

### 2.1 What is deliberately NOT changed

- **Registered roots** (`settings.sessionRoots`, also `dfd8780`) stay exactly as
  they are, including the empty-registered-root rendering. §7 below covers what
  a folder row does when its folder has nothing in it, which is a different
  question from an empty root.
- The `other` catch-all stays, pinned last.
- Root ordering, root labels, collision disambiguation, the attached dot, the
  relative timestamp and the middle-truncating labels all stay. Everything
  `SESSIONLIST.md` §§4–10 specifies about a ROOT or a FOLDER row is untouched;
  only the child level is removed.

---

## 3. The workspace

```
+-- session panel ----+  +-- folder workspace ------------------------------+
|  v git         11   |  | [ main ] [ import ] [ Terminal 2 ] [ Files ] [+] |
|    dtc-website   2  |  +--------------------------------------------------+
|    pocketshell   3  |  |                                                  |
|    dataops       1  |  |  the active tab's pane                           |
|  > other         3  |  |                                                  |
+---------------------+  +--------------------------------------------------+
```

One workspace per FOLDER, not per session. The workspace's identity is the
folder's `directoryKey` — the home-relative path (`~/git/dtc-website`) that
`sessionGrouping.ts` already uses as the folder node's key. Home-relative for
the reason that module gives: it folds the two spellings tmux reports for one
directory into a single node, so the workspace for `~/git/foo` and the one for
`/home/alexey/git/foo` are the same workspace and not two.

### 3.1 Tab kinds

| Kind | What it is | State it owns |
|---|---|---|
| `session` | ONE tmux session, attached in a terminal | scrollback (the PTY), the composer draft |
| `files` | ONE SFTP browser | its own current directory, its own open file |

There is no third kind. There was going to be a question here — the per-session
workspace had Terminal / Conversation / Files and the Conversation view was
bound to one session, so it needed a home under a model where a session tab is
a whole session rather than a terminal. The user removed the question by
deleting the feature (§9). The tab model is simpler for it: **a session tab is
a terminal, full stop.**

### 3.2 Ordering

> "The tabs are always ordered: first agent sessions, then files."

Session tabs first, in **creation order, oldest first**; Files tabs after, in
the order the user opened them.

Creation order rather than activity order, and this is worth stating because
every other list in this app sorts by activity. A tab bar is a set of
*targets*: the user aims at a tab with the mouse, and a bar that reorders under
the refresh timer moves the target between the decision to click and the click.
The panel can sort by recency because its rows are read; the tab bar cannot,
because its rows are hit. Creation order is also what makes "session one is one
tab, session two is another tab" literally true — `sessions create` walks
`<base>`, `<base>-2`, `<base>-3` in exactly that order.

`SessionSummary.created` is what the sort reads. Note that
`parseSessionsList` sets `activity === created` (the helper's table carries
only three columns), so on a host with no enrichment the two orders coincide
anyway; the distinction matters on the hosts where it does not.

### 3.3 Labels — stripping the prefix

> "For agent sessions we remove the prefix — the prefix is common for them, so
> we remove it."

**The prefix is the folder's derived base name, not the literal longest common
prefix of the session names.** Those coincide in the normal case and diverge in
exactly the case that matters. `sessionBaseName('~/git/dtc-website', home)` is
`git-dtc-website`, and every session `tmuxctl`, the phone or this app creates
in that folder is that string or that string plus a suffix — which is *why* the
prefix is common, and the user said so ("the prefix is common for them").
Taking the literal common prefix instead would, for a folder holding
`git-dtc-website` and a hand-made session called `git-scratch`, strip `git-`
from both and label them `dtc-website` and `scratch` — inventing a shared
identity out of a coincidence of spelling.

So the rule, applied per session, given the folder's base name `B`:

| Session name | Remainder | Label |
|---|---|---|
| `B` exactly | `""` | `main` |
| `B-<rest>` | `<rest>` | `<rest>` |
| anything else | — | the session name, unchanged |

Then two rewrites over the remainder:

- **empty -> `main`.** The user offered `main` or `terminal`; `main` is picked
  because it is what tmux itself calls a first window and what the phone app's
  own screenshots show.
- **all digits -> `Terminal <n>`.** This is the user's "if we add another one it
  can be `Terminal 2` or something like that, **if it's just a number**", and it
  is not a stylistic flourish — it falls straight out of
  `freeSessionNameCommand` (`src/main/projects/commands.ts`), which produces
  `git-dtc-website-2`, `git-dtc-website-3` for extra sessions in one folder. The
  remainder of `git-dtc-website-2` is literally `2`, and a tab labelled `2`
  beside a tab labelled `import` says nothing at all. `Terminal 2` says what it
  is.

And a **non-derived name keeps its own name in full**, which is the user's "if
there is a clear name then we have a clear name". A session called
`nightly-build` sitting in `~/git/dtc-website` is not a `dtc-website` session
that happens to be here; it is a session with a name, and stripping is not
applicable to it.

### 3.4 Collisions

Two tabs may still end up with the same label — the folder's prefix is `git-foo`
and it holds both `git-foo-bar` (remainder `bar`) and a foreign session
literally named `bar`. The first occurrence in **tab order** keeps the plain
label; each subsequent one gets ` 2`, ` 3` appended.

Numbering runs in tab order rather than alphabetically so that the numbers are
stable: a new session appended to the end of the bar cannot renumber the tabs
already on it.

Note the empty-remainder case **cannot** collide with itself: two sessions with
an empty remainder would both be named exactly `B`, and tmux does not permit two
sessions with one name. So `main 2` is unreachable in practice and exists only
because the numbering is applied uniformly rather than special-cased. The user's
phrasing ("if more than one would be empty… `Terminal 2`") reads as if it could
happen; it cannot, and the `Terminal <n>` rule covers what they were actually
describing (§3.3).

### 3.5 Per-tab state

> "Each tab would have its own state."

| State | Where it lives | Keyed by |
|---|---|---|
| terminal scrollback | the xterm instance in `TerminalView` | the session name (`session-key`) |
| composer draft, attachments, caret | `stores/composer.ts` | `"<connectionId>/<sessionName>"` |
| Files cwd + open file | `stores/files.ts` remembered positions | the Files tab's own key |

All three already existed and all three already key correctly — this design
adds no new state container. The Files store's remembered position was built in
`c9d4039`/`04e2a5e` with a `sessionKey` parameter precisely so a Files tab could
remember its own directory across an unmount, and giving each Files tab a
distinct key (`files:<folderKey>:<n>`) is all that "multiple tabs for inspecting
files, each with its own state" needs. See §8 for the composer specifically.

Only the ACTIVE Files tab is mounted (`v-if`). That is not a compromise, it is
the mechanism: unmounting a Files tab parks its directory in the store under its
key, and remounting restores it. Two Files tabs are two keys, so they never see
each other's directory. The terminal is the opposite and stays mounted
(`v-show`) across tab switches for the reason `SessionWorkspaceView` already
documented: unmounting it closes the SSH shell and drops the tmux attach.

### 3.6 The file tree's width is fixed, and drag-resizable

Reported after the first build: "file browser side panel keeps changing the
width let's make it fixed."

`.file-tree` was `min-width: 260px` over an `auto` flex basis, which makes a
flex item CONTENT-sized: it grew to the longest filename in whatever directory
was open and shrank again on the way out, so the editor beside it moved on
nearly every click. It has a definite basis now, `flex: 0 0 <n>px`, with the
names middle-truncating instead of pushing the pane.

Three decisions worth recording:

- **It is resizable, not merely fixed.** A fixed width that is wrong for your
  filenames is the same complaint in a different form. The mechanism is the
  session panel's, deliberately reused: same clamp, same one-write-per-drag,
  and the same clamp-on-READ — which exists because a stored value can predate
  a change to the clamp, and a corrupt or hand-edited entry must not be able to
  strand the pane off screen.
- **It is app-level, not per Files tab.** A tab remembers its own DIRECTORY,
  because where you are browsing is a fact about that tab. How wide the pane is
  is a fact about how you like to look at files, and a per-tab width would make
  the pane jump as you moved between two Files tabs — the original complaint,
  wearing a hat. Same split the composer draws between per-session state and
  "PREFERENCES ABOUT THE TOOL".
- **It lives in `localStorage`, not the settings store.** It is a pixel width of
  a pane in this window, which is exactly what the session panel's width is, and
  that one is in `localStorage`. The settings store is for preferences a user
  sets by name in the Settings overlay; a number you reach by dragging until it
  looks right is not one.

Because the width is app-level and the truncation is `splitLabel` — the same
function the session panel and the tab bar use — there is no third truncation
style and no width that resets when a tab comes back.

### 3.7 Right-click in the file tree

The user drew an arrow from a directory row and asked for "open in new panel".

**Read as a new TAB, not a split.** Their model so far has been tabs
throughout, §3.5 already gives every Files tab its own directory memory, and a
split view is a much larger change. If a split was meant, this is cheap to
correct — say so and it becomes a layout change inside the Files tab rather
than a rework of the tab model.

The menu carries four items rather than one, because a context menu that opens
for a single action is a worse trade than the right-click itself:

| Item | Directory | File |
|---|---|---|
| Open in a new tab | tab opens standing in it | tab opens in its PARENT with the file open |
| Open here / Open in this tab | enters it | opens it in the current tab |
| Copy path | absolute path to the clipboard | same |
| Save to this computer… | *not offered* | native save dialog |

**What "open in a new tab" means for a FILE** is the one judgement call.
Seeding the tab at the file's own path would ask the SFTP layer to list a
regular file; landing in the parent with nothing open would be
indistinguishable from right-clicking the folder. So it lands in the parent AND
opens the file, which is the reading that makes the phrase true — you asked for
a panel showing that thing. It rides the existing reveal channel, the same one
a clicked path in the terminal uses, so there is one implementation of "land in
a directory and open this" rather than two.

Download is absent for a directory rather than present and inert: a recursive
transfer is not something the SFTP layer offers, and a menu item that silently
does nothing is worse than one that is not there.

**Collisions checked.** `TerminalView` binds `contextmenu` to paste, but on its
own container element — the two live in different tabs of the workspace, are
never both on screen, and neither is an ancestor of the other, so there is no
bubbling path between them. The menu takes Escape in CAPTURE and stops it, so
one press closes the menu without also dismissing the composer or reaching the
agent in the pane.

### 3.8 One `$HOME`, not two

The workspace's identity is a home-relative key, so `$HOME` is what decides
whether a folder is `~/git/foo` or `/home/me/git/foo` — and the panel and the
workspace have to agree, or a panel row opens a workspace with no tabs in it.

They did not. The panel resolved `$HOME` into a ref of its own (deliberately,
to avoid `projects.loadHome` also landing the SFTP browser on it), while
everything that reads the store got the store's copy. That was harmless while a
session route carried the session's own name; it is not harmless when the route
carries a key derived from `$HOME`.

`projects.ensureHome()` is the fix: it resolves the string and does not browse,
so the panel, the workspace and the deep-link resolver all read one value.
`loadHome` is now that plus the browse, for the dialog that wants both.

---

## 4. Renaming a tab

> "If I click on the tab I can rename it, and this renames the session — like
> `tmux rename-session`."

### 4.1 What was checked before designing this

Sessions here are created and joined through the helper, not raw tmux, so
"rename behind tmuxctl's back" is a real question rather than a formality.
Findings, each with where it was checked:

1. **There is one tmux socket and raw tmux can address it.**
   `src/shared/attachCommand.ts` carries a correction that says so explicitly:
   tmuxctl 0.4.x shells out to a bare `tmux` with no `-L`/`-S` and no
   `TMUX_TMPDIR`, and a session it created reports
   `#{socket_path} = /tmp/tmux-<uid>/default`. `sessionSwitchCommand` already
   relies on this to issue a raw `tmux switch-client`. So a raw
   `tmux rename-session` reaches the same server the helper's sessions live on.

2. **The session name IS the join key**, and it is the only one.
   `sessionAttachCommand` builds `tmuxctl '<name>'`; there is deliberately no
   fallback ladder. So a rename that produces a name `tmuxctl` cannot resolve
   makes the session unreachable from this app — the trap the brief warned
   about.

3. **The legal alphabet is `[A-Za-z0-9_-]`**, from `sanitisePart`
   (`src/shared/sessionNameParts.ts`), which is the port of tmuxctl's own
   normalisation. `.` and `:` collapse to `_` first (tmux forbids `:` outright —
   it is the window/pane separator), then any other disallowed run collapses to
   `-`, then leading/trailing `-` are stripped. `attachCommand.ts` already notes
   that tmuxctl normalises names to this set, and that a session whose name
   begins with `=` would be looked up without its first character by
   `switch-client -t`.

4. **Uniqueness is the host's answer, never the client's.**
   `sessionName.ts` says so in its header — the Kotlin removed client-side
   `-2`/`-3` disambiguation because a stale UI cache requested names that were
   already taken. `sessionExistsCommand` (`tmux has-session -t '=<name>'`, with
   the `=` forcing an exact match) is the existing probe.

5. **The recorded agent kind survives.** `@ps_agent_kind` is a *session* user
   option (`docs/ANALYSIS.md`), and tmux session options are keyed to the
   session, not its name.

6. **The attached client survives.** tmux clients track a session by id; a
   rename does not detach anything. But `TmuxClientPool` caches
   `held.session = <name>` and `isShowing(shellId, sessionName)` fences composer
   sends against it, so the pool's record has to be updated in the same
   operation or the next send is rejected as belonging to a stranger.

**Conclusion: renaming is safe, provided the app enforces the same alphabet the
join enforces and the host is the one that answers "is this name free".** It is
not safe as a free-text field. The design below is what makes it safe, and it is
the reason the rename is a service call in the main process rather than a
`send-keys` of `tmux rename-session` into the pane.

### 4.2 The mechanics

New channel `sessions:rename` -> `SessionsService.rename(connectionId, from, to)`:

1. `sanitisePart(to.trim())`; reject if the result has no `[A-Za-z0-9]`. This is
   the same predicate `resolveSessionName` uses to decide whether a user label
   is usable at all, so a name this app accepts is a name this app can derive.
2. Reject `from === to` as a no-op (not an error).
3. `tmux has-session -t '=<to>'` -> if it exists, refuse with `name-taken`. The
   host answers, not a cached list.
4. `tmux rename-session -t '=<from>' -- '<to>'`. The `=` forces the exact match
   on the SOURCE too, so renaming `api` cannot rename `api-staging`; `--` stops
   a new name beginning with `-` being read as a flag.
5. On success, update `TmuxClientPool`'s record for that connection if it is
   showing `from`.

The renderer then: migrates the composer record from the old key to the new,
re-points the active tab, and refreshes the session list.

### 4.3 The UI

Clicking the **active** tab starts an inline edit in place; clicking an inactive
tab selects it. That is the standard browser/VS Code contract for a renameable
tab and it is what makes "if I click on the tab I can rename it" not conflict
with "if I click on the tab I switch to it".

The field shows the LABEL and commits the **full session name**: the folder's
prefix is re-applied to whatever the user types, so editing `import` to
`staging` renames `git-dtc-website-import` to `git-dtc-website-staging` and the
session stays grouped with its folder. Typing over a `main` label gives
`<prefix>-<typed>`. This is the whole reason the label is a projection rather
than the name: the user edits the part that is theirs and cannot accidentally
detach the session from its folder.

Two escapes from that:

- a tab whose label IS the session name (the non-derived case, §3.3) commits the
  raw name, because there is no prefix to re-apply;
- clearing the field entirely and committing renames the session TO the bare
  prefix (`main`), when that name is free.

Illegal characters are stripped as you type, by the same `sanitisePart` the host
will apply — so what is on screen is what the session will be called, and a
rename never silently produces a different name from the one that was typed.

---

## 5. Creating a session in the workspace

> "in a particular folder workspace … I can create a new session with an agent,
> and I can choose what agent it is."

The `+` at the end of the tab bar. It does NOT open `NewSessionDialog` — that
dialog's whole job is choosing a folder (`docs` in its own header: "a session is
not named, it is PLACED"), and inside a folder workspace the folder is already
chosen.

The `+` menu has **two items, and the asymmetry between them is deliberate**:

- **New session…** — opens `LaunchSessionDialog`. The ellipsis is the usual
  promise that a dialog follows. It used to be a flat list of agent kinds that
  started one on a single click; it cannot be, because a launch has real
  choices behind it (engine, permissions, profile) and it creates something on
  the host.
- **New Files tab** — stays a **direct action**. It creates nothing on the
  host and has nothing to configure, and putting a free action behind a dialog
  would make it feel expensive.

The dialog collects the choice and creates nothing; the workspace then:

1. calls `projects:startSession` with `folder` = this workspace's folder and
   `namePolicy: 'unique'` — so the host walks `<base>-2`, `<base>-3` and the new
   tab's label is `Terminal 2`, `Terminal 3` by §3.3's digit rule;
2. when an agent was chosen, writes the line
   `src/shared/agentLaunch.ts::buildLaunchCommand` produced into the new
   session's terminal once it is attached.

Step 2 is how the kind becomes real: `@ps_agent_kind` is written **by the helper's
`pocketshell agent` wrapper at launch** (`docs/ANALYSIS.md`: "in the process that
becomes the agent"), so the desktop cannot set the kind, only start the thing
that sets it. Launching through the wrapper rather than running `claude`
directly is the difference between a session the app can classify afterwards and
one that shows up as `unknown` forever.

### 5.1 The command, and why it is captured rather than remembered

Step 2 used to write a bare `pocketshell agent <kind>`. **That never worked.**
`--dir` is REQUIRED on the helper the user runs, so every launch exited 2 with
`Error: Missing option '--dir'.`, the session came up a plain shell, and the
usage message was the only feedback. The same menu also offered **Grok**, which
0.4.44's `pocketshell agent` has no subcommand for at all
(`Error: No such command 'grok'.`).

The whole option list is therefore CAPTURED from the pinned fixture image and
committed at `tests/unit/fixtures/v0.4.44-agent-*.txt`, and
`tests/unit/agentLaunch.test.ts` asserts the builder against those files. Per
`docs/ANALYSIS.md`, a documented contract is not evidence here; a captured one
is. Re-capture whenever `ARG POCKETSHELL_VERSION` moves.

What 0.4.44 accepts:

| Flag | Note |
|---|---|
| `--dir TEXT` | **Required.** Quoted with `shellQuoteRemotePath`, not a flat single-quote, because a workspace folder can be a literal unexpanded `~/git/x` |
| `--skip-permissions` / `--no-skip-permissions` | **Defaults to ON host-side**, so only the negative is ever emitted. A no-op for `opencode`, where the control is hidden |
| `--profile TEXT` | Claude/Codex only; by display NAME (`Claude (Z.AI)` — spaces and parens, so it is quoted). Mutually exclusive with `--config-dir`, which the desktop never emits |

`SessionAgentKind` keeps `grok` — a session can BE one, and the phone launches
it through its own engine registry — but `LAUNCHABLE_KINDS` is deliberately
narrower than the badge enum: it is the three the wrapper actually has.

`NewSessionDialog` and `src/main/projects/` are reused unchanged; nothing about
folder-first creation is reimplemented. The panel's existing "New session"
button still opens the dialog, because creating a session in a folder you are
not currently looking at is still a thing people do.

**Why that is two dialogs and not one.** `NewSessionDialog` answers *which
folder*; `LaunchSessionDialog` answers *which agent*, in a folder already
chosen. Merging them would make the `+` flow re-ask a question it knows the
answer to — the friction the `+` menu existed to remove. The drift a merge
would have prevented is prevented instead by both ending at the SAME builder,
`src/shared/agentLaunch.ts`, which is the only code that knows how to spell a
flag and is pinned against the captured `--help`. A second dialog cannot invent
a second command. What `NewSessionDialog` still does NOT do is launch an agent:
its flow ends in an outcome banner and a navigation, with no attached PTY to
type into, so wiring it would mean carrying a pending launch across a route
change. Unbuilt on purpose, and the `+` inside the folder is the way to start
an agent.

---

## 6. Sessions that cannot be placed

Reported the same day, on a screenshot:

> "also some sessions are not merged into one"

with two pairs circled: `git-red-stamp-sound` (an orphan under the `git` root)
against `git-red-stamp` (inside a `red-stamp` folder), and
`git-dtc-website-import` (orphan) against `git-dtc-website` (inside
`dtc-website`).

**This is not a cosmetic complaint under this design, it is a structural
problem.** Everything here keys on the folder: one row per folder, one workspace
per folder, tabs derived from the sessions in that folder. A session whose
`SessionSummary.path` is null has no folder, so it has nowhere to live.

### 6.1 What an orphan is

`path` is null when the join between the two halves of the session list misses.
The names come from `pocketshell sessions list` (which shells out to `tmuxctl
list` -> plain `tmux list-sessions`); the paths come from our own
`tmux -u list-panes -a` probe. Commit `3ac7abc` fixed one real cause of the miss
— a tmux client not told it is on a UTF-8 terminal sanitises names per DISPLAY
COLUMN, so `café` is `caf_` on one side and `café` on the other — by adding a
lenient index keyed on a column-accurate sanitisation, and by **dropping any key
two sessions would both claim**, on the grounds that a wrong directory is worse
than a missing one.

The four orphans in the screenshot (`git-auth`,
`git-ai-engineering-field-guide`, `git-dtc-website-import`,
`git-red-stamp-sound`) all survive that fix, and none of them contains a
non-ASCII byte — so the mangling path is not what is happening to them. Their
ages are the clue worth explaining rather than ignoring: the orphans are the
RECENT sessions (2h, 3h, 4h, 19h) and everything with a folder is 23h.

Two candidate explanations remain and they are distinguished by evidence, not by
argument:

- the probe emits **no row at all** for them (they are missing from
  `list-panes -a` output), or
- the probe emits a row whose **`pane_current_path` and `session_path` are both
  empty** — which is what tmux reports for a pane whose process has exited under
  `remain-on-exit`, and which would fit the age pattern if these are sessions
  whose agent exited recently.

### 6.2 The diagnostic

`diagnoseSessionPaths` (`src/main/helper/parsers.ts`) is a pure function over the
same two inputs `mergeSessionEnrichment` takes, and `PocketshellClient.listSessions`
logs its result to `~/.pocketshell/desktop.log` whenever any session comes back
with a null path. For each such session it records: the name, whether an
enrichment row existed under the exact name, whether one existed under the
column-sanitised name, whether that sanitised key was **dropped as ambiguous**,
and whether a row existed but carried no path. It also records the enrichment
keys that matched no session at all, which is what would immediately expose a
spelling mismatch the sanitiser does not model.

**What to ask the user to paste:** the lines matching `[sessions]` in
`~/.pocketshell/desktop.log` after opening the host — on Windows,
`Select-String sessions $env:USERPROFILE\.pocketshell\desktop.log | Select-Object -Last 20`.
One line per refresh; the `unplaced` array is the whole answer.

The three cases and what each means:

| Log says | Cause | Fix |
|---|---|---|
| `probe: "absent"` | `list-panes -a` emitted nothing for it | the session has no panes, or the probe was truncated |
| `probe: "no-path"` | row present, both path columns empty | dead pane (`remain-on-exit`) — fall back to `session_path`, or accept |
| `probe: "ambiguous"` | the drop-on-collision rule fired | `3ac7abc`'s safety rule; needs a better key |

### 6.3 Placing an orphan anyway

Whatever the cause, an orphan must not vanish — it is a live session the user
can otherwise no longer reach. Two mechanisms, in order.

**First, sibling inference.** For a session with no path, look for another
session that DOES have a path and whose name is a `-`-boundary prefix of it;
the longest such match wins, and its path is adopted. So
`git-dtc-website-import` adopts `~/git/dtc-website` from `git-dtc-website`, and
`git-red-stamp-sound` adopts `~/git/red-stamp` from `git-red-stamp`. Those are
exactly the two pairs the user circled.

This is deliberately **evidence-based and not name-derived**, which is the
difference between it and `rootFromSessionName` sitting a few lines above it in
`sessionGrouping.ts`. That function recovers only the ROOT and its comment
explains why it refuses to go further: `-` is both the component separator and a
legal character inside a component, so `git-dtc-website-import` is genuinely
ambiguous between `~/git/dtc-website-import` and `~/git/dtc-website/import`, and
inventing a directory row from that guess would be worse than not having one.
Sibling inference does not guess: it only ever adopts a path that another
session is actually reporting, so it can place a session into a folder that
exists and can never conjure a folder that does not.

It can still be **wrong**, and the honest statement of when: if
`git-red-stamp-sound` really runs in `~/git/red-stamp-sound` (its own repo), the
inference files it under `~/git/red-stamp` and the correct fix is the null path,
not the grouping. The rows are marked `pathInferred` and the tab carries the
reason in its tooltip, so a wrong placement is legible rather than silent, and
§6.2's log is what settles it. The alternative — leaving the session in a bucket
the user has just complained about — is worse for the case we know is real.

**Second, a folder of one.** A session that sibling inference cannot place keeps
today's behaviour: a degenerate folder node labelled with its own session name,
filed under the root recovered from the first component of that name
(`rootFromSessionName`), or `other`. Its workspace has that one session tab and
a Files tab starting at `$HOME`, and the row's tooltip says the working
directory is unknown. It is reachable, and it is honest about what is not known.

### 6.5 Worktrees group under their repository

> "this one should be in dtc-website actually"

— about `merry-sniffing-token`, whose only session is `git-dtc-website-decisions`.

§6.6 below is kept because it was WRONG and the reasoning is worth keeping
visible. It argued that grouping by actual cwd is right and the odd-looking name
is merely cosmetic. The user has now said plainly that it does not match how
they think about their work, and they are right: `~/git/merry-sniffing-token` is
a git WORKTREE of `~/git/dtc-website`, and a worktree belongs with the
repository it is a worktree OF. That is also *why* the session carries that
name — it was created against that repo. The name was telling us the answer all
along and the grouping was ignoring it.

**Resolved by asking git, not by parsing the name.** The name cannot answer it:
`-` is both the component separator and a legal character inside a component, so
`git-dtc-website-decisions` is ambiguous between several paths — the same reason
`rootFromSessionName` refuses to invert past the first component.

**Two queries, not one, and this is the load-bearing detail.**
`--git-common-dir` alone answers "which repository is this", which would also
map every SUBDIRECTORY of a repo to its root — collapsing
`~/git/monorepo/pkg-a` and `~/git/monorepo/pkg-b` into one folder row. That is a
much bigger change than was asked for and would flatten structure people
organise on purpose. `--git-dir` is what makes it precise: for a normal checkout
the two are EQUAL at every depth, and they differ only inside a linked worktree.
Verified against git 2.53.

**No version gate.** The suggested `--path-format=absolute` needs git 2.31+ and
turns out to be unnecessary: both values are resolved by `cd`-ing to them from
the directory being asked about, which handles the absolute and relative forms
identically on any git. So there is no fallback branch and nothing to degrade.

**Wire format: `<index>::<commonDir>`, worktrees only.** The first attempt
printed `dir::gitdir::commondir` and split from both ends, on the reasoning that
only the user-named directory could contain a `::`. That reasoning is wrong —
the git answers are paths INSIDE that directory, so if it contains the delimiter
then so do they, and three path fields are unparseable in principle. The host
prints the request INDEX (digits) instead and does the equality test itself, so
exactly one ambiguous field remains, at the end, recoverable by splitting on the
first delimiter. The test written to prove the original claim is what disproved
it.

**Batched and cached.** One exec covering every not-yet-known directory, and a
per-connection cache that records NEGATIVES as well as positives — without the
negative, every ordinary checkout would be re-probed on the session store's
refresh timer, putting a git process on the user's host every few seconds
forever. Every failure path (no git, not a repo, non-zero exit, unparseable
line) leaves the directory absent from the map, which leaves the session grouped
by its own path exactly as before.

**`path` is not rewritten; `repoRoot` is a second field.** Grouping answers
"where does this work belong"; `path` answers "where is this process standing",
and for a worktree those are genuinely different places. So:

- the PANEL and the folder key use `repoRoot ?? path`;
- the FILES tab opens at `path` — a user opening files from a worktree session
  gets the worktree's contents, not the main checkout's;
- the session TAB's tooltip names the worktree whenever it differs from the
  folder, so the difference is on screen rather than a surprise.

**Composition with §6.3 checked.** Sibling inference gives a path-less session
the path of the session it is named after; that adopted path is then run through
the same worktree resolution, so an orphan adopting a worktree path lands in the
repository alongside its sibling. The two rules compose in that order and do not
fight: inference answers "where is it", worktree resolution answers "where does
that belong".

### 6.6 SUPERSEDED — the original argument that the worktree case was fine

`git-dtc-website-<...>-decisions` rendering under a folder called
`merry-sniffing-token` is what you get when a session's cwd genuinely is
`~/git/merry-sniffing-token` — a git worktree whose session name came from a
different repo. Grouping by actual cwd is right there, and this design does not
change it: the folder is where the files are, and the files are what the Files
tab and the composer's attachments act on.

What the workspace adds is one sentence of explanation rather than a
rearrangement. A session tab whose name is not derived from its folder (§3.3's
third row — it keeps its own name) gets a tooltip naming the folder it is
actually running in. That is the whole intervention: the confusion is "why is
this session here", and the answer is the path.

---

## 7. Empty states

Three of them, and they are different questions:

| What is empty | What shows |
|---|---|
| a registered ROOT with no folders | unchanged from `dfd8780` — the root header renders with its registered marker and no children |
| a FOLDER row | cannot happen: a folder node exists BECAUSE a session is in it |
| the WORKSPACE, before any tab | see below |

A folder row with no sessions is not reachable from the panel, because folder
nodes are derived from sessions. But the workspace can still end up with no
session tabs, in two ways: the last session in the folder was killed while the
workspace was open, or the user deep-linked to a folder whose sessions have
since gone.

In that state the workspace shows the folder's path, one line of prose, and the
same `+` the tab bar carries — the empty state IS the create affordance, because
there is exactly one useful thing to do. A Files tab is still offered, since
browsing a folder with nothing running in it is perfectly reasonable.

`SessionPlaceholderView` (the right pane before any folder is picked) stays as
it is, with its wording changed from "select a session to attach" to name
folders instead.

---

## 8. The composer

`stores/composer.ts` splits its state deliberately (its own §: "the split
between what is keyed and what is not is the whole design here"):

- **per session** — draft, attachments, caret, error, in-flight flags, keyed
  `"<connectionId>/<sessionName>"`;
- **app level** — open/closed/maximised and the card's geometry.

Under the folder workspace the composer is mounted **once**, outside the tab
body, and is handed the ACTIVE SESSION TAB's session name. So:

- switching between two session tabs swaps the key, which swaps the draft — the
  keyed map means switching away and back restores the prompt rather than
  destroying it, which is the property that store was built to have;
- switching to a Files tab hides the composer (`v-show`, never `v-if`) exactly
  as the per-session workspace did, so a Files detour cannot cost a draft;
- switching between two FILES tabs leaves the composer hidden and the last
  session tab's draft untouched, because nothing re-keys it;
- **a rename must migrate the record**, or the draft is orphaned under the old
  key. `composer.rekey(oldKey, newKey)` does that, and it is the one new action
  this design adds to that store.

`allowTypingToOpen()` is called on a session-tab change, for the reason its own
comment gives: a dismissal ("leave me alone") should not follow the user into a
different session, which is a different pane and very often a different intent.
A FILES-tab change deliberately does not call it — the composer is not showing
there, so there is no dismissal to reconsider.

---

## 9. Conversations are deleted

The per-session workspace had Terminal / Conversation / Files, and the
Conversation view was bound to one session (`4ba6ae9`). Under this design a
session tab is a terminal, so that view needed a new home — a per-session
sub-tab, a toggle, or a tab kind of its own. The user answered by removing it:

> "let's drop conversations completely - also remove it completely from the
> code"

Hard cut, per `docs/ANALYSIS.md` D22 (no backwards compatibility, hard cuts
only). What went, and why each piece is genuinely conversation-only rather than
merely adjacent:

| Removed | Why it was only for this |
|---|---|
| `views/ConversationView.vue` | the tab |
| `main/agents/conversation.ts` | JSONL -> `ConversationMessage[]` renderers |
| `main/agents/transcripts.ts` | the transcript-id resolver and its `--session` probe |
| `PocketshellClient.sessionConversation`, `.agentLog`, `SessionConversation` | the only callers of the above |
| `parsers.parseAgentLogJson`, `AgentLogEnvelope` | only `agentLog` parsed with them |
| `agent:log`, `agent:sessionLog` channels + handlers + preload | `agent:log` already had no renderer caller |
| the conversation half of `stores/agents.ts` | `loadForSession`, `source`, `fail`, the stale-reply guard |
| `composerSend`'s `'agent-conversation'` route and `viewingConversation` | only the Conversation tab set it |

**`agent:resumable` goes with it.** The brief left this as a judgement call: it
had no renderer caller and was deliberately kept because `PLAN.md` F14 wants a
resumable launcher and integration tests covered it. It goes, for two reasons.
`pocketshell sessions resumable` lists *resumable conversations* — it is the
same feature, entering by a different door, and "drop conversations completely"
covers it. And F14 is two features under one heading: the resumable *conversation
picker*, which is dead, and the *agent launcher*, which is alive and is being
built in §5 of this document as the `+` menu. The half that survives is the half
being built; keeping dead IPC surface for the half that does not is precisely
what D22 forbids. `parseResumableTable` and `ResumableSession` go with it, being
its only parsers.

**What is carefully NOT removed**: the usage half of `stores/agents.ts`
(`usage`, `loadUsage`) and everything under it, which `UsageView` depends on;
`parseUsageNdjson`, `UsageRow`, `UsageWindow`; `agent:profiles`, `agent:envList`,
`agent:envGet`; `parseCommandV` (a bootstrap probe that happens to share the
file); and `src/shared/agentCommands.ts`, whose `/resume` rows are slash-command
catalog entries for the composer and have nothing to do with any of this.

One thing had to be repaired rather than deleted: `agents.loading` was written
only by the conversation loader but is READ by the usage refresh button
(`UsageView.vue`, `HostWorkspaceView.vue`). `loadUsage` now owns it, so the
spinner keeps working.

One deliberate behaviour change falls out of dropping the
`'agent-conversation'` send route: a **codex** pane used to short-circuit to
that route while the Conversation tab was showing, and so got the SHORT submit
delay. It now takes the `'agent-payload'` branch and its proper 250 ms delay.
That is a fix, not a regression — the delay exists because codex's TUI needs it.

---

## 10. Routing

```
/                                   hosts
/host/:name                         folder not picked yet
/host/:name/folder/:folder          the folder workspace   (NEW)
/host/:name/folder/:folder?tab=ID   ... with a tab selected
/host/:name/session/:session        redirect resolver      (WAS the workspace)
```

`:folder` is the `directoryKey` — `~/git/dtc-website`. vue-router encodes params,
so the slashes and the `~` survive a round trip without any escaping of our own.

The old session route **does not break**. It resolves: look the session up in
the store, find its folder, and replace the current entry with that folder's
workspace with that session's tab active. If the session is not in the list (it
was killed, or the store has not loaded yet) it refreshes once and then falls
back to the host's empty state rather than a blank pane. This is a resolver, not
a compatibility shim to keep forever — but a deep link a user has in a window
they left open overnight should land somewhere sensible, and D22's "no
backwards compatibility" is about the HOST contract, not about the app's own
history stack.

The active tab is a query parameter rather than a path segment because it is a
view preference within one destination, and because a Files tab has no name that
belongs in a path. Omitting it selects the first session tab, or the first tab
of any kind when there are none.

---

## 11. What is built, and what is deliberately thin

Everything above is implemented. `npm run test:unit`, `npm run lint` and
`npm run typecheck` are green, and `npm run build` packages.

| Area | Where |
|---|---|
| tab labels, ordering, collisions, rename target | `src/shared/workspaceTabs.ts` + `tests/unit/workspaceTabs.test.ts` (23 cases) |
| the derivation the prefix comes from | `src/shared/sessionNameParts.ts` (moved out of `main/projects/sessionName.ts`, which re-exports it) |
| two-level panel | `src/renderer/components/SessionTree.vue` |
| the workspace | `src/renderer/views/FolderWorkspaceView.vue` |
| rename | `renameSessionCommand` -> `ProjectsService.renameSession` -> `projects:renameSession`, `TmuxClientPool.renamed`, `composer.rekey` |
| orphan placement + diagnosis | `inferPathsFromSiblings` / `diagnoseSessionPaths` in `src/main/helper/parsers.ts` |
| routing | `src/renderer/router.ts`, `src/renderer/views/SessionRedirectView.vue` |
| popup menus (`+`, file tree, host actions) | `src/shared/popupPlacement.ts` + `tests/unit/popupPlacement.test.ts`, `components/PopupMenu.vue`, `components/HostActionsMenu.vue` |
| worktree grouping | `gitRepoProbeCommand` -> `parseWorktreeRoots` + `tests/unit/worktrees.test.ts`; cached in `PocketshellClient.withRepoRoots` |
| file tree width + context menu | `views/FilesView.vue`, `components/FileTree.vue` |

Three things are thinner than they could be, and each is a deliberate stop
rather than an oversight:

1. **A session tab cannot be closed.** Closing a tab would have to mean killing
   a live tmux session, which is not what a tab close means anywhere else, and
   the panel has never had a kill affordance either. A second Files tab closes;
   the first does not, because it is the folder's file browser and the
   workspace would otherwise have no way to look at the folder at all.
3. **The agent launch is still fire-and-forget, but it is no longer SILENT.**
   `pocketshell agent <kind>` is written into the new session once its PTY
   exists, and nothing verifies that the wrapper then started — verifying would
   mean parsing the pane, which is the process-sniffing `@ps_agent_kind` exists
   to avoid. What was fixed is the case where the PTY never came up at all: that
   used to do nothing, forever, with no message, so "I asked for Claude and got
   a shell" had no explanation anywhere. There is now a bounded wait
   (12 s — far beyond the ~2 s a join costs on a real link) and a sentence
   naming the session and the command to run by hand.
