# SESSIONLIST.md — Session panel redesign: flatten the tree

Status: **spec, not yet implemented.** Written against the code as of commit
`b55ec9f`. Another agent is concurrently editing `src/renderer/**`; line
numbers cited here are from that commit and may drift.

---

## 1. The problem, from real data

The panel (`src/renderer/components/SessionTree.vue`) renders a two-level
tree: a collapsible folder header per working directory
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

## 2. Position: flatten to one row per session

**Remove the folder-header level entirely. One row per session; the folder
supplies the row's display label and tooltip.** The rendered list becomes a
flat, recency-ordered list of projects.

Why this and not the alternatives:

- **Auto-collapse single-session folders** (folder renders as one row when
  it holds one session) — rejected. It keeps two row grammars, the chevron
  machinery, and the indent for a case that is rare (one multi-session
  folder exists today), and the merged row still has to answer "which name
  do I show?" — the exact question the flat design answers, with more
  moving parts and rows that split/merge as sessions come and go.
- **Group by parent directory / reinstate watched roots** — deferred, not
  rejected. All 11 sessions live under one parent (`~/git`); a roots level
  today renders exactly one header above exactly the flat list, i.e. the
  flat list plus one dead row. Roots earn their place on the phone because
  the phone also lists *sessionless* project folders to create into; the
  desktop lists only live sessions (`SessionSummary`,
  src/shared/types.ts:114-131). If the desktop grows the phone's
  browse-and-create tree, add the roots level then — the flat row spec
  below nests under a root header unchanged.
- **Group by agent kind or recency bucket** — rejected. Agent kind is
  already a badge; recency is already the sort. Either as a *section*
  spends rows restating what a column shows.

The genuine multi-session folder is handled inside the flat grammar (§4):
its rows disambiguate themselves with the session name as a secondary
field. No header needed.

