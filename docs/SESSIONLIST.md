# SESSIONLIST.md — Session panel: the folder view

Status: **superseded in part by docs/WORKSPACE.md — read §0 first.**
Originally written as "flatten the tree" against
commit `b55ec9f`, implemented in `3d90f2b`, **revised once** when the user
asked for the folder view back:

> "for the left side panel — I want something like a folder view. git /
> sessions … tmp / sessions other sessions. like we have in the app"

**revised a second time** when the user circled a row rendering as
`● m…ng-token  git-dtc-website…  20h` and said:

> "this should be the directory, not session name. but if we have multiple
> things in a directory then we have another branch in the tree where we show
> multiple sessions with their names."

plus, on the same panel, three sessions sitting in `other`:

> "these things are actually under git/ too."

and **revised a third time — this document —** after the user reported
"session grouping still doesn't work" for the **third** time and spelled the
requirement out:

> "git -> folder -> session"

## 0. Revision 4 — the session level is gone (docs/WORKSPACE.md)

**What is still true:** everything this document says about a ROOT row or a
FOLDER row. The measurement in §1, the display-label rules in §4, truncation
(§5), the timestamp and sort (§6), the panel width (§7), and registered roots
(§12) are all unchanged and are the reason those parts of the panel look the
way they do.

**What changed:** the panel is now `root -> folder`, TWO levels, one row per
folder. There is no session level. Clicking a folder row opens a folder
WORKSPACE in the right pane whose tab bar carries every session in that folder.
§2 below ("three levels, unconditionally") is kept verbatim and is no longer
what ships.

**Why, in one sentence:** §2's argument was that a level must earn its rows and
the folder level earned them by being the structure the user asked to see — but
the SESSION level only ever earned its rows by being *the only way to reach a
session*, and it is not any more.

Revision 3's own load-bearing sentence is the one that gives way:

> the directory row is always a header with its sessions nested beneath it, and
> it is no longer selectable: clicking it expands.

Selecting a session was a panel operation, so the panel needed a row per
session to select. Under the folder workspace it is a tab operation. The leaf
now spends a row on a navigation step the tab bar already performs, and §1's
measurement — 11 folders, 11 sessions — puts a number on that: 22 rows became
11, and the count no longer grows when a folder gains a second session.

**This is NOT revision 2 returning.** Revisions 1 and 2 removed a level
CONDITIONALLY, when a folder held one session, so the panel's shape depended on
its contents and changed under the refresh timer — and §2's rebuttal of that
still stands word for word. Revision 4 removes the session level for EVERY
folder, whatever it holds. The panel is always two deep; a reader can predict
its shape without knowing what is running. That is the property revisions 1 and
2 destroyed and this one preserves.

**Consequences inside this document, listed rather than edited away:**

| Section | Status under revision 4 |
|---|---|
| §2 "three levels, unconditionally" | superseded — two levels, unconditionally |
| §3 indent budget | the third step is gone; the folder row moves into the slot the directory header had, and the panel implements the two-level table now in that block |
| §4.6 untracked sessions | still a chevron-less row in the folder slot, but SELECTABLE — it opens a workspace holding that one session (docs/WORKSPACE.md §6.3) |
| §6 "finding the session I was just in" | answered by the attached dot on the folder row plus the workspace's tab bar; the panel no longer names sessions at all, so the folder tooltip lists them |
| §10.2 "spend a row only where there is fan-out" | unchanged as a principle, and it is what retired the level |

**And one thing revision 4 fixes that revision 3 could not.** The user reported
four sessions rendering as orphans and expected two of them to sit with the
folder they are named after. Under revision 3 that was an untidy panel; under
revision 4 it is a session with no workspace at all, because everything keys on
the folder. `inferPathsFromSiblings` (src/main/helper/parsers.ts) gives such a
session the directory of the session whose name it extends, and
`diagnoseSessionPaths` logs why the probe failed to place it. See
docs/WORKSPACE.md §6.

---

## 0a. Revision 5 — creation moves onto the rows (implemented)

The user, on the panel:

> "I also want to have a `+` near git, near `tmp` (another project root in
> hetzner) and just a plus to create a random session in any place. then we
> don't need 'new session' button anymore"

Three changes, and the third is only safe because the first two ship with it.

**A `+` on every root row.** It opens the same folder-first picker the foot
button opened, rooted at THAT root: the user has said which root, and the
folder under it is still an open question, so the picker still opens — it just
opens one level in. It does not guess a directory from a root, because guessing
is how a session ends up somewhere the user did not choose.

The root key is home-relative by construction (§8) and the picker browses over
SFTP, which runs no shell, so `~/git` has to be expanded before it is handed
over — `rootHostPath` in `sessionGrouping.ts`, the inverse of `directoryKey`.
Two cases have no honest answer and are handled differently on purpose: the
`other` bucket gets **no `+` at all** (it is where paths that matched no root
went, not a directory), and a `~`-keyed root on a host whose `$HOME` neither
resolved nor could be inferred from the session paths gets a **disabled** `+`
whose tooltip says why. A control that vanishes on a failed fetch reads as a
feature that is not there.

**Revealed on hover or focus, never persistent.** One `+` per root is a column
of identical marks down a panel whose whole job is to be scanned. It is
`opacity`, not `display`, so the square is always laid out and the label never
reflows under the cursor; `:focus-visible` reveals it, so it is reachable AND
visible by keyboard; `@media (hover: none)` shows it unconditionally. It is
deliberately **not** conditioned on whether the root is empty — an empty
registered root is the `+`'s most useful case, but `directories.length` moves
under the refresh timer, and keying visibility off it is the same trap §3a
records about expansion state.

**A general `+` in the header strip**, opening the picker with nothing
pre-filled. This is what makes the removal safe: it is on screen whatever the
panel holds, including a host with no sessions at all, so there is never a
window with no way to create a session.

**The foot button is deleted.** It spent a bordered 44px row, permanently, on
one action — and it answered "where?" with a browse starting at `$HOME` even
when the user had just pointed at `git`.

**What did NOT change: the panel's `+` does not choose an agent.** See §13.

---

## Revision 3, and why revisions 1 and 2 were wrong

**What changes.** The directory level stops being conditional. Every
directory renders as its own header row with its sessions nested beneath it,
always, so the panel is `root -> directory -> session` at every node. The
directory row is no longer selectable as a session: clicking it expands or
collapses, and selecting happens on the leaf.

**Why the previous two revisions got this wrong, and it was not the
measurement.** §1 is kept verbatim below and every number in it still holds:
11 folders, 11 sessions, 1:1. Revision 1 read that as "move the header up to
the root". Revision 2 read it as "emit no header at 1:1 — the directory row
*is* the session row". Both were arguing the same defensible principle,
written into revision 2's §10.2 as **"spend a row only where there is
fan-out"**, and both were arguing it about the wrong thing.

The mistake is visible only when you apply the conditional to the measured
distribution instead of to a sketch. At 1:1 the conditional fires on **every**
node. What revision 2's §2 sketch draws as a tree with one illustrative branch
renders, on the user's actual host, as a single `git` header over a flat list
of twelve rows — the exact view revision 1 was written to replace, with a
chevron on top. That is what the user was looking at all three times they said
grouping does not work.

