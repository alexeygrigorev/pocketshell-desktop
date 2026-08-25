# PocketShell Desktop — Polish Pass

Status: **specification only** — nothing here has been applied to `src/`.
This document extends `docs/DESIGN.md` (it does not replace it); where it
revises DESIGN.md, §9 lists the revision explicitly. Grounded in the
current committed screenshots `docs/screenshots/after-01…after-08.png`
(1280×800) and in the CSS that produced them.

> **Later revision:** the host topbar this document inventories (back /
> panel-toggle / host label / Ports / Usage / disconnect) no longer exists —
> DESIGN.md §5.3b redistributed it (identity → OS window title, back +
> collapse → the `SESSIONS` header, Ports/Usage/Settings → the panel foot,
> Disconnect → the picker's connected row). The per-control treatments below
> (ghost classes, the disconnect error-hover, the `panel-left` mark) survive
> in the controls' new homes; only the row they shared is gone.

User direction, decoded from three messages:

1. *"should be more smooth… the triangles should be better looking and
   maybe we actually use v and x like vs code (icons not letters)"* —
   replace character glyphs with real vector icons in the VS Code visual
   language; smooth out motion, alignment, and chrome weight.
2. **Settled:** the Files tab's colour emoji (📁/📄/↪) become proper SVG.
   Not an option to weigh — a decision to implement (§2.5).
3. **Settled and generalised:** *"for all other things too we shouldn't use
   font"* — **no character-as-icon anywhere in the app.** §2.3 is the
   exhaustive inventory from a full sweep of `src/renderer/**` (templates,
   script strings, CSS `content:` — which turned out to contain no glyphs),
   including states not visible in the eight screenshots.

Sweep result up front: the full inventory (§2.3) is only slightly larger
than what the screenshots show — the extra finds are the Conversation tab's
`🔧`/`▼`/`▶`, FilesView's `●` dirty dot and a wrong-platform `⌘S` label,
and PortPanelView's row-remove `✕`. The composer panel
(`PromptComposer.vue`, `ComposerAttachmentTiles.vue`) has **already been
converted** by its owner via a local `ComposerIcon.vue` — which also
settles the implementation pattern (§2.1). The job size is as the
screenshots suggested, minus the composer.

---

## 1. Diagnosis — why the current design reads as unpolished

The redesign's bones are right (token set, elevation ladder, one accent,
underline tabs). What betrays it is the *finishing* layer:

1. **Fourteen different text characters are doing icon work.** `←` `☰` `⟳`
   `✕` `▸` `→` `+` `✓` `✗` `▼` `▶` plus colour emoji `📁 📄 ↪ 🔧`. Each
   renders at its own optical size and stroke weight, sits on the text
   baseline rather than the control's centre, and the emoji are the **only
   saturated colour on screen** (`after-05`: the folder column is a stack of
   yellow emoji against an otherwise monochrome-plus-cyan UI). Font glyphs
   also cannot be stroke-tuned, token-tinted (colour emoji ignore CSS
   `color` entirely — see the blocked comment at `FileTree.vue:142-145`),
   or rotated cleanly.
2. **Everything is a box.** In `after-02`'s 40px topbar there are five
   bordered controls (`←`, `☰`, `Ports`, `Usage`, `disconnect`) plus two
   bordered chips; the SESSIONS bar adds a boxed `⟳`; the new-session row a
   boxed `+`. Nine bordered rectangles at rest on a mostly empty screen.
   VS Code's equivalent chrome is *ghost* buttons — invisible until hover.
   This border noise is the single biggest "unpolished" signal.
3. **Icon buttons are unequal widths.** `.icon-btn` sizes from `padding: 0
   var(--sp-2)` plus the glyph's advance width, so in `after-02` the `←` and
   `☰` boxes are visibly different widths. Icon-only buttons must be square.
4. **The disclosure triangle is a text glyph.** `SessionTree.vue:127` renders
   `▸` at `--fs-200` in a 12px slot next to a 15px semibold label
   (`after-02`, "Untracked"). The glyph is small for its slot, sits high of
   the label's optical centre (it aligns to the text baseline, not the row
   centre), and `rotate(90deg)` pivots the whole glyph box, so the open
   state lands slightly off its closed position.
5. **Nothing has an entrance.** The Ports/Usage overlays (`after-06`,
   `after-07`) pop in fully-formed in one frame — `OverlayPanel.vue` has no
   transition at all. Abrupt appearance reads cheap even when the panel
   itself is well drawn.
6. **The splitter is a visible dark seam.** `HostWorkspaceView.vue`
   `.splitter { width: 4px; background: var(--bg) }` draws a near-black 4px
   band between the session panel and the pane in `after-02`/`after-03`,
   doubling the 1px panel border next to it. VS Code's sash is invisible
   until hovered.
