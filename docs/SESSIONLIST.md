# SESSIONLIST.md — Session panel: the folder view

Status: **implemented.** Originally written as "flatten the tree" against
commit `b55ec9f`, implemented in `3d90f2b`, **revised once** when the user
asked for the folder view back:

> "for the left side panel — I want something like a folder view. git /
> sessions … tmp / sessions other sessions. like we have in the app"

and **revised again** — this document — when the user circled a row rendering
as `● m…ng-token  git-dtc-website…  20h` and said:

> "this should be the directory, not session name. but if we have multiple
> things in a directory then we have another branch in the tree where we show
> multiple sessions with their names."

plus, on the same panel, three sessions sitting in `other`:

> "these things are actually under git/ too."

**What revision 2 changes.** The second level stops being a flat list of
session rows and becomes a list of **directories**. A directory holding one
session is that session's row, labelled by the directory. A directory holding
two or more becomes a **branch** whose children are the session names. And a
session whose cwd the host never reported is filed under the root its **name**
names, instead of falling into `other` (§4.6).

**Why this does not contradict §1.** §1 measured a 1:1 folder:session
distribution and concluded a folder *header* costs a row to say nothing. That
conclusion is untouched and is the reason this design is shaped the way it is:
there is **no header at 1:1**. The directory row *is* the session row, so the
common case costs exactly zero extra rows and zero extra chevrons — the same
row count the flat list had. The branch appears only where a directory really
does hold more than one session, i.e. precisely where the old leaf header had
something to say and the flat row had to fall back on a dimmed secondary name
(the old §4.3). Revision 1 answered §1 by moving the header *up* to the root;
revision 2 answers it by making the level *conditional*. Both readings of §1
are the same reading: **spend a row only where there is fan-out.**

Sections rewritten by revision 2: §2 (the position), §3b/§3c (row anatomy),
§4 (all of it — the label rules move up a level), §6 (sort and expansion),
§8 (implementation), §9, §10, §11. Sections unchanged and still binding: §1
(the measurement), §3a (the root header), §5 (middle truncation), §7 (panel
width, except the container-query note in §3c).

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

## 2. Position: two levels, and every row is named by a DIRECTORY

**Group sessions by the first path component under `$HOME` — `git`, `tmp` —
with an `other` catch-all. Inside a root, group by the working DIRECTORY. A
directory with one session renders as one row, labelled by the directory, that
selects that session. A directory with two or more renders as a collapsible
branch whose children are the session names.**

```
v git                      root header  (unchanged, §3a)
    dtc-website            one session here -> the directory row IS its row
  v pocketshell            two sessions here -> a branch
      git-pocketshell      the session name, and only here
      git-pocketshell-quse
    dataops
> other                    unchanged catch-all
```

### Why the level is free at 1:1

§1's measurement is the load-bearing input, not an obstacle. It says: at 11
folders and 11 sessions, a folder *header* buys nothing, and since the session
name is derived from the folder path (`~/git/dataops` → `git-dataops`,
sessionName.ts:66-95) the header and the row were the same fact twice.

This design pays that bill by **not emitting a header at 1:1**. The directory
and the session are one row. Compared with revision 1's flat list the common
case is not one row heavier, one indent deeper, or one chevron busier — it is
byte-for-byte the same row, with a better label:

| Distribution | Rev 1 (flat rows) | Rev 2 (directories) |
|---|---|---|
| 11 folders, 1 session each | 11 rows | **11 rows** |
| 1 folder, 3 sessions | 3 rows, each with a dimmed secondary name | 1 branch + 3 rows |

The second line is the trade, and it is the one the user asked for by name. It
is also strictly better than what it replaces: the old §4.3 handled the
multi-session folder by turning the secondary session-name field on for every
one of its rows, which is the doubled `label + dimmed name` row the user
circled. A branch says the folder **once**, at the top, and then says only what
differs.

### Why the primary label is the directory, never the session name

The session name is *derived from the path*, so as a row label it is a lossy
restatement of the folder with a root prefix bolted on (`git-dataops` for
`~/git/dataops`, already sitting under a header that says `git`). The folder
basename is shorter, more distinctive, and it is what the user navigates by.
The name survives in the tooltip, always, and gets its own rows in a branch.

