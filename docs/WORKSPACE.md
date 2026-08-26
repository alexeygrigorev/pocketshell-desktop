# WORKSPACE.md — the folder workspace

Status: **specified and implemented in the same pass.** Everything in this
document is in `src/`; §16 lists what is deliberately still thin.

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
underneath; right-clicking one opens a menu that can also STOP it (§14).
Sections §11-§15 are later additions to this design and are listed at the end.

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
|  v git         11   |  | [ Terminal ] [ import ] [ Terminal 2 ] [ Files ] |
|    dtc-website   2  |  +--------------------------------------------------+
|    pocketshell   3  |  |                                                  |
|    dataops       1  |  |  the active tab's pane                           |
|  > other         3  |  |                                                  |
+---------------------+  +--------------------------------------------------+
```

**The bar holds tabs and the `+`, and nothing else.** It used to trail the
folder's name and a `x` that deselected it; the user circled that end of the
strip and said "no need for this part". The name was the same fact three times
over — the selected folder is already the highlighted row in the session panel
beside it, and the window title already carries the host — which is the
redundancy this app has removed twice before, from session rows in `b841362`
and from the merged identity header in `38bf971`. An earlier request to expand
the leaf into a full `~/git/red-stamp` path is superseded rather than reversed:
it was an attempt to make that element earn its space, and the user has since
decided it has none to earn.

No way out goes with the `x`. The session panel is persistent, so another
folder row switches workspace directly and its back arrow leaves the host. What
is no longer reachable is the PLACEHOLDER state once a folder has been picked —
a pane reading "select a folder" while a folder is selected, which is not a
destination anyone navigates to on purpose.

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
| `B` exactly | `""` | `Terminal` |
| `B-<rest>` | `<rest>` | `<rest>` |
| anything else | — | the session name, unchanged |

Then two rewrites over the remainder:

- **empty -> `Terminal`.** The user offered `main` or `terminal`, and this
  document originally picked `main` — "it is what tmux itself calls a first
  window and what the phone app's own screenshots show". That was the wrong half
  of the offer and the bar said so: a folder's default session read `main` and
  the very next one read `Terminal 2`, two unrelated words for two sessions that
  differ only in which was created first. Nothing about `main` predicts
  `Terminal 2`, and nothing about `Terminal 2` explains `main`. The user asked
  for the fix by name — "for main let's call it 'Terminal' so 'Terminal-2' makes
  more sense" — and `Terminal`, `Terminal 2`, `Terminal 3` is one list with a
  first element rather than a special case beside a series.
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
sessions with one name. So a numbered bare `Terminal` is unreachable in practice and exists only
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
session stays grouped with its folder. Typing over a `Terminal` label gives
`<prefix>-<typed>`. This is the whole reason the label is a projection rather
than the name: the user edits the part that is theirs and cannot accidentally
detach the session from its folder.

Two escapes from that:

- a tab whose label IS the session name (the non-derived case, §3.3) commits the
  raw name, because there is no prefix to re-apply;
- clearing the field entirely and committing renames the session TO the bare
  prefix — the bare `Terminal` tab — when that name is free.

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

---

# Later additions

Everything from here on was asked for after the design above shipped. Each
section says what was requested, in the user's words where they are on record,
and — where a request contradicts an earlier one — which way the conflict was
resolved and why.

---

## 11. Tab chords

> `Ctrl+Tab` / `Ctrl+Shift+Tab` to cycle, `Ctrl+1`..`Ctrl+9` to jump.

Cycling wraps, follows DISPLAYED order (so §15's manual arrangement is what it
walks), and includes Files tabs — they are tabs, the bar shows them as tabs, and
a chord that stopped at the last session would strand the user one press short
of something they can see. `Ctrl+7` on a bar of three does nothing rather than
clamping to the last tab. After a chord, focus lands in the new tab's surface
through the SAME `focusActiveTab` a click uses, so the two cannot drift.

The decisions are `nextWorkspaceTabId` and `tabIdAtIndex` in
`src/shared/workspaceTabs.ts`, as tables with unit tests; the key handling is a
window-level `keydown` listener in capture, in `FolderWorkspaceView`.

### 11.1 One window listener, not three key handlers

The chords must work with focus in the terminal, the Files tree or the composer,
and those are three different keyboard owners: xterm consults its own custom
handler, CodeMirror runs a keymap, and the composer's draft is an ordinary
textarea. Routing the chord through each would be three implementations of one
gesture, and the third one added later would be the one that forgot to cancel.

A `keydown` in CAPTURE on `window` runs before all of them, because capture
descends from the window to the target — so there is one handler and nothing can
reach around it. It is the same shape the composer's own Ctrl+backtick uses.

The composer intercepts printable typing, and a chord is not swallowed by it:
`isTypingKey` rejects anything with Ctrl, Meta or Alt held, and the composer's
own global handler returns early for both families.

### 11.2 The premise was wrong: the terminal DOES encode these

The brief chose both families "because terminals cannot encode them". Measured
against the xterm this app ships (`@xterm/xterm` 6, `evaluateKeyboardEvent` —
the function the custom handler is consulted from), that is false for most of
the family:

| chord | what xterm sends |
|---|---|
| `Ctrl+Tab` | `C0.HT` — a literal TAB. `case 9` is reached before any ctrl branch and is gated only on Shift, so the modifier is ignored |
| `Ctrl+Shift+Tab` | `ESC [ Z` (back-tab) |
| `Ctrl+3` .. `Ctrl+7` | `ESC`, `FS`, `GS`, `RS`, `US` — keyCodes 51-55 map to `keyCode - 51 + 27` |
| `Ctrl+8` | `C0.DEL` |
| `Ctrl+1`, `Ctrl+2`, `Ctrl+9` | nothing |

So the chords are **not free**. `Ctrl+Tab` at a shell prompt is completion, and
`Ctrl+3` is a widely used stand-in for Escape. The family still ships — the user
asked for it, and a family with two holes in it would be worse than the cost —
but the cost is recorded rather than assumed, and two things follow:

1. the interception has to be **airtight**, so both `preventDefault()` and
   `stopPropagation()` are called. The first stops Chromium (Electron still has
   a browser underneath, and `Ctrl+Tab` is a real browser gesture); the second
   stops the event ever reaching xterm. Leaving either off is the defect that
   has landed three times in this app already — bc86cf7's doubled first letter,
   3628090's doubled paste, and the `Ctrl+V` route after them;
2. `TerminalView`'s `onCustomKey` declines the chords **as well**, and that is
   not belt-and-braces: a pane mounted outside a folder workspace has no window
   listener above it, and without the branch the chord would become shell input
   there. `tests/unit/terminalTabChord.test.ts` pins it.

`Ctrl+0` is deliberately untouched — it belongs to zoom, and there is no zeroth
tab. `Ctrl+Alt` is untouched everywhere: that is how AltGr arrives on European
layouts, where the digit row carries printable characters.

---

## 12. Closing a tab selects the previously active one

> not the first.

A per-workspace MRU stack, most-recent last, and entries are POPPED as tabs
close. `tabAfterClose` in `src/shared/workspaceTabs.ts` is the decision:

1. **the closed tab was not the active one -> nothing changes.** Middle-clicking
   a background tab, or stopping a session from another tab's menu, is not a
   request to go anywhere;
2. otherwise walk the stack from the top, skipping the closing tab and anything
   not on the bar;
3. **empty stack -> the tab on the RIGHT**, falling back to the left when the
   closed tab was last.

**Right, and why.** It keeps the selection INDEX where it was, so closing a run
of tabs from one position walks forward through the bar rather than retreating
to the start. That is what browsers and VS Code do, and it is the direction
`Ctrl+Tab` travels, so the two gestures do not disagree about which way the bar
runs. The left fallback is not a second rule — it is the same rule finding
nothing on the right.

### 12.1 The stack may never name a dead tab

The brief's condition, and the sharpest reason for it: a session tab's id IS its
tmux session name, and `sessions create` derives that name from the folder. So a
killed session's name comes back attached to a DIFFERENT session routinely, and
a stale entry would not point at nothing — it would resurrect as a live-looking
target.

Two mechanisms, deliberately overlapping. `pruneTabIds` runs from a watch on the
tab list, so every way a tab can vanish is covered by one rule rather than by an
enumeration — a session killed from the phone, from the user's own terminal, or
lost to a host restart runs no close handler here. And `tabAfterClose` filters
against the live bar itself, so it cannot name a dead tab whatever it is handed.

The stack is fed from the RESOLVED active tab rather than from the six routes
that change the selection, because there is a seventh that changes it with
nobody asking: `activeTab` falls back to the first tab whenever the selection
names a tab that is not on the bar. Watching the answer covers every route by
construction and records what the user is actually looking at, which is the only
thing "most recently used" can honestly mean.

It is written to hold for either kind of tab, and §14 is what makes that matter:
a killed session tab and a closed Files tab go through the same function.

---

## 13. Agent marks on session tabs

A small mark per session tab showing which engine runs there. The
classification is already host-side and already reaching the renderer:
`@ps_agent_kind` arrives as `SessionSummary.agentKind`. This is presentation
only — `src/shared/agentBadge.ts`.

### 13.1 What the phone does, and why none of it came across

Checked before designing. The Android app renders a **two-letter monogram in a
tinted pill** — `CL`, `CX`, `OC`, `GK`, `SH`, `?` (`sessionBadgeMonogram` in
`app/.../projects/FolderListTreeChrome.kt`, drawn by
`shared/ui-kit/.../components/AgentKindBadge.kt`). Its tint is **binary**, not
per-kind: agent means one purple, non-agent means grey, so Claude, Codex,
OpenCode and Grok are told apart by their letters alone. `res/drawable/` holds
only the launcher, the quick-settings tile and the two notification marks —
there is no per-agent asset anywhere to port.

So there was nothing to take, and the one mechanism it has cannot come across: a
letter standing in for a graphic affordance is exactly what `docs/POLISH.md` §2
forbids and what `tests/unit/designGates.test.ts` executes. A monogram would
also inherit the UI font at the tab's size rather than the stroke weight the
rest of the bar shares — the same reason `type` is a drawn "T" in `AppIcon.vue`
and not a typed one.

### 13.2 The marks are arbitrary, and say so

| kind | mark | tooltip |
|---|---|---|
| `claude` | `hexagon` | Claude Code |
| `codex` | `code` | Codex |
| `opencode` | `terminal` | OpenCode |
| `grok` | `zap` | Grok |
| everything else | *nothing* | — |

Vendor logos at 12-14px are a licensing and fidelity trap: half of them are
trademarks, all are drawn for a different stroke weight, and none survives being
flattened to one `currentColor` outline. These are four ordinary Feather 4.29
marks whose only job is to be TOLD APART — a closed angular outline, a symmetric
pair of chevrons, an asymmetric chevron-plus-rule, and a jagged bolt. Nothing
claims a hexagon means Claude in the world; it means Claude on this bar, the
tooltip says so on the first hover, and that is the same contract a colour
swatch has.

They are named by SHAPE in `AppIcon.vue` and mapped to kinds in `agentBadge.ts`,
so the icon registry stays a registry of marks and one file knows which product
wears which. Following 3d96eca, all four are Feather marks taken verbatim rather
than invented — that commit's own note ("Feather has no eraser mark and none was
invented") is the policy. `AppIcon`'s `size` prop is the union `12 | 14 | 16`;
the tab mark is `12`.

**No per-kind tint.** Four hues on a 12px outline is a palette nobody can learn,
and `designGates.test.ts` keeps raw colour out of components regardless. The
mark is muted by default and takes the accent when its tab is active, so it
reads as part of the label rather than as a status light competing with the
underline.

### 13.3 Nothing at all for `unknown`

The unknown case is common and legitimate: a session started outside the
`pocketshell agent` wrapper reads as `unknown` forever, because the wrapper is
what records the option, and a plain `shell` tab is not a failure of detection.
Marking either would put a glyph on most of the bar meaning "we do not know" —
same 12px, trains the eye to skip the slot, and takes away the only useful
property a sparse badge has, which is that its PRESENCE is information.

`grok` is badged even though `LAUNCHABLE_KINDS` excludes it. 0.4.44's
`pocketshell agent` has no `grok` subcommand so this app cannot START one, but a
session can BE one — the phone launches it through its own engine registry, and
the tmux option is on the session either way. Refusing to badge it would be
reading our own capability out of the host's record.

---

## 14. Stopping a session

> Right-click a session tab -> a menu including an action that kills that tmux
> session.

**The only destructive action in this app**, reachable from two menus: this one,
and the session panel's folder row, which stops a whole folder at once (§14.4).
The file tree's menu (c614e7e) deliberately omitted delete as
"destructive-adjacent with no undo"; this was asked for explicitly, so it ships
— and it is the only thing in either menu that can lose work, so it looks like
it: separated, tinted with `--error`, and behind a confirmation.

The menu reuses `PopupMenu.vue`, which exists precisely for this shape: the tab
strip is `overflow-x: auto`, which per CSS makes `overflow-y` compute to `auto`
as well, so an `absolute` menu inside it is laid out at the clip edge and is
invisible — the bug the `+` menu shipped with. PopupMenu teleports to `<body>`
and positions from a measured rect.

**Rename is surfaced there too.** Click-to-rename (§4.3) is real and completely
undiscoverable, and a context menu that opens for a single action is a worse
trade than the right-click itself.

A right-click does NOT select the tab. The items name the tab they came from, so
acting on a background tab is unambiguous — and selecting first would mean a
right-click the user then dismisses had already moved them, and moved the
composer's key with it.

### 14.1 The confirmation

Named, because "Stop" undersells it: a tmux session is usually an agent in the
middle of a task, and its scrollback and process tree go with it. The dialog
names the **session**, not the tab label — the label is a projection that strips
the folder prefix (§3.3), so two folders can both show a tab reading `Terminal`,
and the one moment a user must be certain which thing is being destroyed is the
moment they are asked to confirm destroying it. Cancel is the quiet button and
Stop carries the error fill, so the dangerous half is the half that must be
aimed at.

### 14.2 Finding the lever, against the fixture

Captured from the pinned 0.4.44 Docker image the way 00eb3e7 captured
`pocketshell agent --help`; the transcripts are committed at
`tests/unit/fixtures/v0.4.44-*.txt`.

**`pocketshell sessions` has no kill verb.** Four subcommands — `create`,
`list`, `resumable`, `resume` — and eight kill-ish spellings (`kill`, `stop`,
`rm`, `delete`, `destroy`, `remove`, `close`, `terminate`) all answer
`Error: No such command` with exit 2.

**`tmuxctl kill` exists and is rejected anyway.** `tmuxctl kill '<target>'
--yes` is real, and `--yes` is not optional in practice: without it `typer`
prompts, and on the non-interactive stdin an `exec` channel provides it aborts
with exit 1 having killed nothing. Two measured defects rule it out:

1. **it cannot kill a numerically-named session.** `_resolve_session_target`
   branches on `target.isdigit()` and reads the name as an index into a recent
   list, so a session called `2` fails with `not enough values to unpack` and
   survives. This app can put such a tab on the bar, and a destructive action
   that silently cannot act on one of its own targets is not acceptable;
2. **its own kill is not exact-match.** It guards with
   `has-session -t "={name}"` and then kills with a bare
   `["kill-session", "-t", session_name]`.

So: raw `tmux kill-session -t '=<name>'`. Raw tmux reaches the same server —
`attachCommand.ts` records that tmuxctl 0.4.x shells out to a bare `tmux` on the
default socket, which is why `sessionSwitchCommand` and `renameSessionCommand`
are already raw.

**The `=` is the whole safety of the line**, and the dangerous case is not the
obvious one:

| alive | command | outcome |
|---|---|---|
| `api`, `api-staging` | `kill-session -t '=api'` | exit 0, `api-staging` survives |
| `api`, `api-staging` | `kill-session -t api` | exit 0, kills `api` — the bug HIDES |
| `api-staging` only | `kill-session -t api` | **exit 0, kills `api-staging`** |
| `api-staging` only | `kill-session -t '=api'` | exit 1, `can't find session` |

With both alive, exact match wins and a bare `-t` looks correct. The failure
appears once the target is already gone — which is exactly the state a tab bar
refreshed on a timer is routinely in. A bare `-t` fails OPEN: it destroys the
wrong session and reports success. `=` fails CLOSED with a message. For a
command with no undo that is the only acceptable direction to fail in.

A session the host reports as already gone comes back as its own outcome
(`not-found`) rather than as a failure, separated by PROBING first rather than
by parsing tmux's prose — "can't find session" is a message, and messages are
not an API. The UI treats it as success: the state the user asked for is the
state that exists.

### 14.3 Cleaning up our side

Three pieces of desktop state are keyed by session name, and they are the same
three a rename has to MOVE (61753d7). A kill is the only other operation that
invalidates a name, so the two lists stay in step:

| what | who drops it | why it cannot wait |
|---|---|---|
| the pool's tmux client + its PTY | `TmuxClientPool.killed`, from the ipc handler | the record must go SYNCHRONOUSLY, or `attach` hands out a client for a session that no longer exists and `isShowing` fences sends against a name nothing answers to |
| the mounted terminal pane | the workspace, from `openedSessions` | `sessionPanes` already filters against live tabs, but the entry must go too, or a new session reusing the name inherits a pane that was never torn down |
| the composer's per-session record | `composer.forget` | the kill's counterpart to the rename's `composer.rekey`. A draft under a key nothing will ask for again persists to `localStorage` forever — and would be handed to the next session of that name |

The handshake token is DROPPED here, where a rename merely moves it: a rename
keeps the same session and wants the same tmux variable, a kill ends it, and a
later session reusing the name is a different session that must not inherit the
dead one's tty rendezvous.

Selection then goes through §12's `tabAfterClose` — the same path a closed Files
tab takes — and focus lands in the newly selected tab's surface.

### 14.4 Stopping a folder, from the session panel

> Right-click a folder row in the session panel -> `Stop all 3 sessions…`.

The tab menu above stops ONE session, and it can only be reached from the
workspace of the folder that session is in. Clearing a folder through it means
opening that workspace and confirming once per tab; the panel's folder row is
the only control in the app that stands for the whole SET, so it is the only
place the batch can live. It sits under `New session…` in the same row menu
(SessionTree.vue), separated and `--error`-tinted by the rule this section
already sets.

**It is called Stop, not Close.** `Close` in this app closes a TAB and leaves
the session running (§12). Two words for one destructive act, in two menus a
click apart, is how a user comes to believe one of them is the safe one.

**The confirm LISTS the sessions**, which is the one thing it does that §14.1's
does not have to. The tab menu could name a single session because the tab was
under the cursor; a folder row carries a dot, a label and a count and never a
name, so without the list the user would be agreeing to lose things they cannot
see. It scrolls at six rows rather than growing the sheet, so the warning and
the buttons stay on screen.

**Sequential kills, and a partial failure is reported by name.** Each kill is an
ssh exec, and a folder's worth fired at once is the load the panel's own poll is
already guarded against. `not-found` counts as success per §14.2. What refuses
does not abort the batch: the rest are still stopped, and the message names the
survivors under the tree — in its own dismissable line rather than in
`sessions.error`, which the five-second poll rewrites and would erase seconds
after the user was told.

Of §14.3's three pieces of desktop state, this panel can reach exactly one and
needs only that one. The pool's client goes main-side from the ipc handler
whatever the caller is; the composer record is dropped here, per session, and
only for the sessions that actually died; and the workspace's mounted pane needs
no help, because `sessionPanes` is filtered against the live tabs — a session
that leaves the listing takes its terminal with it.

---

## 15. Rearranging tabs

> "I also want to be able to rearrange tabs like drag and drop them around."

### 15.1 The conflict, and how it was resolved

This contradicts an explicit earlier instruction: "the tabs are always ordered:
first agent sessions, then files" (§3.2), which `buildWorkspaceTabs` enforces. A
manual order overrides a derived one by definition, so both cannot be obeyed in
full. The resolution:

- **the derived order becomes the DEFAULT.** A tab nobody has dragged sits where
  §3.2 puts it — sessions by creation time oldest first, then Files tabs in the
  order they were opened. Nothing changes for a user who never drags;
- **a manual position wins once set**, for the tabs that have one;
- **the two GROUPS stay separate.** A Files tab may not be dragged among the
  session tabs, and a session tab may not be dragged past the first Files tab.

The last is the judgement call, and the freest reading of "drag them around"
says the opposite. It is kept because the grouping does work that the ordering
WITHIN a group does not: it is what makes the bar's shape predictable —
everything before the first Files tab is a live process on another machine,
everything after it is a file browser — and the tab styling leans on it, since
`.tab.files` is toned down so the eye can find the session half without reading
labels. Interleaving would take that away and give back the ability to put a
file browser in the middle of a row of terminals.

It is cheap to relax if that reading is wrong: delete the clamp in
`reorderTabs`. What must not happen meanwhile is a drag that appears to cross
the boundary and then snaps back, which reads as a bug rather than as a rule —
so `canDropTabAt` lets the UI **refuse visibly**, with no drop indicator and a
`no-drop` cursor, while the drag is still in the air.

### 15.2 The stored value is a RANKING, not a list of tabs

The tab set is not static: sessions arrive on the refresh timer, are created
from `+`, and vanish when they are killed here, from the phone or from the
user's own terminal. So the stored order has to be a preference ABOUT tabs
rather than a list OF them — as a list it would need reconciling on every
refresh, and every reconciliation is a chance to invent a tab or lose one.

As a ranking (`applyTabOrder`), the three awkward cases fall out with no special
handling:

- **a new tab** has no rank, sorts after everything that does, and lands at the
  end of its own group — which is where a new session belongs anyway;
- **a removed tab** is simply absent and leaves no hole, because nothing is
  positioned by index;
- **an unknown id** ranks nothing and is inert.

The sort is stable and the comparator only compares ranks, so two unranked tabs
keep their derived relative order. The groups are re-established after the sort
rather than trusted through it, so an order written by an older build — or
hand-edited in `localStorage` — cannot interleave the kinds.

A drag stores the WHOLE bar's ids, not a delta: with only the moved tab ranked,
every other tab would be unranked and one drag would have moved everything.

**Pruned by the same function as the MRU stack** (`pruneTabIds`, §12.1), because
they have the same shape and the same hazard, and one definition of "this id has
died" is what stops them developing two. The prune is skipped while the bar is
empty — a deep link or a reload has no tabs for a moment, and pruning against
that would throw the arrangement away before the tabs it describes appeared.

### 15.3 Where the order lives

`localStorage`, keyed `ps.tabOrder.<host alias>.<folder key>`.

`localStorage` rather than the settings store, following the precedent the
session panel's width and the file tree's width set (§3.6): the settings store
is for preferences a user sets BY NAME in the Settings overlay, and an
arrangement reached by dragging until it looks right is not one.

Keyed on the **host alias**, never on the connection id. The workspace's
in-memory tab map keys on `connectionId`, which is right for something that
lives as long as the window — but a connection id is an opaque handle minted per
connect, so a key built from it would be fresh on every launch and the order
would never survive a restart. The route's `:name` is the `~/.ssh/config` alias,
exactly as stable as the folder path beside it.

An empty order is REMOVED rather than stored as `[]`: "the user arranged
nothing" and "there is no entry" are the same state, and one spelling of it
means a workspace whose tabs were all closed leaves no key behind.

### 15.4 The interaction

Native HTML5 drag-and-drop, the same family the composer uses for attachments.

- **The two drags cannot be confused.** A tab drag advertises
  `application/x-pocketshell-tab`, and the composer's `dragover` now requires
  `Files` in `dataTransfer.types` before it lights up. It used to accept any
  drag at all — harmless while nothing else in the window was draggable, and
  wrong the moment tabs were, because the strip sits directly above the card and
  a passing tab made it promise a drop it cannot accept.
- **The drag does not fight the click.** Native DnD suppresses the `click` that
  would otherwise follow, so select-on-click, click-again-to-rename and the
  right-click menu are all untouched. A drag is refused outright while a rename
  field is open — dragging it would be a drag of a text selection wearing a
  tab's clothes.
- **The dragged tab fades but stays in place.** Removing it from the flow would
  reflow every tab after it the instant the drag began, so the target would move
  under the cursor at exactly the wrong moment — and on a scrolling strip it can
  change which tabs are visible.
- **The landing place is drawn**, as a 2px accent rule in the gap, flipping at
  the midpoint of the hovered tab. Without an indicator a reorder is "let go and
  find out", and both rules the drag obeys — the midpoint flip and the group
  boundary — are invisible unless something draws them. A refused drop draws
  nothing, and that absence IS the refusal.

### 15.5 Keyboard reordering

`Ctrl+Shift+PageUp` / `Ctrl+Shift+PageDown` move the ACTIVE tab one place.

VS Code's own binding for this action, which is the best reason to pick it: a
user reaching for the keyboard will try it first. It collides with nothing this
app claims — the composer's size ladder is `Ctrl+Shift+ArrowUp/Down`, and taking
`Ctrl+Shift+ArrowLeft/Right` would have put a second arrow family beside it for
a different job.

The cost at the terminal, stated as §11.2 states the others: xterm's `case 33` /
`case 34` check Shift before any ctrl branch, so `Ctrl+Shift+PageUp` would
otherwise scroll the pane's buffer. Plain `Shift+PageUp` — the gesture people
actually use for scrollback — is untouched, because the branch requires Ctrl.

A move that would leave the group does nothing at all, which is the right feel
for a key: the tab stops at the edge rather than jumping the boundary. It is
written on top of `reorderTabs` so the group clamp is decided in one place.

---

## 16. What is built, and what is deliberately thin

Everything above is implemented. `npm run test:unit`, `npm run lint` and
`npm run typecheck` are green, and `npm run build` packages.

| Area | Where |
|---|---|
| tab labels, ordering, collisions, rename target | `src/shared/workspaceTabs.ts` + `tests/unit/workspaceTabs.test.ts` |
| tab chords, MRU close, manual order | same file: `nextWorkspaceTabId`, `tabIdAtIndex`, `pushMru`/`pruneTabIds`/`tabAfterClose`, `applyTabOrder`/`canDropTabAt`/`reorderTabs`/`nudgeTabOrder`. Key handling in `FolderWorkspaceView`; the terminal's refusal in `TerminalView` + `tests/unit/terminalTabChord.test.ts` |
| agent marks | `src/shared/agentBadge.ts` + `tests/unit/agentBadge.test.ts`; the four Feather marks in `components/AppIcon.vue` |
| stop a session | `killSessionCommand` -> `ProjectsService.killSession` -> `projects:killSession`, `TmuxClientPool.killed`, `composer.forget`; fixtures at `tests/unit/fixtures/v0.4.44-*` |
| the derivation the prefix comes from | `src/shared/sessionNameParts.ts` (moved out of `main/projects/sessionName.ts`, which re-exports it) |
| two-level panel | `src/renderer/components/SessionTree.vue` |
| the workspace | `src/renderer/views/FolderWorkspaceView.vue` |
| rename | `renameSessionCommand` -> `ProjectsService.renameSession` -> `projects:renameSession`, `TmuxClientPool.renamed`, `composer.rekey` |
| orphan placement + diagnosis | `inferPathsFromSiblings` / `diagnoseSessionPaths` in `src/main/helper/parsers.ts` |
| routing | `src/renderer/router.ts`, `src/renderer/views/SessionRedirectView.vue` |
| popup menus (`+`, file tree, host actions) | `src/shared/popupPlacement.ts` + `tests/unit/popupPlacement.test.ts`, `components/PopupMenu.vue`, `components/HostActionsMenu.vue` |
| worktree grouping | `gitRepoProbeCommand` -> `parseWorktreeRoots` + `tests/unit/worktrees.test.ts`; cached in `PocketshellClient.withRepoRoots` |
| file tree width + context menu | `views/FilesView.vue`, `components/FileTree.vue` |

Two things are thinner than they could be, and each is a deliberate stop
rather than an oversight:

1. **SUPERSEDED — "a session tab cannot be closed".** This said that closing a
   tab would have to mean killing a live tmux session, which is not what a tab
   close means anywhere else. The first half of that reasoning survives and is
   why a session tab still has no `x`: §14 puts the kill in a context menu,
   named and confirmed, rather than under a control that means "close this
   view" everywhere else it appears. The second half — that the app should not
   offer a kill at all — was overtaken by the user asking for one explicitly.
   The Files-tab rule is unchanged: a second one closes, the first does not,
   because it is the folder's file browser and the workspace would otherwise
   have no way to look at the folder at all.
3. **The agent launch is still fire-and-forget, but it is no longer SILENT.**
   `pocketshell agent <kind>` is written into the new session once its PTY
   exists, and nothing verifies that the wrapper then started — verifying would
   mean parsing the pane, which is the process-sniffing `@ps_agent_kind` exists
   to avoid. What was fixed is the case where the PTY never came up at all: that
   used to do nothing, forever, with no message, so "I asked for Claude and got
   a shell" had no explanation anywhere. There is now a bounded wait
   (12 s — far beyond the ~2 s a join costs on a real link) and a sentence
   naming the session and the command to run by hand.