So the error was in the unit being optimised. A row count is a cost; it is not
the deliverable. **The deliverable is that the user can see the structure** —
which directory each session lives in, and which directories exist — and a
tree whose nodes collapse whenever they hold exactly one child does not read
as a tree at all. It reads as a list that has been decorated. Revision 2's
argument that the collapsed row "costs exactly what the flat row cost" is
true, and it is beside the point: what it cost was the structure.

**What §1 still buys.** One thing, and it is kept (§3b field 4): the bare
count is dropped from a directory header holding one session. `1` beside a
header whose only child is drawn on the very next row genuinely is the dead
field §1 identified, and dropping it hands the label back some of the width
the new indent level takes.

**Superseded reasoning is kept, not deleted.** Revisions 1 and 2 both revised
by overwriting, which is how the same wrong conclusion got re-derived twice
from the same correct measurement. The old arguments now sit under
`~~struck~~` headings so the next reader can see what was tried and why it
failed against real data rather than in the abstract.

Revision 3 also lands a **second, separate request** from the user, in §12: the
ROOT level stops being derived from `$HOME` and becomes a list the user
registers in Settings, which is the phone's "watched roots". The two interact —
§12.4 records the decisions they force on each other — but they are independent
changes and §12 can be read on its own.

Sections rewritten by revision 3: §2, §3 (all of it — the anatomy and the
indent budget), §4.1/§4.3/§4.4, §5 (one bullet), §6, §7 (the container-query
floor), §8, §9, §10, §11. New: §12. Sections unchanged and still binding: §1
(the measurement), §4.2, §4.5, §4.6.

Line numbers cited below are from the commits named beside them and may drift.

---

## 1. The problem, from real data

*Written at commit `b55ec9f`, in the present tense of that commit, and kept
verbatim across both revisions: every measurement below still holds. It is why
§2's top level is the ROOT level rather than this one, and — after revision 2
— why §2's directory level emits no header at 1:1.*

The panel (`src/renderer/components/SessionTree.vue`) renders a two-level
tree: a collapsible folder header **per leaf working directory**
(SessionTree.vue:132-148), then one row per session under it
(SessionTree.vue:150-171). Grouping is `groupSessionsByFolder`
(src/renderer/sessionGrouping.ts:130-154), a port of the Android app's
*no-watched-roots fallback* (sessionGrouping.ts:11-15).

Against the user's real dev box the distribution is **11 folders, every one
holding exactly one session** — 22 rows for 11 sessions. The design was only
ever exercised against the 2-folder Docker fixture
(`docs/screenshots/polish-02-workspace-sessions.png`,
`polish-13-session-list-default.png` — and note those screenshots are stale:
they show the pre-`NewSessionDialog` text-input footer, so even the fixture
imagery lags the code). Five compounding failures at the real distribution:

1. **The grouping earns nothing.** A folder header whose entire content is
   one session, labelled "· 1 session" (SessionTree.vue:81-83, 147), costs a
   row and a disclosure affordance to convey zero information.
2. **The two lines are near-duplicates by construction.** The session name
   is *derived from the folder path*: `~/git/dataops` → `git-dataops`
   (`sessionBaseName`, src/main/projects/sessionName.ts:66-95). Folder
   `dataops` + session `git-dataops` is the same fact twice.
3. **Both levels truncate into uselessness.** The session row indents 28px
   (SessionTree.vue:287), then spends width on a dot, an agent badge, an
   `attached` tag (SessionTree.vue:168), and a ~90px absolute timestamp
   (SessionTree.vue:115-119, 169). At the 280px default width
   (src/renderer/views/HostWorkspaceView.vue:36) the name gets ~40-60px:
   `git-…`, twice, on adjacent folders.
4. **Basenames are ambiguous under end-truncation.** `pocketshell` vs
   `pocketshell-desktop`, `dtc-website` twice — the distinguishing text is
   the *tail*, which end-ellipsis is precisely what removes.
5. **Folder and session name can diverge** (git worktree: folder
   `merry-sniffing-tortoise`, session `git-dtc-website`). Any rendering that
   assumes name == folder collapses the wrong information.

The phone does not have this problem because its top level is **watched
project roots**, not individual folders — `buildFolderTree` takes
`watchedFolders` from `ProjectRootDao` and buckets folders under roots with
an "Other folders" catch-all (pocketshell clone:
`FolderListViewModel.kt:2758-2782`, `:2614-2615`, `:87`, `:968-970`;
`FolderTreeProjection.kt:118-175`). Roots have real fan-out (`~/git` would
hold all 11). The desktop ported only the fallback path where the degenerate
level *is* the top level (sessionGrouping.ts:11-15).

## 2. Position: three levels, unconditionally

**Group sessions by ROOT — the roots the user registered in Settings (§12), or
`$HOME`'s children when they have registered none — with an `other` catch-all.
Inside a root, group by the working DIRECTORY. Every directory is a
collapsible header row whose children are its sessions, named by session name.
There is no size at which a level disappears.**

```
v git                        12
  v dtc-website
      git-dtc-website               21h
  v pocketshell                2
      git-pocketshell               21h
      git-pocketshell-quse          20h
  v dataops
      git-dataops                   22h
> other                         3
```

Read the `dtc-website` and `dataops` nodes: one session each, and each still
gets its header and its child. That is the whole of revision 3.

### What the levels cost, honestly

| Distribution | Rev 1 (flat) | Rev 2 (conditional) | Rev 3 (this) |
|---|---|---|---|
| 11 folders, 1 session each | 11 rows | 11 rows | 1 + 11 + 11 = **23 rows** |
| 1 folder, 3 sessions | 3 rows + a dimmed name each | 1 branch + 3 rows | 1 branch + 3 rows |

Row one is the trade and it is not a small one: at the measured distribution
this design is roughly double the rows of the design it replaces, all of them
above the fold of a scrolling panel. It is accepted because **rows are not
what the panel is short of** — it scrolls, and the sessions store caps at what
one host runs. What the panel was short of was any way to see which directory
a session was in without hovering it, and that is what the extra row buys.
Collapse is the escape hatch and it is remembered (§6), so a user who wants
revision 2's density can collapse a directory and keep it collapsed.

### ~~Why the level is free at 1:1~~ (revision 2, superseded)

*Kept for the record. This is the argument that produced the panel the user
rejected three times; it is wrong in the way described at the top of this
document, not in its arithmetic.*

> §1's measurement is the load-bearing input, not an obstacle. It says: at 11
> folders and 11 sessions, a folder *header* buys nothing, and since the
> session name is derived from the folder path (`~/git/dataops` →
> `git-dataops`, sessionName.ts:66-95) the header and the row were the same
> fact twice.
>
> This design pays that bill by **not emitting a header at 1:1**. The
> directory and the session are one row. Compared with revision 1's flat list
> the common case is not one row heavier, one indent deeper, or one chevron
> busier — it is byte-for-byte the same row, with a better label.
>
> The multi-session line is the trade, and it is the one the user asked for by
> name. It is also strictly better than what it replaces: the old §4.3 handled
> the multi-session folder by turning the secondary session-name field on for
> every one of its rows, which is the doubled `label + dimmed name` row the
> user circled. A branch says the folder **once**, at the top, and then says
> only what differs.

The last paragraph survives revision 3 intact and is now the rule at every
size: the directory is said once, by its header, and the rows below it say
only what differs.

### Why the header label is the directory, never the session name