**The dimmed secondary name field is retired.** It existed to answer "which
session is this?" on a row named by a folder, and both cases it covered now
have a better answer: siblings get a branch, and a lone session does not need
disambiguating from anything. Retiring it also removes the middle-truncation
collision the user circled — two competing labels fighting over ~150px.

### Still rejected

- **A header per leaf folder** — §1, and the reason this document exists.
  A *conditional* branch is not that: it appears only above ≥2 sessions.
- **Group by agent kind or recency bucket** — agent kind is already a badge
  and recency is already the sort.
- **Recovering the DIRECTORY from a session name** — see §4.6. The derivation
  is not invertible, and a guessed directory row is worse than none.
- **A third directory level (nesting `~/git/a/b` under `~/git/a`)** — nothing
  in the real data has it, and it would reintroduce §1's dead row for every
  intermediate directory that holds no session of its own.

The desktop still has no project-roots table, so roots are **synthesised from
the session paths** rather than read from one (§8). That is a real difference
from the phone and is recorded as one: the desktop can only ever show roots
that currently hold a session, where the phone also lists sessionless project
folders to create into. The `New session` footer button is what covers the
gap — creation is folder-first through its own picker.

`sessionGrouping.ts` keeps all three projections. `canonicalisePath` /
`defaultLabelForPath` / `sessionActivity` remain the shared label and ordering
rules; `groupSessionsByFolder` remains exported as the phone-parity anchor for
the LEAF level even though nothing renders it; and the root projection and the
flat projection are built from one shared row builder (§8), so they cannot
disagree about what a folder is called.

## 3. Row anatomy

**Three** row types now, all height `--row-h` (28px, docs/DESIGN.md:535).
Budget at the 280px default (HostWorkspaceView.vue:36); every selectable row
keeps the 2px selection rail slot + accent rail for `current`.

### 3a. Root header row

A `<button>`, so collapse is keyboard-reachable and `aria-expanded` is real.

| # | Field | Spec |
|---|-------|------|
| 1 | Disclosure | `AppIcon name="chevron-right"` at 14px, rotated 90° when open — the app's one disclosure pattern, shared with `ConversationView`. Never a text glyph (designGates gate 2) |
| 2 | Status dot | The same 8px dot the session row uses, `--success` when **any** session under the root is attached. This is the collapsed root's only way to say "something live is in here", which is the state where it matters |
| 3 | Root label | `--font-ui` `--fs-300` `--fw-semibold`, `flex: 0 1 auto; min-width: 0`, end-ellipsis. The `other` bucket renders `--fw-regular` `--fg-secondary` instead: it is a bucket, not a directory the user could navigate to |
| 4 | Count | Bare integer, `--fs-100` `--fg-muted` `tabular-nums`, `margin-left: auto`. **Not** `· 3 sessions` — the number is the whole message, and the phrase form retreats to the header tooltip |

**Header tooltip:** `~/git` + `3 sessions`. The path is written home-relative
because the grouping key *is* home-relative (§8). The `other` header says
`sessions outside $HOME, or with no known folder` instead, since it has no one
path to name.

### 3b. Directory row (one session) — the common case

Selects the session. `class="session-row"`, exactly as the flat row was.

| # | Field | Spec | Width at 280px |
|---|-------|------|----------------|
| 1 | Left inset | 2px rail slot + **28px child indent**, which puts the row's dot exactly under its root header's dot and the row label under the header label. (28, not `--sp-4`: the header is `--sp-2` + a 14px disclosure box + an `--sp-2` gap = 30px to its dot.) | 30px |
| 2 | Status dot | 8px circle. `--success` when attached, `--fg-muted` otherwise. This plus sort position (§6) **replaces** the `attached` text tag, which stays retired | 8px + 8px gap |
| 3 | **Directory** label | The directory's own name — its trailing path component, never the full path and never the session name. `--font-ui` `--fs-300`; `--fw-semibold` when attached. Middle-truncates (§5). Wins the width fight: `flex: 1; min-width: 0` | ~190-230px (flex) |
| 4 | Agent badge | Unchanged (POLISH.md §7 chip metric). `flex: none` | 0-56px |
| 5 | Relative time | `--fs-100` `--fg-secondary` `tabular-nums`, right-aligned, `flex: none` (§6) | ~36px max |
| 6 | Right padding | `--row-pad-x` | 10px |

