# SESSIONLIST.md — Session panel: the folder view

Status: **implemented.** Originally written as "flatten the tree" against
commit `b55ec9f`, implemented in `3d90f2b`, and **revised** when the user
asked for the folder view back:

> "for the left side panel — I want something like a folder view. git /
> sessions … tmp / sessions other sessions. like we have in the app"

**What the revision changed, and what it did not.** The original §1 analysis
stands unaltered and is the reason this revision looks the way it does: a
header per **leaf** folder really does cost a row to say nothing at a 1:1
folder:session distribution. So the folder level is back, but its rows are
`$HOME`'s **children** — `git`, `tmp`, `other` — which is the phone's watched-
roots level and the one place a folder header has real fan-out. Everything the
flat row bought (§3–§6) survives *inside* a root, unchanged.

Sections rewritten by the revision: §2, §3 (rows 1 and 1a), §4.4, §4.5, §6,
§7, §8, §9, §10. Sections that survive untouched and are still binding: §4.1
(derived-name suppression), §4.2 (divergence), §4.3 (multi-session folders),
§5 (middle truncation), and §6's timestamp and sort *keys*.

Line numbers cited below are from the commits named beside them and may drift.

---

## 1. The problem, from real data

*Written at commit `b55ec9f`, in the present tense of that commit, and kept
verbatim: every measurement below still holds, and it is the reason §2's
folder level is the ROOT level rather than this one.*

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

## 2. Position: one folder level, and it is the ROOT level

**Group sessions by the first path component under `$HOME` — `git`, `tmp` —
with an `other` catch-all. Each root is a collapsible header; its children are
the flat rows of §3–§6, unchanged.**

The distinction that carries the whole design is *which* directory becomes a
header. §1 measured the leaf-folder version and it fails: 11 leaf folders, 11
sessions, and a name derived from the folder path, so header and row were the
same fact twice. **Roots do not have that shape.** All 11 of those sessions
live under one `git`, which is exactly the fan-out that makes a header worth
its row — and it is why the phone's top level is roots and always was
(`FolderListViewModel.buildFolderTree` + `ProjectRootDao`, pocketshell clone
`FolderListViewModel.kt:2758-2782`, `:87`; `FolderTreeProjection.kt:118-175`).
The desktop's mistake was never "a folder level"; it was porting the phone's
*no-watched-roots fallback* and rendering the degenerate level.

The original §2 deferred this option on the grounds that "a roots level today
renders exactly one header above exactly the flat list, i.e. the flat list plus
one dead row". That reasoning is **withdrawn**, on two counts. It measured one
host on one day, and the header is not dead even when there is one of it: it
carries the count, the collapse, and the `other` boundary. More decisively, the
user asked for this shape by name and by example, and the desktop matching the
phone's structure is worth more than one row of vertical space.

The desktop still has no project-roots table, so roots are **synthesised from
the session paths** rather than read from one (§8). That is a real difference
from the phone and is recorded as one: the desktop can only ever show roots
that currently hold a session, where the phone also lists sessionless project
folders to create into. The `New session` footer button is what covers the
gap — creation is folder-first through its own picker.

Still rejected, unchanged:

- **Auto-collapse single-session folders** — it keeps two row grammars for a
  case that is rare, and the merged row still has to answer "which name do I
  show?", with rows that split and merge as sessions come and go.
- **Group by agent kind or recency bucket** — agent kind is already a badge
  and recency is already the sort. Either as a *section* spends rows
  restating what a column shows.
- **A header per leaf folder** — §1, and the reason this document exists.

The genuine multi-session folder is still handled inside the row grammar (§4):
its rows disambiguate themselves with the session name as a secondary field.
No leaf header needed.

`sessionGrouping.ts` keeps all three projections. `canonicalisePath` /
`defaultLabelForPath` / `sessionActivity` remain the shared label and ordering
rules; `groupSessionsByFolder` remains exported as the phone-parity anchor for
the LEAF level even though nothing renders it; and the root projection and the
flat projection are built from one shared row builder (§8), so they cannot
disagree about what a folder is called.