The session name is *derived from the path*, so as a header label it would be
a lossy restatement of the folder with a root prefix bolted on (`git-dataops`
for `~/git/dataops`, already sitting under a header that says `git`). The
folder basename is shorter, more distinctive, and it is what the user
navigates by. The name is not lost: it labels the leaf row directly beneath,
and the tooltip carries both in full.

**The dimmed secondary name field stays retired.** It existed to answer "which
session is this?" on a row named by a folder, and revision 3 answers it
structurally at every size: the folder names the header, the name names the
leaf, and neither row carries two labels fighting over ~150px — which is the
middle-truncation collision the user circled.

### Still rejected

- **~~A header per leaf folder~~** — this was §1's conclusion and revision 2's
  rejected option. **Revision 3 adopts it.** See the top of this document for
  why: §1's row-count argument is real, and it was never the thing the user
  was asking about.
- **Group by agent kind or recency bucket** — agent kind is already a badge
  and recency is already the sort.
- **Recovering the DIRECTORY from a session name** — see §4.6. The derivation
  is not invertible, and a guessed directory row is worse than none.
- **A FOURTH level (nesting `~/git/a/b` under `~/git/a`)** — nothing in the
  real data has it, and unlike the directory level it would spend a row on a
  node holding **no session of its own**, which is a genuinely empty row
  rather than a structural one. The user asked for three levels and named
  them; this is where the nesting stops.
- **Auto-collapsing a directory once the list is long** — a rule that removes
  the level again at exactly the distribution that motivated it. Collapse is
  manual, and remembered (§6).

**Superseded by §12:** this paragraph used to read "the desktop still has no
project-roots table, so roots are synthesised from the session paths rather
than read from one… the desktop can only ever show roots that currently hold a
session, where the phone also lists sessionless project folders to create
into." That gap is now closed: roots are registered in Settings, and a
registered root renders whether or not anything is running in it. Synthesis
from `$HOME` survives as the no-roots-configured default, which is what keeps
an install that never visits Settings looking exactly as it did.

`sessionGrouping.ts` keeps all three projections. `canonicalisePath` /
`defaultLabelForPath` / `sessionActivity` remain the shared label and ordering
rules; `groupSessionsByFolder` remains exported as the phone-parity anchor for
the LEAF level even though nothing renders it; and the root projection and the
flat projection are built from one shared row builder (§8), so they cannot
disagree about what a folder is called.

## 3. Row anatomy and the indent budget

**Three** row types, all height `--row-h` (28px, docs/DESIGN.md:535), plus one
degenerate fourth (§3d). Budget at the 280px default
(HostWorkspaceView.vue:36); every selectable row keeps the 2px selection rail
slot + accent rail for `current`.

### 3.0 The indent budget

Three levels have to fit above the 200px panel floor (§7), so the step is the
smallest one that still reads as nesting: **8px**, which is VS Code's own tree
step. The column all three row types share is the **dot**, because it is the
one element every row has; each label then follows its dot at a constant 16px
(an 8px dot plus an `--sp-2` gap), so the labels inherit the same rhythm
without a second set of numbers to keep in sync.

| Level | Chevron box | Dot | Label |
|---|---|---|---|
| Root header (§3a) | 8–22 | **30** | 46 |
| Directory header (§3b) | 20–34 | **38** | 54 |
| Session row (§3c) | — | **46** | 62 |

Arithmetic, so it can be checked rather than trusted: a header's left inset
plus the 14px chevron box plus a 4px gap lands its dot (`8+14+8=30` for the
root, whose gap is the full `--sp-2`; `20+14+4=38` for the directory, whose
`.disclosure` carries `margin-right: -4px` to trim the shared gap). A row
without a chevron simply starts at its dot. Both indented row types spend 2px
of their inset on the selection-rail slot.

**What the level costs the leaf.** Its label starts at 62 where revision 2's
single-session row started at 46 — 16px, and the leaf now carries a full
session name where that row carried a short directory basename. Two things pay
for it: the container-query floor moves 250 → 270 (§7), so the timestamp is
already gone by the time width is genuinely scarce; and a one-session
directory header drops its `1` count (§3b field 4). At the 200px floor the
leaf has `200 − 62 − 10 = 128px` for label and badge — about 13 characters
next to a `claude` badge, which is why middle truncation (§5) is load-bearing
here rather than decorative: what survives is `git-…ell-quse`, the half that
separates a session from its sibling. At the 280px default the leaf gets
208px, which clears the longest name in the real data set untruncated.

### 3a. Root header row

A `<button>`, so collapse is keyboard-reachable and `aria-expanded` is real.

| # | Field | Spec |
|---|-------|------|
| 1 | Disclosure | `AppIcon name="chevron-right"` at 14px, rotated 90° when open — the app's one disclosure pattern. Never a text glyph (designGates gate 2) |
| 2 | Status dot | The same 8px dot the session row uses, `--success` when **any** session under the root is attached. This is the collapsed root's only way to say "something live is in here", which is the state where it matters |
| 3 | Root label | `--font-ui` `--fs-300` `--fw-semibold`, `flex: 0 1 auto; min-width: 0`, end-ellipsis. The `other` bucket renders `--fw-regular` `--fg-secondary` instead: it is a bucket, not a directory the user could navigate to |
| 4 | Count | Bare integer, `--fs-100` `--fg-muted` `tabular-nums`, `margin-left: auto`. **Not** `· 3 sessions` — the number is the whole message, and the phrase form retreats to the header tooltip |
| 5 | New session | **Revision 5.** `AppIcon name="plus"` at 12px in an `.icon-btn.sm`, trailing the count. `@click.stop`, `opacity: 0` until the row is hovered or the button itself is `:focus-visible`. Absent on `other`; disabled when `rootHostPath` cannot resolve the root. See §0a |

**Header tooltip:** `~/git` + `3 sessions`. The path is written home-relative
because the grouping key *is* home-relative (§8). The `other` header says
`sessions outside $HOME, or with no known folder` instead, since it has no one
path to name.

**Revision 4 note on field 1:** the disclosure mark is gone with the collapse,
and revision 5's `+` is not its replacement. A chevron promises a STATE the row
does not have; a `+` promises an ACTION, which it does. The row itself is still
inert, and still takes no hover background — the only `:hover` rule it carries
reveals the button inside it.

### 3b. Directory header row — every directory, whatever it holds

A `<button class="dir-header">`, so collapse is keyboard-reachable and
`aria-expanded` is real, followed by a `<ul>` of §3c rows.

**It does not select a session.** Clicking it toggles, and that is the whole
of its click behaviour — the session it used to stand in for at 1:1 now has a
row of its own on the very next line, so there is nothing for a click here to
disambiguate. `select` is emitted from leaves only, and it still carries a
`SessionSummary`, so `HostWorkspaceView.onSelectSession` is untouched.