**Field 4 of revision 1 — the dimmed secondary session name — is deleted.**
That is the single biggest width win in this revision: worst case now leaves
the label ~190px instead of ~90px, so `ai-dev-tools-zoomcamp` (21 chars, the
longest label in the real data set) has room to spare and the middle-truncation
in the screenshot simply stops firing at the default width.

An **untracked** session (no reported cwd) still renders in this row type, with
its own name as the label in `--font-mono` — it has no directory to be named
after, so its name is the only label there is. See §4.6 for where it is filed.

**Tooltip** (native `title`): `<session name>\n<full folder path>\n<absolute
time>`, unchanged. This is now the *only* place a lone session's name is
written, which is the point — it was never the operational fact, and the
tooltip always carried it.

### 3c. Directory branch (two or more sessions)

A `<button class="dir-header">` — collapse is keyboard-reachable and
`aria-expanded` is real — followed by a nested `<ul>` of session rows.

| # | Field | Spec |
|---|-------|------|
| 1 | Left inset + disclosure | 2px rail + 10px, so the 14px `chevron-right` box sits at 12-26 and a 4px gap lands the dot at **30 — the same column as a §3b row's dot and the root header's**. Two row types alternate freely down the list; a stepped dot would read as jitter |
| 2 | Status dot | **Aggregate**: `--success` when *any* session in the directory is attached. Same rule §3a gives the root header, for the same reason — a collapsed branch's only way to say "something live is in here" |
| 3 | Directory label | Identical to §3b field 3, so the branch and its single-session siblings are visibly the same kind of thing |
| 4 | Count | Bare integer, `--fs-100` `--fg-muted`, `margin-left: auto`. Always ≥2 |
| 5 | Relative time | **The newest activity in the directory** — which is also the key it sorts on (§6), so a branch can never display an older time than a branch below it. The alternative (no time) makes a collapsed branch the one row in the panel that cannot answer "was this touched recently?", which is the question the panel exists to answer |

**Branch child row:** `class="session-row child"`, `padding-left: 44px` (dot at
46, one level in from the branch label). Label is the **session name** in
`--font-mono`, middle-truncated (§5) — and this is where middle truncation
earns its keep most, because siblings share a derived prefix by construction:
`git-pocketshell` vs `git-pocketshell-quse`. Dot, badge, and time are the §3b
fields unchanged.

A child row is ~16px deeper than a §3b row and so truncates sooner. Accepted:
the branch is the rare case, and its label is the one place a full session name
genuinely has to fit.

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
   - a **lone session** never shows its name on the row at all. There is
     nothing to disambiguate it from, so the question does not arise;
   - a **branch child** always shows its name. Its siblings share the
     directory by construction, so the name is the only thing that separates
     them — this is the old rule 3 (multi-session folder), generalised from
     "show the secondary anyway" to "the name IS the row".

   `isDerivedName` stays exported and tested. It still gates
   `flattenSessions`'s `showName`, and it is the shared statement of what
   "derived" means, which §4.6's heuristic leans on.
2. **Divergence** (worktree, custom name): folder `merry-sniffing-token`
   holding session `git-dtc-website`. **Revised: the row shows the folder
   only**, and the name retreats to the tooltip. Revision 1 showed both, and
   that row — `● m…ng-token  git-dtc-website…  20h` — is the screenshot the
   user circled. Two labels, both truncated, neither readable. The folder is
   the fact the user navigates by; the name is a lookup key.
3. **Multi-session directory:** superseded by the branch (§3c). What was a
   per-row secondary field is now one branch label plus N name rows.