## 3. Row anatomy

Two row types, both height `--row-h` (28px, docs/DESIGN.md:535). Budget at the
280px default (HostWorkspaceView.vue:36); the session row keeps the 2px
selection rail slot + accent rail for `current`.

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

### 3b. Session row

| # | Field | Spec | Width at 280px |
|---|-------|------|----------------|
| 1 | Left inset | 2px rail slot + **28px child indent**, which puts the row's dot exactly under its header's dot and the row label under the header label. (28, not `--sp-4`: the header is `--sp-2` + a 14px disclosure box + an `--sp-2` gap = 30px to its dot.) | 30px |
| 2 | Status dot | 8px circle. `--success` when attached, `--fg-muted` otherwise. This plus sort position (§6) **replaces** the `attached` text tag, which stays retired | 8px + 8px gap |
| 3 | Display label (primary) | `--font-ui` `--fs-300`; `--fw-semibold` when attached, `--fw-regular` otherwise. Middle-truncates (§5). Wins the width fight: `flex: 1; min-width: 0` | ~150-205px (flex) |
| 4 | Session name (secondary, conditional) | `--font-mono` `--fs-100` `--fg-secondary`. Rendered **only when non-redundant** (§4). Shrinks before the primary: `flex: 0 1 auto; min-width: 0`, end-ellipsis | 0-80px |
| 5 | Agent badge | Unchanged (SessionTree.vue:91-113, 322-342; POLISH.md §7 chip metric). `flex: none` | 0-56px |
| 6 | Relative time | `--fs-100` `--fg-secondary` `tabular-nums`, right-aligned, `flex: none` (§6) | ~36px max |
| 7 | Right padding | `--row-pad-x` | 10px |

Worst realistic case (badge + secondary + time) leaves the primary ~90px;
typical case (badge + time, no secondary) leaves ~170px ≈ 26 UI-font
characters — every label in the real data set (`ai-dev-tools-zoomcamp`, 21
chars, is the longest) still renders **untruncated** at the default width. The
indent costs 18px against the flat version; the truncation crisis was never
the indent alone, it was indent + per-leaf header + count phrase + `attached`
tag + a 90px absolute timestamp, and only the indent comes back.

**Tooltip** (native `title` on the row): three lines —
`<session name>\n<full folder path>\n<absolute time>` (e.g.
`git-dtc-website` / `/home/alexey/git/worktrees/merry-sniffing-tortoise` /
`Aug 24, 12:38 PM`). This is where the full path — the only true
disambiguator — always lives, and where the absolute timestamp retreats to.

## 4. Display-label rules

Let `label = defaultLabelForPath(canonicalisePath(session.path))`
(sessionGrouping.ts:56-84) and `base = sanitisePart(label)` (the regex at
src/shared/sessionNameParts.ts:21-27; see §8 for why it lives there).

1. **Derived-name suppression.** The session name is *redundant* when
   `name === base || name.endsWith('-' + base)` — this covers
   `git-dataops`/`dataops`, `home-alexey`/`alexey`, `var-log`/`log` per the
   derivation convention (sessionName.ts:12-18). Redundant → render field 4
   not at all. A custom name that coincidentally ends with the basename is
   suppressed too; harmless, the tooltip carries it.
2. **Divergence** (worktree, custom name): the test fails → primary shows
   the folder label (`merry-sniffing-tortoise` — where it lives *now*),
   secondary shows the session name (`git-dtc-website` — its tmux/phone
   identity). Both facts, one row.
3. **Multi-session folder:** every row of a folder with >1 session renders
   the secondary regardless of the derivation test, since siblings share a
   label and only the session name separates them (`dataops` +
   `git-dataops` vs `dataops` + `git-dataops-2`).