`sessionGrouping.ts` is **kept** — `canonicalisePath` /
`defaultLabelForPath` remain the label source of truth and the phone-parity
anchor. Flattening is a new projection in the same module (§8), not a
replacement. This is a deliberate *presentation* divergence from the phone
(which the file's header comment, sessionGrouping.ts:1-4, should record);
the grouping *semantics* stay shared.

## 3. Row anatomy

One row type, height `--row-h` (28px, docs/DESIGN.md:535). Budget at the
280px default (HostWorkspaceView.vue:36); the row keeps the 2px selection
rail slot + accent rail for `current` (SessionTree.vue:287, 298-301).

| # | Field | Spec | Width at 280px |
|---|-------|------|----------------|
| 1 | Left inset | 2px rail slot + `--sp-2` padding (no 28px child indent — there is no parent) | 10px |
| 2 | Status dot | 8px circle. `--success` when attached, `--fg-muted` otherwise (as today, SessionTree.vue:302-311). This plus sort position (§6) **replaces** the `attached` text tag — delete SessionTree.vue:168, 343-353 | 8px + 8px gap |
| 3 | Display label (primary) | `--font-ui` `--fs-300`; `--fw-semibold` when attached, `--fw-regular` otherwise. Middle-truncates (§5). Wins the width fight: `flex: 1; min-width: 0` | ~150-205px (flex) |
| 4 | Session name (secondary, conditional) | `--font-mono` `--fs-100` `--fg-secondary`. Rendered **only when non-redundant** (§4). Shrinks before the primary: `flex: 0 1 auto; min-width: 0`, end-ellipsis | 0-80px |
| 5 | Agent badge | Unchanged (SessionTree.vue:91-113, 322-342; POLISH.md §7 chip metric). `flex: none` | 0-56px |
| 6 | Relative time | `--fs-100` `--fg-secondary` `tabular-nums`, right-aligned, `flex: none` (§6) | ~36px max |
| 7 | Right padding | `--row-pad-x` | 10px |

Worst realistic case (badge + secondary + time) leaves the primary ~110px;
typical case (badge + time, no secondary) leaves ~190px ≈ 28 UI-font
characters — every label in the real data set (`ai-dev-tools-zoomcamp`, 21
chars, is the longest) renders **untruncated** at the default width. The
truncation crisis is mostly self-inflicted by the current layout's indent +
count + tag + 90px timestamp; removing them dissolves it.

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
4. **Untracked** (`path === null` → `UNTRACKED_PATH`,
   sessionGrouping.ts:20, 45-50): primary is the session name itself in
   `--font-mono`, no secondary, no dot-path tooltip line. They sort by the
   same global rules (§6) — the phone pins its Untracked *bucket* last
   (sessionGrouping.ts:151-153); with no buckets there is nothing to pin,
   and burying a recently active session would break the recency contract.
5. **Label collision** (two paths, same basename — `~/git/foo` and
   `~/work/foo`): a post-pass prepends parent segments to the colliding
   labels until unique (`git/foo`, `work/foo`). Key rows by session name as
   today (SessionTree.vue:154); labels are display-only.

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

**Global sort:** `attached` desc → activity desc (`sessionActivity`,
sessionGrouping.ts:69-71) → name asc.

- *Attached first* is the "session I was just in" answer: it pins the
  operationally live rows (usually 1-2) to the very top with green dots and
  semibold labels — position, weight, and color all agree.
- *Agents-first is dropped as a global key.* The phone's rule
  (sessionGrouping.ts:100-114, ported from FolderTreeProjection.kt:564-568)
  is a **within-folder** tiebreak so shells don't bury a folder's agent. As
  a global key over 11 one-session folders it would pin all nine agent
  sessions above any shell regardless of recency — hiding exactly the
  recently-used shell the user is looking for. Agent-ness stays visible as
  the badge; recency is the organizing principle.
- Order recomputes only when the sessions store refreshes (activity is
  refresh-sampled), so rows do not jump mid-hover.

## 7. Panel width

- **Default 280px stands** (HostWorkspaceView.vue:36); the flat row is
  sized to render the real data untruncated there (§3).
- **Persist it.** Width is drag-resized (HostWorkspaceView.vue:56-66) but
  reset to 280 every mount — no storage anywhere in the file. Persist to
  `localStorage` (`pocketshell.sessionPanelWidth`), clamped to
  `MIN/MAX_PANEL_WIDTH` on read.
- **Minimum:** keep `MIN_PANEL_WIDTH = 200` (HostWorkspaceView.vue:37). The
  design's true floor is ~230px with all fields; below that, drop the
  *timestamp* first — it is the least operational field — via a container
  query on the panel (`container-type: inline-size`; `@container (width < 230px)
  { .row-time { display: none } }`). Dot, label, and badge survive to 200px.
  The `min-width: 240px` on `.tree` (SessionTree.vue:201) contradicts the
  200px clamp today; align it with the container-query floor (200px).

## 8. Implementation notes

- **New projection, same module.** Add `flattenSessions(sessions:
  SessionSummary[]): SessionRow[]` to `src/renderer/sessionGrouping.ts`,
  where `SessionRow = { session, label, labelTail?, showName, folderPath,
  siblings }`, built on the existing `canonicalisePath` /
  `defaultLabelForPath` / `sessionActivity`. Keep `groupSessionsByFolder`
  exported — `NewSessionDialog`'s folder-first flow and the unit tests
  still speak folders.
- **`sanitisePart` reaches the renderer via shared.** It (and only it) now
  lives in `src/shared/sessionNameParts.ts:21-27`, re-exported by
  `src/main/projects/sessionName.ts:30-35` for that module's callers, so the
  renderer's redundancy test runs the derivation's own regex instead of a
  duplicate. Covered by tests/unit/sessionNameParts.test.ts.
- **Design gates** (tests/unit/designGates.test.ts:53, 74): no new hex —
  every color above is an existing token (DESIGN.md:506-539); no
  character-as-icon — the chevron *disappears* rather than being replaced,
  the dot remains a styled span, and any future glyph goes through
  `AppIcon.vue` (POLISH.md §2; names at AppIcon.vue:18-43).
- **Deletions in SessionTree.vue:** folder `<section>`/header/chevron
  (132-148), `collapsed` state + `toggleFolder` (34-35, 68-78),
  `sessionCountLabel` (80-83), the `attached` tag (168, 343-353), the 28px
  indent rationale block (280-292).

## 9. Documentation to revise

- **docs/DESIGN.md:696-702** — the session-panel anatomy table specs the
  two-level layout (`.folder-header` metrics, the 28px child-indent
  rationale, absolute `.session-time`). Rewrite to the flat row of §3;
  the `SESSIONS` header row (DESIGN.md:696) and chip metric stand.
- **docs/POLISH.md** — §7's chip metric is unchanged; add a note that the
  `attached` chip is retired in favor of dot + weight + sort position.
- **sessionGrouping.ts:1-15 header comment** — record that grouping
  *semantics* stay phone-parity but the desktop's *presentation* is flat,
  and why (1:1 folder:session distribution on real hosts).
- **docs/screenshots** — `polish-02`/`polish-13` predate even the current
  footer button; recapture after implementation, ideally against a fixture
  with ≥10 one-session folders, a worktree-divergent name, and one
  multi-session folder, so the failure mode this spec fixes is in the
  regression imagery.

## 10. If only three changes land

1. **Flatten** — one row per session, folder basename as the primary label
   with derived-name suppression; delete headers, chevrons, counts, indent.
   Halves the row count, and returns ~120px/row of width.
2. **Attached prominence** — attached rows sort to the top, green dot +
   semibold label; delete the `attached` tag. Answers "where was I?" in one
   fixation.
3. **Relative timestamps** — `12m` instead of `Aug 24, 12:56 PM`, absolute
   in the tooltip. Frees ~55px/row, which is what lets
   `pocketshell-desktop` and `pocketshell` stop rendering identically.

(§5 middle truncation and §7 width persistence are next; §4's collision
pass can trail — no collision exists in the observed data.)

## 11. Not evaluated (no app run — concurrent renderer edits)

- All width arithmetic uses nominal font metrics (13px UI ≈ 6.5px/char,
  11px ≈ 5.5px/char); actual Consolas/Segoe rendering on the user's DPI
  needs a live check, especially the 230px container-query breakpoint.
- The two-span middle-truncation trick under `direction`/kerning edge cases
  in this exact flex context — verified pattern generally, not in this app.
- Whether `attached` flips reliably on refresh cadence for the pinning to
  feel right (store refresh timing, SessionTree.vue:39-47).
- The real 11th row (screenshot showed 10 legibly); and whether any real
  host currently produces the label-collision case in §4.5.
- Container-query support is assumed from Electron's Chromium ≥ 105; the
  project's Electron version was not verified against it.