4. **Untracked** (`path === null` → `UNTRACKED_PATH`): the label is the
   session name itself in `--font-mono`, and each untracked session is its own
   single-session node. They are deliberately **not** merged into one
   `Untracked` branch: that branch's children would be the same names its
   parent could not show, i.e. a level of nesting that hides the one fact the
   row carries. (The phone does merge them — `Other folders` → `Untracked` →
   sessions, FolderTreeProjection.kt:152-166, 243-250. We diverge knowingly;
   see §4.6, which mostly empties that bucket anyway.)
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
- **Revised: the same split now also applies to the session NAME**, because a
  branch child is labelled by it (§3c). The old bullet here said the secondary
  name could end-truncate since the tooltip redeemed it; that was true of a
  dimmed field beside a primary label, and false of a row's only label. It is
  also the case with the strongest need: siblings in one directory share a
  derived prefix by construction (`git-pocketshell` /
  `git-pocketshell-quse`), so an end-ellipsis renders them identically.
  `SessionRow` therefore carries `nameHead` / `nameTail` beside
  `labelHead` / `labelTail`, from the same `splitLabel`.
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
branch:** `attached` desc → activity desc (`sessionActivity`) → name asc — the
old row sort, unchanged, now scoped to the branch. **Root sort:** most-recent
activity of any session under the root, desc → case-insensitive label asc,
with `other` pinned last however recent it is (it is a bucket, not a place,
and floating it to the top would put the least-organised rows where the eye
lands first).

- *Attached first* is the "session I was just in" answer, and revision 2
  **lifts it to the directory level** rather than dropping it. At the 1:1
  distribution the directory row *is* the session row, so demoting the key
  would move the session the user is currently in off the top of its root —
  the one thing the sort exists to prevent.
- The sort is not *global*. A root that has not been touched in a week sits
  below one touched a minute ago even if it holds the second-most-recent
  session. That is the price of the levels, paid knowingly.
- Every ancestor of the **open** session is force-expanded on navigation —
  its root *and* its branch — so the current row is never hidden. It is
  expanded on *navigation only*, watched on `props.activeSession`, never on
  the root list. The store refreshes on a timer, so a watch on the list would
  re-expand on every tick and make the node impossible to collapse. **The new
  directory level walks into exactly the same trap** and is wired the same
  way; the two levels share one watcher for that reason.
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

- **Default 280px stands**; the session row is still sized to render the real
  data untruncated there, indent included (§3b).
- **Persist it.** Done: `localStorage` key `pocketshell.sessionPanelWidth`,
  clamped to `MIN/MAX_PANEL_WIDTH` on read as well as on write, written once
  per drag rather than per `mousemove`.
- **Minimum:** `MIN_PANEL_WIDTH = 200`, and `.tree`'s `min-width` matches it
  (it used to say 240, contradicting the clamp). **Revised: the
  container-query floor moves from 230px to 250px** — the 28px child indent
  costs the row 18px against the flat version, so it runs out of width that
  much sooner. Below it the *timestamp* drops first (`@container (width <
  250px) { .row-time { display: none } }`); it is the least operational
  field, and a recency-sorted list already carries most of what it says. Dot,
  label, and badge survive to the 200px floor. **Revised again: the rule stays
  unscoped**, so a branch header drops its aggregate age at the same width its
  children drop theirs — a branch still showing a time above rows that had
  theirs removed would read as the branch's own, separate fact.

## 8. Implementation notes

- **Three projections, one module, one row builder.**
  `src/renderer/sessionGrouping.ts` exports:
  - `groupSessionsIntoRoots(sessions, home): SessionRootFolder[]` — what the
    panel renders. `SessionRootFolder = { key, label, directories,
    sessionCount, mostRecentActivity, active, other }`, and
    `SessionDirectory = { key, path, label, labelHead, labelTail, rows,
    mostRecentActivity, active, untracked, inferredRoot }`. `rows.length === 1`
    is the whole branch/no-branch test — there is no separate flag to keep in
    sync with the array.
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
  `untracked: true`, exactly one row, never a branch. That is what lets §4.6's
  name-recovered rows sit *alongside* directory rows in one sorted list under
  a root, with one row grammar in the template, instead of a second loose-row
  array threaded through the same sort. `inferredRoot` is set by the pairing
  `untracked && root !== other` — there is no other way an untracked row can
  be anywhere but `other`.
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
- **Design gates** (tests/unit/designGates.test.ts): no new hex — every color
  above is an existing token; no character-as-icon — the disclosure is
  `AppIcon name="chevron-right"` rotated 90°, never `▸`, and the dot remains a
  styled span.