4. **Untracked** (`path === null` → `UNTRACKED_PATH`): primary is the
   session name itself in `--font-mono`, no secondary, no path tooltip line.
   **Revised:** these rows land in the `other` root (§8), which restores the
   phone's rule that the untracked bucket is pinned last
   (`groupSessionsByFolder` does the same for its `Untracked` folder). The
   flat version had to argue the opposite — "with no buckets there is nothing
   to pin" — only because it had abolished buckets. Recency still orders the
   rows *inside* `other`, so nothing is buried within its own section.
5. **Label collision** (two paths, same basename — `~/git/foo` and
   `~/git/nested/foo`): a post-pass prepends parent segments to the colliding
   labels until unique (`git/foo`, `nested/foo`). Rows are keyed by session
   name; labels are display-only. **Revised: the pass runs per root, not
   globally.** `~/git/foo` and `~/work/foo` are already told apart by their
   two headers, so growing both would be the header's information a second
   time — the exact redundancy §1 is about.

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
- The secondary session name end-truncates normally (its distinguishing
  part — `-2` suffixes aside — is redeemed by the tooltip; do not spend
  complexity there).
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

**Row sort, applied within each root:** `attached` desc → activity desc
(`sessionActivity`) → name asc. **Root sort:** most-recent activity of any
session under the root, desc → case-insensitive label asc, with `other`
pinned last however recent it is (it is a bucket, not a place, and floating
it to the top would put the least-organised rows where the eye lands first).

- *Attached first* is the "session I was just in" answer: it pins the
  operationally live rows (usually 1-2) to the top of their root with green
  dots and semibold labels — position, weight, and color all agree. The root
  they are in also sorts first, since its activity is theirs.
- **Revised:** the sort is no longer *global*. A root that has not been
  touched in a week now sits below one touched a minute ago even if it holds
  the second-most-recent session. That is the price of the level, paid
  knowingly: sections mean the eye scans roots first and rows second.
- The root holding the **open** session is force-expanded on navigation, so
  the current row is never hidden behind a collapsed header. It is expanded
  on *navigation only*, not on every recompute — the store refreshes on a
  timer, and re-expanding there would make that root impossible to collapse.
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
  label, and badge survive to the 200px floor.

## 8. Implementation notes

- **Three projections, one module, one row builder.**
  `src/renderer/sessionGrouping.ts` exports:
  - `groupSessionsIntoRoots(sessions, home): SessionRootFolder[]` — what the
    panel renders. `SessionRootFolder = { key, label, rows, mostRecentActivity,
    active, other }`.
  - `flattenSessions(sessions): SessionRow[]` — the tree's degenerate case and
    the row model's direct test surface.
  - `groupSessionsByFolder(sessions): SessionFolder[]` — the phone-parity LEAF
    grouping. Nothing renders it; it stays because it is the parity anchor and
    the shape the folder-first creation flow speaks.

  All three go through one private `buildRows`, so they cannot disagree about
  a label. `buildRows` deliberately does **not** disambiguate — the correct
  scope differs (§4.5), so each projection applies `disambiguateLabels` over
  its own scope.
- **Root keys are written home-relative.** `rootForPath(folderPath, home)`
  returns `{ key: '~/git', label: 'git' }`. Writing the key as `~/git` rather
  than `/home/alexey/git` is what folds the two spellings tmux reports for one
  directory into a single bucket: the absolute path from the active pane, and
  the literal unexpanded `~/git/...` that `session_path` can carry
  (src/main/helper/parsers.ts, `parseSessionEnrichment`). A `~` prefix needs
  no `home` to resolve — `~` *is* home, whatever it expands to. Note this is
  the one place `~` is resolved; `canonicalisePath` still deliberately never
  expands it, so the grouping key and the *displayed* path stay separate.