7. **Small misalignments.** Session rows outdent from their folder label
   (§6.1); the Usage overlay's lone boxed `⟳` floats orphaned under the
   title (`after-07` top-left); every breadcrumb crumb is accent-cyan in
   `after-05`, which violates the app's own "accent = selection only" rule;
   `UsageView.vue` `.reset` uses a `5.5rem` magic margin to fake column
   alignment.
8. **The focus ring mutates geometry.** The global `:focus-visible` rule in
   `App.vue` sets `border-radius: var(--r-md)` on the *element*, so focusing
   anything square (the editor textarea, a session row once focusable)
   rounds its corners. Chromium outlines already follow the element's own
   radius; the declaration is a bug.

---

## 2. Iconography — the core change

### 2.1 Decision: one shared inline-SVG component, Feather-derived geometry

**No package. No icon font.** A single local component,
`src/renderer/components/AppIcon.vue`, rendering inline SVG paths taken
from the Feather icon set (**MIT**, verified via
`npm view feather-icons version license` → 4.29.2 / MIT). ~16 icons total;
the path data lives in the component, so nothing is fetched, nothing needs
a loader, and the strict `file://` renderer is untouched.

This is not just the cleanest option — it is **already the app's
established pattern**. The in-flight composer panel ships
`src/renderer/components/ComposerIcon.vue`: inline SVG, one 24×24 viewBox
displayed at 16px, `stroke="currentColor"`, `stroke-width="2"`, round
caps/joins, Feather-derived geometry — and its header comment says
explicitly that a shared app-wide icon component is being specified here
and that folding into it later is a rename. `AppIcon.vue` therefore adopts
**ComposerIcon's exact contract** (same viewBox, stroke, caps) so the merge
is mechanical and the two sets are pixel-consistent in the meantime.

Alternatives, considered and rejected:

- **`@vscode/codicons`** (verified: 0.0.46-24, **CC-BY-4.0**) — the literal
  VS Code set, but distributed primarily as an **icon font**: glyphs on a
  text baseline, the exact disease being cured, plus a visible-attribution
  requirement. Its raw SVGs would need an inlining pipeline the project
  doesn't have.
- **`lucide-vue-next`** (verified: 1.0.0, **ISC**) — inline-SVG Vue
  components and would work, but it adds a dependency to obtain ~16 path
  strings that Feather already provides under MIT, and its default
  component contract differs from ComposerIcon's, so adopting it would
  churn the composer's finished work for no visual gain. (It remains the
  right escape hatch if the icon count ever grows past what hand-curating
  paths is worth.)
- **Drawing paths from scratch** — a hand-drawn refresh arc or paperclip
  will read amateur next to optically-corrected glyphs. Feather's geometry
  is the professional version of exactly the "thin, geometric, unfilled"
  register ComposerIcon already names as its target.

### 2.2 The component (diff-ready)

New file `src/renderer/components/AppIcon.vue`:

```vue
<script setup lang="ts">
// AppIcon: the only way an icon enters the UI outside the composer panel
// (ComposerIcon.vue predates this and folds in later — same contract).
//
// Contract, shared with ComposerIcon:
//   - one 24x24 viewBox for every mark, so stroke weights stay identical;
//   - stroke="currentColor", never a literal colour — an icon inherits the
//     parent's token colour and its hover/disabled states for free;
//   - stroke-width 2, round caps/joins: Feather geometry (MIT), the thin
//     geometric unfilled register of VS Code's Codicons.
//
// Displayed at 16px (default), 14px (dense bars, disclosure), or 12px
// (chips, table-row actions). No other sizes.
export type AppIconName =
  | 'arrow-left'
  | 'arrow-right'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-up'
  | 'close'
  | 'file'
  | 'folder'
  | 'panel-left'
  | 'plus'
  | 'refresh'
  | 'symlink'
  | 'tool';

/** Feather 4.29 path data (MIT), verbatim. One entry per icon. */
const GEOMETRY: Record<AppIconName, string[]> = {
  'arrow-left': ['M19 12H5', 'M12 19l-7-7 7-7'],
  'arrow-right': ['M5 12h14', 'M12 5l7 7-7 7'],
  check: ['M20 6L9 17l-5-5'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-right': ['M9 18l6-6-6-6'],
  'chevron-up': ['M18 15l-6-6-6 6'],
  close: ['M18 6L6 18', 'M6 6l12 12'],
  file: ['M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M13 2v7h7'],
  folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
  'panel-left': [
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    'M9 3v18',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  refresh: ['M23 4v6h-6', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10'],
  symlink: ['M4 4v7a4 4 0 0 0 4 4h12', 'M15 10l5 5-5 5'],
  tool: [
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  ],
};

const props = withDefaults(
  defineProps<{ name: AppIconName; size?: 12 | 14 | 16 }>(),
  { size: 16 },
);
</script>

<template>
  <svg
    class="app-icon"
    viewBox="0 0 24 24"
    :width="props.size"
    :height="props.size"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, i) in GEOMETRY[props.name]" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
/* display:block kills the baseline gap inline SVGs get; flex:none stops
   flex rows from squashing the icon when a label truncates. */
.app-icon {
  display: block;
  flex: none;
}
</style>
```