- **In SessionTree.vue.** Root `<section>`/header/chevron, the `collapsed`
  state, and the 28px indent are unchanged from revision 1. New: the
  `dir-branch` / `dir-header` pair with its own chevron and the dot-column
  arithmetic in §3c, the `dir:` key namespace, the two-level expand watcher,
  and `dirTooltip`. **Deleted:** `.row-name` and every reference to it — the
  dimmed secondary name field is gone (§4.1). `sessionCountLabel` is back, but
  only as a tooltip helper for both header levels; the visible counts stay bare
  integers. The `attached` text tag stays retired.
- **Design gates** (tests/unit/designGates.test.ts): no new hex — every colour
  above is an existing token; no character-as-icon — the branch disclosure is
  the same `AppIcon name="chevron-right"` rotated 90°, never `▸`, and both dots
  remain styled spans.

## 9. Documentation to revise

- **sessionGrouping.ts header comment** — done: it now records that the second
  level is the DIRECTORY, and why that does not reintroduce §1's dead row.
- **SessionTree.vue header comment** — done: it carries the tree sketch from
  §2 and the "free at 1:1" argument.
- **docs/DESIGN.md, session-panel anatomy** — **still outstanding**, and now
  wrong in a second way. Its blockquote still reads "Superseded by
  docs/SESSIONLIST.md (implemented). The two-level tree below is gone… The
  panel is now flat", and its table still retires `.folder-header` /
  `.disclosure` / the 28px indent. All three are back; there is now a *second*
  disclosure (`.dir-header`); the container-query floor is 250px not 230px;
  and `.row-name` should be retired in its place. Left unedited only because
  the file has been dirty under concurrent editors across both revisions.
- **docs/POLISH.md** — §7's chip metric is unchanged and the `attached` chip
  stays retired. §2.6/§4's disclosure entry (`▸` → `AppIcon
  name="chevron-right"`, POLISH.md:239, 370) is live again and now applies at
  two levels. The `·` separator entry (POLISH.md:269, `· 2 sessions`) is still
  wrong: both counts are bare integers, and the phrase form lives in tooltips.
- **docs/screenshots** — `polish-02`/`polish-13` are older still, and
  `projects-20`…`projects-24` document a layout that no longer ships.
  Recapture against a fixture with two or more `$HOME` roots, ≥10 one-session
  directories under one of them, **one directory holding 2+ sessions** (the
  branch), a worktree-divergent name, one out-of-`$HOME` session, and one
  session with no reported cwd whose name names a real root (§4.6).

## 10. The load-bearing four

1. **Every row is named by a directory.** Root headers name `$HOME`'s
   children; the second level names the working directory. A session name is
   a row label in exactly one place — inside a branch — and a tooltip line
   everywhere else.
2. **The branch is conditional, which is what reconciles this with §1.** One
   session in a directory costs one row, the same row the flat list spent.
   Two or more buy a branch, which is the only place there is anything to
   disambiguate. Spend a row only where there is fan-out.
3. **`other` earns its name, and §4.6 shrinks it.** A session with no reported
   cwd is filed under the root its name names, provided that root exists from
   a real path; only the genuinely unplaceable stay in the bucket, pinned
   last.
4. **The expand-on-navigate watcher is on the active session at BOTH levels.**
   The store ticks on a timer; a watcher on the node list makes a node
   impossible to collapse. This trap is level-agnostic and the new level walks
   straight into it.

## 11. Not evaluated

**No app run** — concurrent renderer edits meant `npm run dev` was not
attempted; unit tests and typecheck are the only verification.

- All width arithmetic uses nominal font metrics (13px UI ≈ 6.5px/char,
  11px ≈ 5.5px/char). The **250px** container-query breakpoint and the branch
  child's extra 16px of indent both need a live check at the user's DPI.
- The dot-column arithmetic in §3c (root chevron at 8 / branch chevron at 12 /
  both dots at 30) is arithmetic, not a screenshot. If it is off by a pixel it
  will read as jitter, because the two row types alternate freely.
- Whether any real host produces the label-collision case in §4.5, which is
  now scoped per root *and* moved to directories, and therefore rarer still.
- **How often the branch case actually occurs.** §1 measured 1:1 across the
  board; the user's screenshot shows at least one directory with two sessions.
  If the true rate is ~1 branch per host the level is nearly free, which is
  the assumption this design is built on. Worth confirming on the real panel.
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