| # | Field | Spec |
|---|-------|------|
| 1 | Left inset + disclosure | 2px rail + 18px, so the 14px `chevron-right` box sits at 20–34 and a 4px gap lands the dot at **38**, one 8px step right of the root's. Revision 2 pinned this dot at 30 because directory headers and single-session directory rows alternated down the list and a stepped dot would have read as jitter; there is no such alternation now |
| 2 | Status dot | **Aggregate**: `--success` when *any* session in the directory is attached. Same rule §3a gives the root header, for the same reason — a collapsed node's only way to say "something live is in here" |
| 3 | Directory label | The directory's own name — its trailing path component, never the full path and never a session name. `--font-ui` `--fs-300`. Middle-truncates (§5). Wins the width fight: `flex: 1 1 auto; min-width: 0` |
| 4 | Count | Bare integer, `--fs-100` `--fg-muted` — **only from 2 up**. This is the one place §1's measurement still binds: a `1` beside a header whose only child is drawn on the next row is exactly the dead field §1 named, and dropping it hands the label back width the new level took |
| 5 | Relative time | **The newest activity in the directory** — which is also the key it sorts on (§6), so a header can never display an older time than a header below it. The alternative (no time) makes a collapsed directory the one row in the panel that cannot answer "was this touched recently?", which is the question the panel exists to answer |

**Header tooltip:** the directory's full path + `1 session` / `3 sessions`.
The phrase form lives only here; the visible count is a bare integer or
nothing.

### 3c. Session row — the leaf, and the only selectable row