- **`other` is honest, not a dumping ground.** It holds exactly three things:
  sessions with no known folder (`UNTRACKED_PATH`), paths outside `$HOME`
  (`/var/log`, `/srv/app` — they genuinely share no parent with the rest), and
  sessions sitting in `$HOME` itself, which have no root folder to be named
  after.
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
- **Restored in SessionTree.vue** (all of it deleted by the flat pass, now
  back in root-level form): the folder `<section>`/header/chevron, the
  `collapsed` state + `toggleRoot`, and the 28px indent with its rationale
  block. **Not** restored: `sessionCountLabel` — the header shows a bare
  integer and the phrase form lives only in its tooltip (§3a) — and the
  `attached` text tag, which stays retired.

## 9. Documentation to revise

- **sessionGrouping.ts header comment** — done: it now records the three
  projections, and that the desktop's top level is the ROOT level because
  that is the level with fan-out, not the leaf level it originally ported.
- **docs/DESIGN.md, session-panel anatomy** — **outstanding.** Its blockquote
  still reads "Superseded by docs/SESSIONLIST.md (implemented). The two-level
  tree below is gone… The panel is now flat", and its table still retires
  `.folder-header` / `.disclosure` / the 28px indent. All three are back, at
  the root level, and the container-query floor is 250px not 230px. Left
  unedited only because the file was dirty under a concurrent editor at the
  time of this revision; the table below §3 is what should replace it.
- **docs/POLISH.md** — §7's chip metric is unchanged and the `attached` chip
  stays retired, so its note is still true. But §2.6/§4's disclosure entry
  (`▸` → `AppIcon name="chevron-right"`, POLISH.md:239, 370) is live again
  rather than historical, and the `·` separator entry (POLISH.md:269, `· 2
  sessions`) is now wrong: the header count is a bare integer.
- **docs/screenshots** — `polish-02`/`polish-13` are older still, and
  `projects-20`…`projects-24` now document a layout that no longer ships.
  Recapture against a fixture with two or more `$HOME` roots, ≥10 one-session
  leaves under one of them, a worktree-divergent name, one multi-session
  folder, and one out-of-`$HOME` session, so both the failure this spec
  diagnosed and the shape that replaced it are in the regression imagery.

## 10. The load-bearing three

Superseding the original list, whose item 1 ("Flatten — delete headers,
chevrons, counts, indent") is the statement this revision reverses.

1. **One folder level, at the root** — `git` / `tmp` / `other`, collapsible,
   with the open session's root force-expanded. This is the user's ask and
   the phone's structure.
2. **The row grammar is untouched by it** — folder basename as the label,
   derived-name suppression, middle truncation, attached-first, relative
   time. §1's diagnosis was right about rows; it was only wrong about which
   directory deserves a header.
3. **`other` earns its name** — untracked, out-of-`$HOME`, and `$HOME`-itself
   sessions, pinned last, never a silent majority (which is what `inferHome`
   guards against).

## 11. Not evaluated (no app run — concurrent renderer edits)

- All width arithmetic uses nominal font metrics (13px UI ≈ 6.5px/char,
  11px ≈ 5.5px/char); actual Consolas/Segoe rendering on the user's DPI
  needs a live check, especially the **250px** container-query breakpoint,
  which was moved from 230 by arithmetic alone (+18px of indent).
- The two-span middle-truncation trick under `direction`/kerning edge cases
  in this exact flex context — verified pattern generally, not in this app.
- Whether `attached` flips reliably on refresh cadence for the pinning to
  feel right.
- Whether any real host currently produces the label-collision case in §4.5,
  which is now scoped per root and therefore even rarer.
- Container-query support is assumed from Electron's Chromium ≥ 105; the
  project's Electron version was not verified against it.
- **How many roots a real host actually produces.** The whole case for the
  level is fan-out; if the user's box turns out to have one `git` root and
  nothing else, the level costs one row and buys the collapse plus the
  `other` boundary. Worth a look at the real panel before calling it settled.
- **Whether `$HOME` resolution succeeds on the user's hosts**, and therefore
  whether `inferHome` is a rarely-taken safety net or the live code path.