Notes:

- `panel-left` is Feather's `sidebar` with the `<rect>` expressed as a
  path, so the template stays a single `path` loop. It is the VS Code
  "toggle sidebar" mark — truer to the action than the current hamburger.
- `refresh` is Feather's `rotate-cw` (one arc + one arrowhead), chosen over
  `refresh-cw` (two arcs) for calm at 14px.
- ComposerIcon's `dot`, `paperclip`, `chevron-*`, `close`, `file` overlap
  this registry; the eventual fold-in (owned by the composer work, not this
  pass) deletes ComposerIcon and re-points its call sites.

### 2.3 The exhaustive glyph inventory (settled: every one becomes SVG)

From a full sweep of `src/renderer/**` templates, script strings, and CSS
`content:` values (the latter contained none). `TerminalView.vue` is
excluded on principle — a VT emulator's glyphs come from the remote program
and Consolas, and are off-limits.

**Convert — glyph is standing in for a graphic affordance:**

| Current | File : line | Meaning | Replace with |
|---|---|---|---|
| `▸` | `SessionTree.vue:127` | folder disclosure | `<AppIcon name="chevron-right" :size="14" class="disclosure" :class="{ open: … }" />` (§2.6) |
| `⟳` / `…` swap | `SessionTree.vue:115` | refresh session list / loading | `<AppIcon name="refresh" :size="14" :class="{ spin: sessions.loading }" />` (§4.4) |
| `+` | `SessionTree.vue` new-session button | create session | `<AppIcon name="plus" />` |
| `📁` `↪` `📄` | `FileTree.vue:49` (`icon()`) | dir / symlink / file rows | `icon()` returns `'folder' / 'symlink' / 'file'`; template renders `<AppIcon :name="icon(e)" />` (§2.5) |
| `📁` | `FileTree.vue:66` | `..` parent-directory row | `<AppIcon name="folder" />`, `--fg-muted` like its `..` label — parent nav is a plain dir row |
| `⟳` / `…` swap | `FileTree.vue:61` | refresh listing / loading | `<AppIcon name="refresh" :size="14" :class="{ spin: files.loading }" />` in `.icon-btn.sm` |
| `✕` | `OverlayPanel.vue:29` | close overlay | `<AppIcon name="close" />` |
| `✕` | `SessionWorkspaceView.vue:75` | close session view | `<AppIcon name="close" />` |
| `←` | `HostWorkspaceView.vue:77` | back to hosts | `<AppIcon name="arrow-left" />` |
| `☰` | `HostWorkspaceView.vue:83` | toggle session panel | `<AppIcon name="panel-left" />` |
| `✓` / `✗` | `HostWorkspaceView.vue:92,95` | bootstrap chip state | `<AppIcon name="check" :size="12" />` / `<AppIcon name="close" :size="12" />`; chips become `inline-flex; align-items: center; gap: var(--sp-1)` (§7) |
| `→` | `HostPickerView.vue:57` | row "goes somewhere" affordance | `<AppIcon name="chevron-right" class="chevron" />` — a list-row affordance is a chevron, not an arrow (VS Code/macOS convention) |
| `⟳` (in `⟳ Scan`) / `…` swap | `PortPanelView.vue:62` | scan remote ports / loading | `<AppIcon name="refresh" :size="14" :class="{ spin: forwards.loading }" />` + label `Scan` kept |
| `→` | `PortPanelView.vue:81` | local→remote direction in add form | `<AppIcon name="arrow-right" :size="12" />`, `--fg-muted` — decorative, an arrow is right here (it is a direction, not navigation) |
| `✕` | `PortPanelView.vue:99` | remove forward (table row) | `<AppIcon name="close" :size="12" />` in `.icon-btn.sm` |
| `⟳` | `UsageView.vue:70` | refresh usage | `<AppIcon name="refresh" :class="{ spin: agents.loading }" />` |
| `▼` / `▶` | `ConversationView.vue:97` | tool-call block expand state | `<AppIcon name="chevron-right" :size="12" class="disclosure" :class="{ open: expanded.has(blockKey(i, j)) }" />` — same rotation pattern as the tree (§2.6) |
| `🔧` | `ConversationView.vue:96` | tool-call marker | `<AppIcon name="tool" :size="12" />` |
| `●` (in `● unsaved`) | `FilesView.vue:58` | dirty indicator | CSS circle span (§2.4) + text "unsaved" |