`class="session-row child"`, `padding-left: 44px` (dot at 46, one step in from
its header's). Label is the **session name** in `--font-mono`,
middle-truncated (§5) — and this is where middle truncation earns its keep
most, because siblings share a derived prefix by construction:
`git-pocketshell` vs `git-pocketshell-quse`.

| # | Field | Spec | Width at 280px |
|---|-------|------|----------------|
| 1 | Left inset | 2px rail slot + 44px | 46px |
| 2 | Status dot | 8px circle. `--success` when attached, `--fg-muted` otherwise. This plus sort position (§6) **replaces** the `attached` text tag, which stays retired | 8px + 8px gap |
| 3 | Session name | `--font-mono` `--fs-300`; `--fw-semibold` when attached. `flex: 1 1 auto; min-width: 0` | ~208px (flex) |
| 4 | Agent badge | Unchanged (POLISH.md §7 chip metric). `flex: none` | 0–56px |
| 5 | Relative time | `--fs-100` `--fg-secondary` `tabular-nums`, right-aligned, `flex: none` (§6) | ~36px max |
| 6 | Right padding | `--row-pad-x` | 10px |

**The dimmed secondary name field of revision 1 stays deleted.** The leaf now
carries the name as its *primary* label, which is the same width win by a
different route: one label per row, never two competing over ~150px.

**Tooltip** (native `title`): `<session name>\n<full folder path>\n<absolute
time>`, unchanged. It is no longer the only place the name is written, but it
is the only place the name is written *untruncated*, beside the path its
header does not repeat.

### 3d. Orphan row — a session with no directory at all

`class="session-row orphan"`, `padding-left: 36px` — the **directory** dot
column (38), with the chevron column simply left empty, the way any tree draws
a childless node. Otherwise identical to §3c, selectable, label in
`--font-mono`.

This is the one node the panel draws as a single row, and it is **not** the
conditional collapse coming back. The test is not "this directory holds one
session"; it is "there is no directory". A session whose cwd the host never
reported has no folder to put a level at, and its only available label *is*
its session name — so a header above it would print that name twice on
adjacent rows, which is the doubled row that started this whole document. See
§4.4 and §4.6 for how these sessions are labelled and where they are filed.

## 4. Display-label rules

Let `label = defaultLabelForPath(directoryKey(canonicalisePath(session.path), home))`
(sessionGrouping.ts) and `base = sanitisePart(label)` (the regex at
src/shared/sessionNameParts.ts:21-27; see §8 for why it lives there).

1. **Derived-name suppression is now structural, not conditional.** The old
   rule — suppress the secondary name when
   `name === base || name.endsWith('-' + base)` — was written for exactly one
   question: *is this session name just its folder restated?* That question
   now has a structural answer at each level, so the *test* no longer gates
   any rendering:
   - a **directory header** never shows a session name. It is a directory, and
     what it holds is one row down;
   - a **leaf row** always shows its name, whether it has siblings or not.
     Revision 2 made this conditional on having siblings; revision 3 does not,
     because the leaf is now the only row a session has and a row with no
     label is not an option.

   `isDerivedName` stays exported and tested. It still gates
   `flattenSessions`'s `showName`, and it is the shared statement of what
   "derived" means, which §4.6's heuristic leans on.
2. **Divergence** (worktree, custom name): folder `merry-sniffing-token`
   holding session `git-dtc-website`. The row the user circled —
   `● m…ng-token  git-dtc-website…  20h` — put both on one line, both
   truncated, neither readable. Revision 3 puts them on two lines and gives
   each its own: the header says `merry-sniffing-token`, the leaf under it
   says `git-dtc-website`, and neither is fighting the other for width. This
   case is the clearest single argument for the level.
3. **Multi-session directory:** one header label plus N name rows — which is
   now simply the general rule with N > 1, not a separate case.
4. **Untracked** (`path === null` → `UNTRACKED_PATH`): the label is the
   session name itself in `--font-mono`, and each untracked session is its own
   node, drawn as the §3d orphan row. Two things stay deliberate here. They
   are **not** merged into one `Untracked` branch — that branch's children
   would be the same names its parent could not show. (The phone does merge
   them — `Other folders` → `Untracked` → sessions,
   FolderTreeProjection.kt:152-166, 243-250. We diverge knowingly; see §4.6,
   which mostly empties that bucket anyway.) And they are **not** given a
   directory header of their own, for the reason in §3d: the header and the
   child would carry the identical string.
5. **Label collision** (two directories, same basename — `~/git/foo` and
   `~/git/nested/foo`): a post-pass prepends parent segments to the colliding
   labels until unique (`git/foo`, `nested/foo`). **The pass now runs over
   DIRECTORIES, scoped per root.** Per root because `~/git/foo` and
   `~/work/foo` are already told apart by their two headers; over directories
   because that is the level that carries a path-derived label now. Nodes are
   keyed by path; labels are display-only.
6. **No reported cwd → recover the ROOT from the NAME.** New in revision 2,
   and the answer to *"these things are actually under git/ too"*.

   `path` comes back null when tmux reports neither an active-pane cwd nor a
   `session_path` (parsers.ts:189) — a session whose active pane has exited,
   or that never had one recorded. But this app *derives* session names from
   paths: `sessionBaseName` joins the home-relative components with `-` after
   `sanitisePart` (sessionName.ts:66-95), so `~/git/red-stamp-sound` becomes
   `git-red-stamp-sound` and the **leading component of the name is the root**.
   `rootFromSessionName(name, knownLabels)` reads it back.

   Three constraints keep it honest:
   - **Root only, never the directory.** The derivation is not invertible past
     the first component: `-` is both the separator and a legal character
     inside a component, so `git-dtc-website-import` is genuinely ambiguous
     between `~/git/dtc-website-import` and `~/git/dtc-website/import`. A
     name-recovered session therefore sits as a **direct child of the root**,
     alongside the directory rows, with no directory node invented for it.
   - **Only roots that exist from real paths.** The candidate set is built in
     a first pass over sessions that *do* have a cwd. A session called
     `foo-bar` cannot conjure a `foo` root nothing else lives in — the
     heuristic may place a session, never create structure.
   - **It says so.** The row's tooltip reads `no reported folder — root read
     back from the name` where a normal row prints its path. A guess presented
     as a reported cwd is the kind of thing that costs an hour.

   Everything still unplaceable — no path *and* no name match, or a real path
   outside `$HOME` — stays in `other`, which is what keeps `other` honest
   rather than a dumping ground.

   **The phone does not do this** (checked against the v0.4.8 checkout at
   `C:/Users/alexey/git/pocketshell`): a no-cwd session goes to
   `Other folders` → `Untracked`, and both root resolvers hard-refuse the
   sentinel (`FolderTreeProjection.kt:475-477`, `:506-507`). There is no
   name→path inverse anywhere in that codebase, and the last name-derived
   client-side inference was deliberately deleted (issue #1820,
   `FolderSessionNameHelpers.kt:71-76`). So this is a desktop-only heuristic,
   adopted because the phone's behaviour *is* the behaviour the user
   complained about. See §11 for the durable-registry alternative the phone
   has and we do not call.

## 5. Truncation

End-ellipsis is the wrong operator for the primary: `pocketshell` and
`pocketshell-desktop` differ only at the tail. Spec **middle truncation via
the two-span CSS trick** — no measurement code:

- Split the label at `length - 8`: head span
  (`flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`)
  and tail span (`flex: none; white-space: nowrap`). Labels ≤ 12 chars
  render as a single span.
- Overflow then produces `pocketshell-desktop` → (extreme squeeze)
  `poc…-desktop`, `ai-dev-tools-zoomcamp` → `ai-dev-…zoomcamp`: the
  distinguishing tail always survives.
- **The same split also applies to the session NAME**, because every leaf is
  labelled by it (§3c). Revision 1's bullet here said the secondary name could
  end-truncate since the tooltip redeemed it; that was true of a dimmed field
  beside a primary label, and false of a row's only label. Revision 2 applied
  the split to branch children only; revision 3 applies it to every leaf,
  which is now every session. It is also the case with the strongest need:
  siblings in one directory share a derived prefix by construction
  (`git-pocketshell` / `git-pocketshell-quse`), so an end-ellipsis renders
  them identically. `SessionRow` therefore carries `nameHead` / `nameTail`
  beside `labelHead` / `labelTail`, from the same `splitLabel`.
- Tooltip always carries both strings in full (§3).

## 6. Timestamp, sort, and finding "the session I was just in"

**Timestamp → compact relative.** `Aug 24, 01:10 PM` costs ~90px per row to
say what a flat recency-sorted list already says by position. Replace
`fmtTime` (SessionTree.vue:115-119) with: `now` (<60s), `12m`, `3h`, `2d`
(<7 days), then `Aug 12`. Max ~6 characters ≈ 36px at `--fs-100`. Absolute
form moves to the tooltip. Refresh the strings from a `now` ref ticked
every 60s (activity values themselves only change on store refresh, so this
is cosmetic re-rendering only). The comment at SessionTree.vue:13-14 ("the
desktop has the room") is what this reverses — the desktop does not have
the room at 280px.

**Directory sort, applied within each root:** *any session attached* desc →
most-recent activity desc → case-insensitive label asc. **Row sort inside a
directory:** `attached` desc → activity desc (`sessionActivity`) → name asc —
the old row sort, unchanged, now scoped to the directory. **Root sort:**
most-recent activity of any session under the root, desc → case-insensitive
label asc, with `other` pinned last however recent it is (it is a bucket, not
a place, and floating it to the top would put the least-organised rows where
the eye lands first).

- *Attached first* is the "session I was just in" answer, and it is **lifted
  to the directory level** rather than dropped. At the 1:1 distribution a
  directory is a one-session node, so demoting the key would move the session
  the user is currently in off the top of its root — the one thing the sort
  exists to prevent. Revision 3 changes nothing here: the header now sits
  above that session rather than being it.
- The sort is not *global*. A root that has not been touched in a week sits
  below one touched a minute ago even if it holds the second-most-recent
  session. That is the price of the levels, paid knowingly.
- **Expansion is default-on, collapse is manual and remembered.** The state is
  a set of *collapsed* keys, so a node the user has never touched is open —
  which is what makes the tree legible on first sight rather than a wall of
  chevrons to click through.
- Every ancestor of the **open** session is force-expanded on navigation —
  its root *and* its directory — so the current row is never hidden. It is
  expanded on *navigation only*, watched on `props.activeSession`, never on
  the root list. The store refreshes on a timer, so a watch on the list would
  re-expand on every tick and make the node impossible to collapse. **The
  directory level walks into exactly the same trap** and is wired the same
  way; the two levels share one watcher for that reason. Revision 3 makes this
  trap materially more dangerous, because the directory level now exists at
  every node instead of at the rare multi-session one: wire it to the list and
  *nothing in the panel* can be collapsed.
- Collapse state is one `Set` holding both levels, with directory keys
  namespaced `dir:`. Without the prefix a session sitting directly in `~/git`
  would produce a directory key byte-identical to its own root's key, and
  collapsing one would silently collapse the other.
- *Agents-first stays dropped.* The phone's rule (`isAgentSession`, ported
  from FolderTreeProjection.kt:564-568) is a **within-LEAF-folder** tiebreak
  so shells don't bury a folder's agent. A root is not a leaf folder: over
  the 11 one-session leaves inside `git` it would pin all nine agent sessions
  above any shell regardless of recency, hiding exactly the recently-used
  shell the user is looking for. `isAgentSession` stays exported and is still
  used by `groupSessionsByFolder`; agent-ness stays visible as the badge.
- Order recomputes only when the sessions store refreshes (activity is
  refresh-sampled), so rows do not jump mid-hover.

## 7. Panel width

- **Default 280px stands**; the leaf row is still sized to render the real
  data untruncated there, all three levels of indent included (§3.0).
- **Persist it.** Done: `localStorage` key `pocketshell.sessionPanelWidth`,
  clamped to `MIN/MAX_PANEL_WIDTH` on read as well as on write, written once
  per drag rather than per `mousemove`.
- **Minimum:** `MIN_PANEL_WIDTH = 200`, and `.tree`'s `min-width` matches it
  (it used to say 240, contradicting the clamp). The container-query floor has
  now moved twice, by the same arithmetic each time: **230 → 250** when
  revision 1's flat row gained the 28px root indent (18px), and **250 → 270**
  in revision 3, when the leaf gained another 16px of indent *and* swapped a
  short directory basename for a full session name. Below the floor the
  *timestamp* drops first (`@container (width < 270px) { .row-time { display:
  none } }`); it is the least operational field, and a recency-sorted list
  already carries most of what it says. Dot, label, and badge survive to the
  200px floor. **The rule stays unscoped**, so a directory header drops its
  aggregate age at the same width its children drop theirs — a header still
  showing a time above rows that had theirs removed would read as the header's
  own, separate fact.
- 270 leaves only 10px of headroom under the 280px default, which is tight and
  is recorded as such in §11: one drag narrower and the times go. The
  alternative was to leave the floor at 250 and let the leaf label truncate
  instead, which trades a field the sort order already implies for the field
  that identifies the row. Times lose.

## 8. Implementation notes

- **Three projections, one module, one row builder.**
  `src/renderer/sessionGrouping.ts` exports:
  - `groupSessionsIntoRoots(sessions, home): SessionRootFolder[]` — what the
    panel renders. `SessionRootFolder = { key, label, directories,
    sessionCount, mostRecentActivity, active, other }`, and
    `SessionDirectory = { key, path, label, labelHead, labelTail, rows,
    mostRecentActivity, active, untracked, inferredRoot }`. **Revision 3
    changes no field here.** The projection was already uniform; it was the
    renderer that branched on `rows.length === 1`, and that test is gone.
    `rows.length` is now a count and nothing else — the only thing that still
    reads it is the header's `≥ 2` count field (§3b).
  - `flattenSessions(sessions): SessionRow[]` — the tree's degenerate case and
    the row model's direct test surface.
  - `groupSessionsByFolder(sessions): SessionFolder[]` — the phone-parity LEAF
    grouping. Nothing renders it; it stays because it is the parity anchor and
    the shape the folder-first creation flow speaks.

  All three go through one private `buildRows`, so they cannot disagree about
  a label. `buildRows` deliberately does **not** disambiguate — the correct
  scope differs (§4.5), so each projection applies `disambiguateLabels` over
  its own scope. That helper is generic over `{label, labelHead, labelTail,
  untracked}` plus a `pathOf` accessor, because two levels now need it: the
  flat list's rows and the tree's directories.
- **Keys at both levels are written home-relative.** `rootForPath(path, home)`
  returns `{ key: '~/git', label: 'git' }`; `directoryKey(path, home)` applies
  the same rewrite at full depth and returns `~/git/dataops`. Both sit on one
  private `homeRelative`. Writing the key as `~/git/dataops` rather than
  `/home/alexey/git/dataops` is what folds the two spellings tmux reports for
  one directory into a single node: the absolute path from the active pane,
  and the literal unexpanded `~/git/...` that `session_path` can carry
  (src/main/helper/parsers.ts, `parseSessionEnrichment`). **Without it at the
  directory level, one directory reported both ways renders as two identically
  labelled rows sitting next to each other** — which is the failure the root
  level was already guarding against, one level down. A `~` prefix needs no
  `home` to resolve. Note this is the one place `~` is resolved;
  `canonicalisePath` still deliberately never expands it, so the grouping key
  and the *displayed* path stay separate.
- **A no-cwd session is modelled as a degenerate directory.** Key
  `"::untracked:: <name>"`, path `UNTRACKED_PATH`, label = the session name,
  `untracked: true`, exactly one row. That is what lets §4.6's name-recovered
  rows sit *alongside* directory nodes in one sorted list under a root,
  instead of a second loose-row array threaded through the same sort.
  `inferredRoot` is set by the pairing `untracked && root !== other` — there
  is no other way an untracked row can be anywhere but `other`. The renderer
  reads `dir.untracked` (never `rows.length`) to draw it as the §3d orphan
  row: the model says "there is no directory here", and that is the only
  question the template is allowed to ask about a node's shape.
- **`other` is honest, not a dumping ground.** After §4.6 it holds: paths
  outside `$HOME` (`/var/log`, `/srv/app` — they genuinely share no parent
  with the rest), sessions sitting in `$HOME` itself (no root folder to be
  named after), and sessions with neither a path nor a name that names a real
  root. Directory grouping applies inside it too: `/var/log` gets a `log` row
  like any other directory. **`$HOME` itself renders as `~ (home)`**, not as
  the account name — its key collapses to `~`, so there is no leaf component
  left and `defaultLabelForPath`'s named fallback takes over. That is the
  better label regardless: a row reading `alexey` looks like a user, not a
  project.
- **`$HOME` is fetched, then inferred.** The panel calls
  `api.projects.home(connectionId)` directly rather than
  `projects.loadHome()`, because that store action also lands the folder
  BROWSER on `$HOME` — an SFTP directory listing the panel has no use for. A
  failure is not surfaced: `inferHome` then reads the shape of the paths we
  already have (`/home/<user>`, `/Users/<user>`, `/var/home/<user>`, `/root`,
  most frequent wins). That fallback exists because with no home *every*
  absolute path falls into `other` — one undifferentiated bucket, i.e.
  precisely the view this revision replaces. It is a fallback and is scoped
  like one: only the standard home parents count.
- **`sanitisePart` reaches the renderer via shared.** Unchanged. It (and only
  it) lives in `src/shared/sessionNameParts.ts`, re-exported by
  `src/main/projects/sessionName.ts` for that module's callers, so the
  renderer's redundancy test (§4.1) runs the derivation's own regex instead of
  a duplicate. Covered by tests/unit/sessionNameParts.test.ts.
- **In SessionTree.vue.** Root `<section>`/header/chevron and the `collapsed`
  state are unchanged since revision 1; the `dir-header` pair, the `dir:` key
  namespace, the two-level expand watcher and `dirTooltip` are unchanged since
  revision 2. **Revision 3 deletes exactly one thing and moves three numbers.**
  Deleted: the `v-if="dir.rows.length === 1"` arm and the whole single-session
  row it rendered. Moved: `.dir-header` padding-left 10 → 18 (dot 30 → 38),
  `.session-row` padding-left 28 → 44 as the base rather than a `.nested`
  override, and the container query 250 → 270. Added: `.session-row.orphan`
  (§3d) and the `≥ 2` guard on the header count. The outer `<ul>` is now
  `.dir-list` and the inner one `.session-list`, because the two lists no
  longer hold the same kind of thing. `.row-name` stays deleted and the
  `attached` text tag stays retired.
- **Design gates** (tests/unit/designGates.test.ts): no new hex — every colour
  above is an existing token; no character-as-icon — both disclosures are
  `AppIcon name="chevron-right"` rotated 90°, never `▸`, and every dot remains
  a styled span.

## 9. Documentation to revise

- **sessionGrouping.ts header comment** — done: it records that the projection
  is uniform and that the renderer no longer branches on `rows.length`.
- **SessionTree.vue header comment** — done: it carries the three-level sketch
  from §2, states that revisions 1 and 2 were wrong and why, and explains the
  one node type (§3d) that is still a single row.
- **docs/DESIGN.md, session-panel anatomy** — **still outstanding**, and now
  wrong in a third way. Its blockquote still reads "Superseded by
  docs/SESSIONLIST.md (implemented). The two-level tree below is gone… The
  panel is now flat", and its table still retires `.folder-header` /
  `.disclosure` / the 28px indent. All three are back; there are now *two*
  disclosures; the indent is 8px per level to a 46px leaf inset, not 28px; the
  container-query floor is 270px not 230px; and `.row-name` should be retired
  in its place. Left unedited only because the file has been dirty under
  concurrent editors across all three revisions.
- **docs/POLISH.md** — §7's chip metric is unchanged and the `attached` chip
  stays retired. §2.6/§4's disclosure entry (`▸` → `AppIcon
  name="chevron-right"`, POLISH.md:239, 370) is live again and now applies at
  two levels. The `·` separator entry (POLISH.md:269, `· 2 sessions`) is still
  wrong: both counts are bare integers, and the phrase form lives in tooltips.
- **docs/screenshots** — `polish-02`/`polish-13` are older still, and
  `projects-20`…`projects-24` document a layout that no longer ships.
  Recapture against a fixture with two or more `$HOME` roots, ≥10 one-session
  directories under one of them (the case all three revisions have argued
  about and none has photographed), one directory holding 2+ sessions, a
  worktree-divergent name, one out-of-`$HOME` session, and one session with no
  reported cwd whose name names a real root (§4.6).

## 10. The load-bearing four

1. **Three levels, always.** Root → directory → session, with no size at which
   a level folds away. A directory holding one session still gets its header
   and its child; the only single-row node is a session that has no directory
   at all (§3d).
2. **~~The branch is conditional, which is what reconciles this with §1.~~**
   Struck. This was revision 2's load-bearing claim and it is what produced a
   panel the user rejected three times: at the measured 1:1 distribution the
   condition fires everywhere and the tree renders as a flat list. §1's
   measurement is real; "spend a row only where there is fan-out" is a fine
   rule for a row budget and the wrong rule for a structure the user has
   asked to see. What survives of §1 is the `1` count, dropped from a
   one-session header (§3b field 4).
3. **A directory row toggles; it never selects.** `select` is emitted from
   leaves only and still carries a `SessionSummary`, so
   `HostWorkspaceView.onSelectSession` never learns any of this happened.
4. **The expand-on-navigate watcher is on the active session at BOTH levels.**
   The store ticks on a timer; a watcher on the node list makes a node
   impossible to collapse. The trap is level-agnostic, and now that every
   directory is a node, falling into it would freeze the entire panel open.

## 11. Not evaluated

**No app run** — concurrent renderer edits meant `npm run dev` was not
attempted; unit tests and typecheck are the only verification.

- All width arithmetic uses nominal font metrics (13px UI ≈ 6.5px/char,
  11px ≈ 5.5px/char). The **270px** container-query breakpoint and the leaf's
  62px label inset need a live check at the user's DPI — and 270 sits only
  10px under the 280px default, so if the metrics are optimistic the times
  will disappear at a width the user thinks of as "normal".
- **Whether an 8px step reads as nesting at all** at 13px UI type. It is VS
  Code's step, but VS Code draws indent guide lines and this panel does not.
  If it reads flat, the honest fixes are a guide line or 10-12px steps with a
  higher container-query floor — not a return to collapsing the level.
- The dot-column arithmetic in §3.0 (dots at 30 / 38 / 46) is arithmetic, not
  a screenshot.
- **Whether the doubled row count is felt.** At the measured distribution this
  design draws ~23 rows where revision 2 drew 12. Nothing in the panel breaks,
  but "I have to scroll now" is a real complaint and the answer to it —
  collapse the directories you are not using — has to be discoverable enough
  to count as an answer.
- Whether any real host produces the label-collision case in §4.5, which is
  now scoped per root *and* moved to directories, and therefore rarer still.
- **App-level roots against several differently-shaped hosts** (§12.2.4). A
  user whose boxes do not share a layout gets every registered root on every
  host, some of them permanently empty. The honest fixes if that bites are a
  per-host override or hiding an empty root behind a toggle — not making the
  root list per-host by default, which is the cost the phone pays.
- **Whether §12.2.3 is the wrong call.** The phone collapses a session's
  folder to the first segment under its root, so `~/git/pocketshell/tools`
  groups under `pocketshell`; we keep the full directory and show `tools` as a
  sibling of `pocketshell`. If the user's real tree has sessions running below
  a project's own root, ours will read as flatter than it is.
- **How many of the `other` sessions §4.6 actually rescues**, and whether the
  root it picks is right. The user named three (`git-dtc-website-import`,
  `git-red-stamp-sound`, `git-game-tester`); all three should land under
  `git`. This is the one change whose failure mode is *confidently wrong*
  rather than merely unhelpful, so it deserves a look at the real panel.

### The alternative to §4.6 that we did not build

The phone carries a durable **session → folder registry** the desktop never
calls: `pocketshell tree get` / `tree upsert` / `tree reconcile`, a daemon RPC
persisting `{session, order, folder_path, collapsed}` per node to an atomic
0600 JSON file under XDG state (`tools/pocketshell/src/pocketshell/tree.py`:
node shape at :212-219, `get_tree` at :373-392, `upsert_tree` at :395-433;
Kotlin client `TreeRemoteSource.kt:58-66, :172, :206`). That would give a
*recorded* folder for a session whose cwd probe has gone quiet — the real fix,
not a heuristic.

**It is not a drop-in, for three reasons.** (1) On the phone it is a
cold-start seed only: `HostTreeModel.hydrate` bails if a snapshot already
exists (HostTreeModel.kt:268-286) and the next reconcile overwrites
`folder_path` from the live probe (:929-930), so as used there it is *not* a
fallback for "no cwd reported" — adopting it as one is new behaviour, not a
port. (2) It means writing on session create as well as reading, or the
registry is empty for everything that already exists. (3) The checkout is
v0.4.8-era while hosts run 0.4.44 (docs/ANALYSIS.md), so the command surface
is a lead to verify, not a contract.

Cost estimate: one new helper command in `src/main/helper/commands.ts` plus a
parser, an IPC route, a store field, and an `upsert` on the create path —
meaningfully more than `rootFromSessionName`, and it fails closed (empty
registry → today's behaviour) rather than fails wrong. **Left for the user to
decide.** §4.6 is deliberately shaped so it can be deleted the day the
registry lands.

## 12. Registered roots — the top level, configured

Added alongside revision 3, on a second request from the user:

> "I also want to add other roots (like ~/tmp) and have a part of the tree for
> other sessions that don't start with existing roots. like in pocketshell app.
> the roots are registered in the settings"

**The root level stops being derived and becomes declared.** The user registers
roots in Settings — `~/git`, `~/tmp`, anything — and those are the panel's top
level, in the order they registered them. Everything under no registered root
goes to `other`, which keeps its existing job and its pinned-last position.

This is the phone's **watched roots** concept, which is what §1 named as the
reason the phone does not have the desktop's problem: "The phone does not have
this problem because its top level is *watched project roots*, not individual
folders." The desktop implemented only the phone's no-watched-roots fallback
and synthesised a root level from `$HOME`'s children instead (the old §2 note,
"the desktop still has no project-roots table"). §12 closes that gap.

### 12.1 What is ported from the phone, exactly

Matching semantics come from `FolderTreeProjection.kt` and are ported
verbatim, because they are the behaviour the user already knows:

| Rule | Phone | Here |
|---|---|---|
| Prefix match on a `/` boundary — `~/git` never claims `~/gitlab` | `pathWithinRoot`, :310 | `pathWithinRoot` |
| Longest match wins when roots nest; first-registered breaks a tie | `bestRootForPath`, :475-479 | `bestRootForPath` |
| A session sitting exactly ON a root belongs to it | `pathWithinRoot`, :310 | same |
| Unmatched folders go to a synthetic `other` root, appended last | :165-167, :276 | unchanged from §6 |
| A registered root with no sessions still renders | roots are built by iterating the root list, :179-241 | roots are seeded before rows are placed |
| Label = the root's trailing segment | `defaultLabelForPath`, :41-50 | same function, already shared |

### 12.2 Where we diverge, and why

1. **No-roots fallback.** The phone, with zero watched roots, puts *everything*
   into one `Other folders` node (`FolderTreeProjection.kt:253-274`). We keep
   deriving roots from `$HOME`'s children instead. The phone's behaviour is
   defensible there because its onboarding pushes the user through the watched-
   folders screen; here it would mean every existing install woke up one
   morning to the single undifferentiated bucket that revision 1 was written to
   destroy. Empty means "derive", and the panel a user who never opens Settings
   sees is byte-identical to the one they had.
2. **Deduplication is on the RESOLVED key, not the stored spelling.** The phone
   dedupes with `distinctBy { it.path }` over stored paths
   (`FolderTreeProjection.kt:449`), so registering both `~/git` and
   `/home/me/git` gives two nodes that look identical and split the sessions
   between them by longest-match. `resolveRoots` folds them, because two
   identical branches is a bug however it is arrived at.
3. **The directory level keeps the FULL directory.** The phone collapses a
   session's folder to the first segment under its root
   (`projectPathUnderRoot`, :538), so `~/git/pocketshell/tools` groups under
   `pocketshell`. That is genuinely attractive: it makes the middle level mean
   *project*, and it bounds the tree to three levels by construction, which is
   §2's own goal. We did not take it, for now, because the middle level's
   meaning — "the directory this session actually runs in" — is what §3b's
   label, §4.5's collision pass and §3c's tooltip are all built on, and
   changing it is a third redesign of a level neither user request mentioned.
   **This is the divergence most likely to be wrong**, and it is cheap to
   revisit: it is one projection of the directory key.
4. **Roots are app-level, not per host.** The phone keys `project_roots` by
   `hostId` (`ProjectRootEntity.kt:26-32`). A registered root is written
   home-relative and `~/git` names the same place on every host, so a per-host
   list would mostly make the user register the same three roots repeatedly.
   The cost is real and is recorded in §11: a user whose boxes genuinely have
   different layouts gets every root on every host, some of them empty.
5. **No ordering hack.** The phone has no `order` column and encodes position
   as a `[NN] ` prefix inside the label
   (`WatchedFoldersViewModel.kt:428-451`). A JSON array has an order already.
6. **Suggestions come from the session list, not a remote scan.** The phone
   runs a remote `ls` over three guessed parents
   (`WatchedFoldersViewModel.kt:397`). The Settings panel opens from the host
   picker with no connection at all, so it reads the roots off the sessions
   already loaded — which is, by definition, where the user's roots are.

### 12.3 Storage and normalisation

`settings.sessionRoots: string[]`, default `[]`, in the existing
`pocketshell.settings.v1` blob. Its parser rejects only a NON-ARRAY outright;
inside an array, damage is per entry (`normaliseRootList`), so one hand-edited
line costs that line and not the user's root list — the same per-key degradation
rule the store already applies per setting, one level down.

**Two forms, and the split is the point.**

- The **stored** form is what the user typed, cleaned: trimmed, trailing
  slashes dropped, `..` refused rather than resolved, control characters
  refused, and anchored to `/` or `~`. `~/git` and `/home/alexey/git` are still
  two different stored strings, because settings are app-level while `$HOME` is
  per-host and at write time there is no home to fold them against.
- The **resolved** form is `directoryKey(stored, home)` — *the same function*
  that already folds tmux's two spellings of one directory into one node (§8).
  Reusing it rather than writing a second normalisation is what stops the two
  rules drifting: if `~` resolution ever changes, it changes in one place.
  Dedupe happens here, on the resolved key.

### 12.4 Decisions the two features force on each other

- **An empty registered root still renders**, with a `0` count and a muted
  "no sessions here yet" line under it. A registered root is a statement of
  intent, not a fact derived from the session list — it is the user saying
  "this is where my work lives", which stays true on a host where nothing is
  running there and on a host where the directory does not exist. A setting
  that silently shows nothing reads as a broken setting. `SessionRootFolder`
  carries `configured` so the panel can say "registered in Settings — nothing
  running here" rather than leaving a bare `0` to be interpreted.
- **Registered roots render in registered order; derived roots keep the
  recency sort** (§6). A declared list is itself an ordering, and re-sorting it
  by activity would let the sessions store's refresh timer reshuffle the
  panel's top level under the user's cursor — the same class of problem as the
  expansion watcher in §6, one level up. With nothing declared, recency is the
  only ordering there is.
- **The §4.6 name heuristic files into registered roots.** Its rule was "only
  roots that exist from real paths", so it could place a session but never
  invent a place. A REGISTERED root is stronger evidence than an inferred one,
  so with roots configured the candidate set is the registered list — which
  means a no-cwd session called `tmp-scratch` reaches `~/tmp` even when nothing
  else is running there. The constraint is unchanged in spirit: the heuristic
  still cannot create a root, it can only file into one that already exists.
- **Nesting is longest-match.** Register `~/git` and `~/git/work` and a session
  in `~/git/work/thing` lands under `work`: the more specific declaration is
  the more deliberate one.

### 12.5 The Settings control

A `Session panel` group holding one stacked row: the registered list, each
entry showing its **stored spelling** in `--font-mono` (that string is what the
panel matches against, so rendering a paraphrase of it would be a lie) with a
`trash-2` remove button, then a text field plus an `Add` button. The field is
backed by a `<datalist>` of the roots the current host's sessions are running
under, minus what is already registered — a user should not have to remember
paths on a machine they are not looking at. Typing is still allowed, because a
root you have not yet started a session in cannot be suggested and registering
one ahead of time is a legitimate thing to want.

Rejections are sentences, not a silent no-op, and the two reasons a
well-formed path can still be refused — already registered, list is full — are
told apart, because they call for different next actions.

---

## 13. Why the panel's `+` does not ask which agent

Two dialogs exist and they were deliberately kept apart (commit `00eb3e7`):

| Dialog | Question it answers |
|---|---|
| `NewSessionDialog` | **which folder** — browse, create or clone one |
| `LaunchSessionDialog` | **which agent**, in a folder already chosen |

Revision 5's `+` controls could plausibly ask both, and they do not. They open
`NewSessionDialog` and stop. The reasons are ordered from cheapest to
load-bearing:

1. **The second question already has a better place to be asked.** Creating
   from the panel lands the user in that folder's workspace, on the new
   session's tab, where the workspace's own `+` answers "which agent" one click
   away — for this session and every later one. Chaining would ask it twice.

2. **`NewSessionDialog` ends on a banner that must not be interrupted.** Its
   outcome does not auto-dismiss, deliberately: `via: 'tmux-fallback'` means
   the session was created with **no memory cap**, and `code: 'folder-missing'`
   guards a real helper trap. A chained dialog would either preempt that or
   stack on top of it.

3. **The two have incompatible ORDERINGS, and this is the real objection.**
   `NewSessionDialog` creates the session when Start is pressed.
   `LaunchSessionDialog`'s whole design is that it creates nothing — it emits a
   validated choice and the caller creates, so "cancel costs nothing" and a
   malformed launch is caught *before* anything exists on the host. That
   property is the fix for the bug it was written to replace. Chaining
   folder → agent AFTER the create inverts it: cancelling the agent step would
   leave a stray session behind. Chaining it before would mean deferring
   `NewSessionDialog`'s commit, which is the one path all three of its routes
   converge on.

4. **The launch mechanism is not the panel's to run.** Setting `@ps_agent_kind`
   means typing the wrapper command *inside* the session once its PTY exists,
   which is why `pendingLaunch` and `LAUNCH_TIMEOUT_MS` live in
   `FolderWorkspaceView` next to the terminal. The panel has no terminal. A
   second copy of the trickiest part of that flow is exactly the drift the two
   dialogs were split to avoid.

**If it ever should chain,** the shape is: `NewSessionDialog` gains a mode that
resolves a folder and *emits* it without starting anything, the panel then
raises `LaunchSessionDialog`, and only the confirm creates. That is a change to
the commit path, not a wiring change, and it is why it is not in revision 5.