**Already converted (composer, owned elsewhere — no action here):**
`PromptComposer.vue` and `ComposerAttachmentTiles.vue` now render all
affordances through `ComposerIcon` (chevron-up/down, close, paperclip,
file, dot). Their only remaining non-ASCII is genuine text (tooltip copy,
`Sending…`). The fold-in of ComposerIcon into AppIcon is a later rename.

**Stays text — genuinely text, not icons (deliberate, do not convert):**

| Character | Where | Why it stays |
|---|---|---|
| `·` | `HostWorkspaceView.vue` host label, `SessionTree.vue` root-header tooltip, composer tooltip | metadata separator inside running text. Borderline case, called explicitly: it separates a label from its count the way a comma would — it is punctuation, not an affordance |
| `…` inside labels | `Sending…`, `Saving…`, `connecting…`, `probing…`, and `Load`'s loading state | ellipsis inside a word/label is prose. Only a **bare** `…` swapped in as a button's sole content is an indicator — those become the `.spin` refresh icon per the table above |
| `—` | `UsageView.vue:60,62` (`resets —`), empty-state copy in `PortPanelView`/`UsageView` | em dash as "no data" placeholder / punctuation |
| `–` | `PortPanelView.vue` hint (`1024–10000`) | en dash in a numeric range |
| `~` `/` | `FileTree.vue` breadcrumb | displayed path text |
| `↓` `↑` | `PromptComposer.vue:587` tooltip | keyboard-shortcut copy inside a `title` attribute |

**One correction, not a conversion:** `FilesView.vue:62` labels the save
button `Save (⌘S)` — a **macOS glyph on a Windows-first app** whose own
handler checks `metaKey || ctrlKey`. Change the label to `Save` with
`title="Ctrl+S"` (matching the composer's `Ctrl+…` tooltip convention).

**Not glyphs, no change:** the status dots (`.dot`, `.status-dot`) and the
usage meters are already CSS boxes/circles; empty states are prose and
correctly icon-free (`FileTree`'s "empty directory", the placeholder
views); `SlashCommandDropdown.vue` contains no icon glyphs.

### 2.4 The `●` dots

`FilesView.vue`'s `● unsaved` (and any future pip) is not an icon — it is a
status mark that should stop scaling with font metrics:

```css
.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}
```

`<span class="dirty"><span class="dirty-dot" /> unsaved</span>` with
`.dirty { display: inline-flex; align-items: center; gap: var(--sp-1); }`.
(The composer already renders its pip via `ComposerIcon name="dot"` at 8px
— either form is fine; they unify at fold-in time.)

### 2.5 Files tab — settled: the emoji become these SVGs

`after-05` today: a column of saturated yellow `📁` at every dir row — the
only loud colour in the app — and CSS that *tries* to tint the column
(`.ic { color: var(--fg-muted) }`) but can't, because colour-emoji
rasterisation ignores `color`. With real SVGs the column finally obeys the
token system. The spec:

| Entry type | Icon | Colour at rest | On row hover | On row selected (`.entry.active`) |
|---|---|---|---|---|
| directory (incl. `..`) | `folder` | `--warning` (`..` row: `--fg-muted`) | unchanged | unchanged |
| file | `file` | `--fg-muted` | unchanged | `--fg-secondary` |
| symlink | `symlink` | `--fg-secondary` | unchanged | unchanged |

Reasoning: the folder carries the most weight (`--warning`, per DESIGN.md
§5.7 — at a 2px/24-viewBox stroke this is an amber outline, an
accent-of-place, not the emoji's paint-bucket fill) so the dir/file
hierarchy reads at a glance; files sit quietest (`--fg-muted` is legal here
— the icon is decorative, the filename beside it carries the information);
symlinks sit between, one step up, because "this is not a real file" is
worth a glance. On **hover nothing changes** — icon colour flicker under a
sweeping cursor is exactly the smear §4.5 bans, and the row's
`--state-hover` fill is the feedback. On **selected**, only the file icon
lifts one step (`--fg-muted` → `--fg-secondary`) so it doesn't read
disabled against the `--state-selected` fill; folder and symlink are
already ≥ that weight and stay put.

Diff-ready CSS (`FileTree.vue`, replaces the `.ic` block):

```css
.entry { color-scheme dependencies unchanged; }
.entry .app-icon { color: var(--fg-muted); }          /* file default   */
.entry .app-icon.folder { color: var(--warning); }    /* dir            */
.entry .app-icon.symlink { color: var(--fg-secondary);}/* symlink       */
.entry.up .app-icon { color: var(--fg-muted); }       /* the `..` row   */
.entry.active .app-icon { color: var(--fg-secondary); }
.entry.active .app-icon.folder { color: var(--warning); }
.entry.active .app-icon.symlink { color: var(--fg-secondary); }
```

(Simplest implementation: `icon()` returns the name, the template adds it
as a class too: `<AppIcon :name="icon(e)" :class="icon(e)" />`. Delete the
old `.ic { width: 1.1rem; text-align: center }` — the 16px SVG box is the
column; the `rem` width was sized for an emoji.)

Two boundaries, stated per the brief:

- **No `folder-open` variant is needed.** `FileTree` is a cd-into listing
  (click a dir → navigate), not an expanding tree — there is no expanded
  state to mark. If it ever becomes a real tree, `folder-open` joins the
  registry then.
- **No per-extension file-type set.** Real icons make one tempting; it is
  not asked for. dir / file / symlink — the three types the SFTP layer
  reports — is the complete set. The one distinction that might earn its
  place later is exactly the one that already exists (symlink), so: done.

### 2.6 How the chevron rotates

One pattern, used by the session tree and the conversation block toggles.
Base icon is always `chevron-right`; the open state is a 90° rotation, so
open/closed are geometrically the same glyph and the motion between them is
a pure spin:

```css
/* SessionTree.vue — replaces the current .disclosure block */
.disclosure {
  color: var(--fg-muted);
  transition: transform var(--dur-fast) var(--ease);
}
.disclosure.open {
  transform: rotate(90deg);
}
```

Rotating the outer `<svg>` element (a CSS box) pivots around its own centre
— no `transform-origin`/`transform-box` juggling, and no baseline offset,
which is what made the text `▸` land crooked. The current `width: 12px` and
`font-size` declarations on `.disclosure` are deleted; the 14px icon box is
the slot.

### 2.7 Sizing, stroke, and alignment rules

- **Three sizes only:** 16 (default — toolbars, tree glyphs), 14 (the
  disclosure chevron, dense-bar buttons), 12 (inside chips, table-row
  actions, block toggles). No other values.
- **Stroke is 2 on the 24 viewBox** (ComposerIcon's contract): effective
  ≈1.33px at 16, ≈1.17px at 14, 1px at 12 — the Feather/Codicon weight
  band, and identical across the set because the viewBox is shared.
- **Colour is always `currentColor`.** An icon never sets its own colour;
  the parent's `color:` token does (`--fg-secondary` at rest in buttons,
  `--fg` on hover, `--fg-muted` for decorative marks, §2.5's table for the
  file tree). This is what keeps icons inside the token system with zero
  extra rules — and it now actually works, which the emoji made impossible.
- **Vertical alignment is flex-centring, never baseline.** Every icon sits
  in a flex row/button with `align-items: center`; the wrapper's
  `display: block` removes the inline-SVG descender gap. No
  `vertical-align` hacks anywhere.
- **Icon-only buttons are square** (§3), so the icon is centred by
  construction and adjacent buttons are identical widths.
- **Fixed icon column in list rows:** the tree/file glyph column is the
  icon's own 16px `flex: none` box; text starts at a constant x regardless
  of glyph.

---

## 3. De-boxing the chrome — ghost icon buttons

This is the second-highest-impact change. Split the current one-size
`.icon-btn` primitive in `App.vue` into:

```css
/* App.vue global styles — REPLACES the current .icon-btn block */

/* Ghost square icon button — toolbars, headers, row actions. VS Code
   style: invisible at rest, fill on hover. */
.icon-btn {
  width: var(--control-h);
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.icon-btn:hover:not(:disabled) { background: var(--state-hover); color: var(--fg); }
.icon-btn:active:not(:disabled) { background: var(--state-active); }
.icon-btn:disabled { opacity: var(--disabled-opacity); cursor: default; }
.icon-btn.sm { width: var(--control-h-sm); height: var(--control-h-sm); }

/* Ghost labeled button — header text actions (Ports, Usage, disconnect). */
.btn-ghost {
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 0 var(--sp-2);
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.btn-ghost:hover:not(:disabled) { background: var(--state-hover); color: var(--fg); }
```

Reassignments:

| File | Element | Current class | New |
|---|---|---|---|
| `HostWorkspaceView.vue` | back, panel-toggle (now icons) | `.icon-btn` (bordered) | `.icon-btn` (ghost square) |
| `HostWorkspaceView.vue` | `Ports`, `Usage`, `disconnect` | `.icon-btn` | `.btn-ghost`; `disconnect` keeps its scoped error-hover override (`--error-soft` fill + `--error` text — drop the `border-color` line, there is no border now) |
| `SessionTree.vue` | header refresh, new-session plus | `.icon-btn` | `.icon-btn` ghost |
| `FileTree.vue` | breadcrumb refresh | `.icon-btn` + scoped `height: var(--control-h-sm)` override | `.icon-btn.sm`; **delete the scoped override** (it forked the primitive) |
| `OverlayPanel.vue` | close | `.icon-btn` | `.icon-btn` ghost |
| `SessionWorkspaceView.vue` | session close | `.icon-btn.close` | `.icon-btn` ghost |
| `PortPanelView.vue` | row remove | `.icon-btn` | `.icon-btn.sm` |
| `PortPanelView.vue` | Scan | `.icon-btn` | keep a bordered look — it sits in a form bar next to the bordered `Auto-forward` toggle; reuse the toggle's style |
| `UsageView.vue` | refresh | `.icon-btn` | `.icon-btn` ghost — as a ghost button the lone `⟳` in `after-07` stops reading as orphaned debris under the overlay title |

Filled accent buttons (`Load`, `Add`, `Save`) and the bordered
`Auto-forward` toggle are untouched — a primary action and a stateful
toggle both earn their chrome. The status chips (`pocketshell ✓`) keep
their tinted borders; they are status, not controls.

After this change the topbar in `after-02` goes from seven boxes to two
tinted chips — everything else is quiet until hovered, which is the VS Code
register the user is pointing at.

---

## 4. Motion — the "smooth" in "should be more smooth"

### 4.1 Token additions (`App.vue` `:root`, extends the existing motion block)

```css
  --dur-slow: 280ms;                        /* overlay entrance only */
  --ease-out: cubic-bezier(0, 0, 0.2, 1);   /* decelerate: things arriving */
```

The existing `--dur-fast/--dur-normal/--ease` stay as-is; `--ease` remains
the default for state changes (hover tints, chevron rotation).

### 4.2 What animates

| Interaction | Spec |
|---|---|
| Button/chip hover tint | `background`/`color` over `--dur-fast --ease` (already mostly present — keep) |
| Disclosure chevrons | `transform` over `--dur-fast --ease` (§2.6) |
| Overlay open | §4.3 |
| Splitter hover highlight | §6.4 |
| Meter fill width (`UsageView`) | `--dur-normal --ease` (already present — keep) |
| Host-picker chevron | on `.host-row:hover`, `color: var(--fg-secondary)` + `transform: translateX(2px)`, `--dur-fast --ease` — a 2px nudge, the smallest possible "this row goes somewhere" cue |

### 4.3 Overlay entrance (`OverlayPanel.vue`)

Wrap the template in Vue's `<Transition name="overlay" appear>` and add:

```css
.overlay-enter-active { transition: opacity var(--dur-normal) var(--ease-out); }
.overlay-enter-active .overlay-panel {
  transition:
    transform var(--dur-slow) var(--ease-out),
    opacity var(--dur-normal) var(--ease-out);
}
.overlay-enter-from { opacity: 0; }
.overlay-enter-from .overlay-panel { opacity: 0; transform: translateY(8px) scale(0.985); }
.overlay-leave-active { transition: opacity var(--dur-fast) var(--ease); }
.overlay-leave-to { opacity: 0; }
```

Enter decelerates in over 280ms; exit is a plain 150ms fade (dismissal
should feel faster than arrival — nothing scales on the way out).

### 4.4 Loading spin (replaces the `…` swap in refresh buttons)

```css
/* App.vue global */
.spin { animation: icon-spin 900ms linear infinite; }
@keyframes icon-spin { to { transform: rotate(360deg); } }
```

The button keeps its icon while loading instead of swapping to an ellipsis
character (which changed the button's content width mid-action).

### 4.5 What must NOT animate

- **The terminal. Ever.** No transition/animation on `.terminal`, its
  container, or anything xterm renders. Resize, attach, tab-switch to
  Terminal — all instant.
- **List-row hover** (`.session-row`, `.entry`). VS Code renders list hover
  instantly because a cursor sweeping a list with lagging tints reads as
  smear, not smoothness. Deliberately no `transition` on these — do not
  "fix" it. (Same reason the file-tree icons don't change colour on hover,
  §2.5.)
- **Panel/splitter drag geometry** — width follows the pointer 1:1.
- **Folder expand/collapse height.** The chevron rotation is the motion
  cue; the row list itself just appears (`v-show`). Do not add a
  height/slide animation to `.session-list`.

### 4.6 Reduced motion (global, `App.vue`)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
```

This subsumes the one-off reduced-motion block in `HostPickerView.vue`
(which may then be deleted) and covers `.spin`, the overlay, and the pulse.

---

## 5. Focus-visible — designed, not defaulted

`App.vue`'s global rule is right in spirit; two fixes:

```css
/* CURRENT */
:where(button, a, input, select, textarea, [tabindex]):focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--r-md);   /* ← REMOVE: mutates element geometry */
}
```

1. **Delete `border-radius: var(--r-md)`.** Outlines follow the focused
   element's own radius in Chromium; this line instead *changes the
   element's corners* on focus (visible on the square editor textarea in
   `after-05`'s layout, and on any future focusable row).
2. **Add an inset variant for rows inside scroll containers**, where a
   +2px offset ring gets clipped by `overflow-y: auto`:

```css
:where(.session-row, .entry, .folder-header):focus-visible {
  outline-offset: -2px;
}
```

(`.session-row` and `.entry` are `<li>` today and not focusable — the rule
is forward-compatible for when they become keyboard-reachable, and
`.folder-header` is already a `<button>` and benefits immediately.)

---

## 6. Rows, alignment, and hairlines

### 6.1 Session list (`after-02`, `after-08` · `SessionTree.vue`)

- **Hover/selected split is already correct** (neutral `--state-hover` vs
  accent `--state-selected` + 2px rail). Keep.
- **Child column alignment.** Folder header: `padding-left: var(--sp-2)`
  (8px) + disclosure slot + 8px gap puts the folder dot at x≈28 and label
  at x≈44 (with the 14px icon slot of §2.6: dot at 30, label at 46).
  Session rows: `padding-left: var(--sp-4)` (16px) + 2px rail slot puts the
  child dot at x≈18 — the children *outdent* their parent's label. Fix:
  `.session-row` left padding `var(--sp-4)` → **28px** (2px rail + 28 = 30)
  so the child dot sits exactly under the parent dot and the session name
  starts at the parent label's x. One constant, worth a comment.
- **Folder header height** 26px vs `--row-h` 28px — two near-identical
  values one gap apart. Set `.folder-header { height: var(--row-h); }` and
  retire the magic 26.

### 6.2 File tree (`after-05` · `FileTree.vue`)

- Icon and colour spec: settled in §2.5.
- **`.entry.active` gets the same selection rail as session rows** for
  cross-component consistency: `border-left: 2px solid transparent` on
  `.entry` (fold 2px out of the left padding), `border-left-color:
  var(--accent)` on `.entry.active`. Today one list marks selection with a
  rail and the other doesn't — adjacent inconsistency of exactly the kind
  that reads as unfinished.
- **Breadcrumbs**: `.crumb a { color: var(--accent) }` → `color:
  var(--fg-secondary)`, hover `color: var(--fg)` (keep the underline). The
  current all-cyan crumb row (`after-05`) is the loudest thing on the
  screen yet is pure navigation — and it contradicts the app's own
  "accent is reserved for selected" rule (`HostPickerView.vue` comment,
  DESIGN.md §5.2).

### 6.3 Usage cards (`after-07` · `UsageView.vue`)

- `.reset { margin: 0 0 var(--sp-2) 5.5rem; }` — a magic offset trying to
  align under the meter, off-grid and in `rem`. `.meter-label` is
  `min-width: 5rem` + `--sp-2` gap, so the meter starts at 5rem+8px —
  which `5.5rem` only approximates. Replace with
  `margin-left: calc(5rem + var(--sp-2))` and a comment tying it to
  `.meter-label`, so the two can only drift together.

### 6.4 Splitter (`after-02`, `after-03` · `HostWorkspaceView.vue`)

```css
/* CURRENT */                          /* PROPOSED */
.splitter {                            .splitter {
  width: 4px;                            width: 4px;
  cursor: col-resize;                    cursor: col-resize;
  background: var(--bg);                 background: transparent;
  transition: background                 transition: background
    var(--dur-fast) var(--ease);           var(--dur-fast) var(--ease);
}                                      }
.splitter:hover {                      .splitter:hover {
  background: var(--accent-dim);         background: var(--accent-dim);
}                                        transition-delay: 250ms;
                                       }
```

Transparent at rest: the panel's existing 1px border is the visual seam,
and the 4px `--bg` band (visibly darker than both surfaces in `after-02`)
disappears. The 250ms hover-in delay is VS Code's sash behaviour — the
highlight appears only when the cursor *lingers*, so sweeping the cursor
across the app doesn't flash a cyan bar. (The delay applies on enter only;
leaving transitions immediately.)

### 6.5 Terminal edge (`after-03`, `after-08` — flag, verify only)

The tmux status bar at the bottom of `after-03`/`after-08` is clipped by
the viewport edge (the green bar is half-visible). This is a fit/rounding
behaviour in `TerminalView.vue` (owned by in-flight work — **not specced
here**), but it reads as broken in screenshots; whoever owns that file
should confirm FitAddon runs after final layout so the last row lands
whole. Reminder from §4.5: whatever the fix, no animation.

---

## 7. Chips and badges — one metric

Padding currently varies across the small-rounded family:
`.chip`/`.tag`/`.kind`/`.window-tag`/`.status` use `0 var(--sp-1)`;
`.resume-chip`/`.block-toggle` use `2px var(--sp-1)`. Unify: all
`--r-sm`-radius badge-likes use `padding: 0 var(--sp-1)`, `line-height:
var(--lh-100)`, and `display: inline-flex; align-items: center; gap:
var(--sp-1)` (the inline-flex is also required once chips contain icons,
§2.3). Files: `HostWorkspaceView.vue` (`.chip`), `SessionTree.vue`
(`.tag`, `.agent-badge`), `PortPanelView.vue` (`.kind`), `UsageView.vue`
(`.status`, `.window-tag`), `ConversationView.vue` (`.resume-chip`,
`.block-toggle`).

**Update (docs/SESSIONLIST.md, implemented).** The metric is unchanged, but
`SessionTree.vue`'s `.tag` no longer exists: the `attached` chip is
**retired**. The session row says "attached" three ways at once — the
green `--success` dot, a `--fw-semibold` label, and the row's position at the
top of the list — so a fourth statement in chip form was competing with the
information around it rather than adding any. `.agent-badge` stays, and stays
on this metric; the port panel gained an `.origin` chip on it too.

---

## 8. Ranked impact — if only three things get done

1. **§2 Iconography** — `AppIcon.vue` + the exhaustive replacement map,
   including the rotating disclosure chevron and the settled Files-tab
   SVGs. This is the user's explicit ask, three times over, and removes the
   emoji colour noise in one stroke.
2. **§3 Ghost buttons** — de-box the topbar/panel chrome. Biggest calm-down
   per line of CSS; it is the difference between "form with buttons" and
   "tool with chrome".
3. **§4 Motion** — overlay entrance, chevron/hover transitions, spin, the
   reduced-motion guard, and the do-not-animate list. This is where
   "smooth" literally lives.

Then §5 (focus), §6 (alignment/splitter), §7 (chip metrics).

---

## 9. DESIGN.md revisions this spec makes

| DESIGN.md location | Was | Now |
|---|---|---|
| §5.1 `.icon-btn` | one bordered primitive | split: ghost square `.icon-btn` + ghost labeled `.btn-ghost` (§3); bordered look survives only on form controls and the toggle |
| §5.0 focus rule | includes `border-radius: var(--r-md)` | dropped (geometry mutation, §5); adds inset-offset variant for rows |
| §5.3 `.disclosure` | "12px caret, rotate 90° on expand" | 14px `AppIcon chevron-right`, same rotation, slot widened (§2.6); `.folder-header` height 26px → `--row-h` |
| §5.7 breadcrumb | "crumb links `--accent`" | `--fg-secondary` → `--fg` on hover; accent stays selection-only (§6.2) — the old value contradicted §5.2's own accent rule |
| §5.7 `.ic` glyphs | assumed tintable glyphs (emoji weren't) | real SVGs (user decision); `--warning` folder / `--fg-muted` file / `--fg-secondary` symlink now implementable, plus selected-state lift (§2.5) |
| §4.3 motion tokens | `--dur-fast/--dur-normal/--ease` | + `--dur-slow: 280ms`, `--ease-out` (§4.1) |
| (new) | — | §2 icon language: local inline SVG, Feather-derived (MIT), 24 viewBox / stroke 2 / 16-14-12 display sizes, currentColor, registry-only — the ComposerIcon contract, made app-wide |

Everything else in DESIGN.md stands, including the definition-of-done grep.
**Add a second gate** alongside it — no character-as-icon anywhere:

```
grep -rnP "[▸▾▼▶◀◁▷△▽←→↑↓☰⟳✕✖✗✓⌘●📁📄↪🔧📎]" src/renderer --include=*.vue
```

must return zero matches **outside** (a) code comments, (b) the genuine-text
cases listed in §2.3 (`↓`/`↑` in the composer's shortcut tooltip is the one
arrow that legitimately survives, as copy), and (c) `TerminalView.vue`.
The `·` `…` `—` `–` `~` family is exempt by design — that is text.

---

## 10. Implementation order (all steps independently shippable)

1. Create `AppIcon.vue` (§2.2). No dependency to install, no visual change
   yet.
2. `App.vue`: motion tokens (§4.1), focus fix (§5), `.spin` + reduced-motion
   (§4.4/4.6), new `.icon-btn`/`.btn-ghost` (§3).
3. Per-file glyph swaps from the §2.3 map + §3 class reassignments —
   mechanical, one component per commit; `SessionTree.vue` first (it's the
   screen the user reacted to), then `FileTree.vue` (the settled emoji
   decision), then the rest.
4. `OverlayPanel.vue` transition (§4.3), splitter (§6.4).
5. Alignment/chip passes (§6.1–6.3, §7), the `⌘S` label fix (§2.3).
6. Re-run the DESIGN.md §6 screenshot capture; both grep gates.

Coordination notes: `PromptComposer.vue`, `ComposerAttachmentTiles.vue`,
`SlashCommandDropdown.vue`, and `TerminalView.vue` are in flight elsewhere
— everything here avoids those files. The composer has **already adopted**
this spec's icon language via its local `ComposerIcon.vue`; folding that
into `AppIcon.vue` is a later rename owned by whoever touches the composer
next, not part of this pass.
