<script setup lang="ts">
// AppIcon: the ONLY way an icon enters this UI. No character ever stands in
// for a graphic affordance — see docs/POLISH.md §2 and docs/DESIGN.md §5.8.
//
// Contract (inherited verbatim from the composer's ComposerIcon, which this
// component replaced — the two sets were specified to be pixel-identical so
// the merge was a rename):
//   - one 24x24 viewBox for every mark, so stroke weights stay identical;
//   - stroke="currentColor", never a literal colour — an icon inherits the
//     parent's token colour and its hover/disabled states for free;
//   - stroke-width 2, round caps/joins: Feather 4.29 geometry (MIT), the thin
//     geometric unfilled register of VS Code's Codicons.
//
// Displayed at 16px (default — toolbars, tree glyphs), 14px (dense bars, the
// disclosure chevron) or 12px (chips, table-row actions, block toggles). No
// other sizes; the composer's two sub-12px pips are CSS overrides on marks
// that are status dots rather than affordances.
export type AppIconName =
  | 'alert-triangle'
  | 'arrow-left'
  | 'arrow-right'
  | 'arrow-up'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-up'
  | 'circle'
  | 'close'
  | 'download'
  | 'dot'
  | 'edit-2'
  | 'file'
  | 'folder'
  | 'folder-plus'
  | 'git-branch'
  | 'home'
  | 'image'
  | 'minus'
  | 'more-horizontal'
  | 'panel-left'
  | 'paperclip'
  | 'plus'
  | 'refresh'
  | 'rotate-ccw'
  | 'search'
  | 'settings'
  | 'square'
  | 'star'
  | 'star-filled'
  | 'symlink'
  | 'toggle-left'
  | 'toggle-right'
  | 'tool'
  | 'trash-2';

/**
 * Feather 4.29 path data (MIT), verbatim. One entry per icon.
 *
 * `filled` marks the exceptions to the outline register: a status dot has no
 * outline to speak of, so it is painted rather than stroked.
 */
interface IconShape {
  paths: string[];
  filled?: boolean;
}

/**
 * Feather's `star` polygon, its ten points written as one path so the template
 * stays a single path loop. Shared by the two entries below rather than typed
 * twice: `star` and `star-filled` are ONE mark in two states, and a
 * transcription drift between them would show up as the outline and the solid
 * being subtly different stars.
 */
const STAR_PATH =
  'M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26z';

const GEOMETRY: Record<AppIconName, IconShape> = {
  // Feather's `alert-triangle`. The banner mark for a scan that is failing —
  // a warning about a background process, not an error the user caused.
  'alert-triangle': {
    paths: [
      'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
      'M12 9v4',
      'M12 17h.01',
    ],
  },
  'arrow-left': { paths: ['M19 12H5', 'M12 19l-7-7 7-7'] },
  'arrow-right': { paths: ['M5 12h14', 'M12 5l7 7-7 7'] },
  // "Up one folder" in the project browser. An arrow, not a chevron: the
  // chevron is this app's disclosure/navigate-into mark and is already spoken
  // for by the folder rows underneath it.
  'arrow-up': { paths: ['M12 19V5', 'M5 12l7-7 7 7'] },
  check: { paths: ['M20 6L9 17l-5-5'] },
  'chevron-down': { paths: ['M6 9l6 6 6-6'] },
  'chevron-right': { paths: ['M9 18l6-6-6-6'] },
  'chevron-up': { paths: ['M18 15l-6-6-6 6'] },
  // Feather's `circle` — the ellipse shape tool. Its <circle cx=12 cy=12 r=10>
  // is an arc pair, the same conversion `dot` and `search` already use. Stroked,
  // not filled: it is an outline shape, and the fill is the canvas's business.
  circle: { paths: ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20'] },
  close: { paths: ['M18 6L6 18', 'M6 6l12 12'] },
  // A circle expressed as two semicircular arcs, so the template stays one
  // path loop. Painted, not stroked: this is a pip, not an outline.
  dot: { paths: ['M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10'], filled: true },
  // Feather's `download` — the clone route. Not `git-branch`: what the user is
  // asking for is "bring this repo down onto the host", and the branch mark
  // reads as VCS topology rather than as an action.
  download: { paths: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'] },
  // Feather's `edit-2` — the pen. The draw tool. Not `edit-3` (pen + underline,
  // which reads as "edit this field") and not `pen-tool` (bezier authoring).
  'edit-2': { paths: ['M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z'] },
  file: { paths: ['M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M13 2v7h7'] },
  folder: { paths: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'] },
  // Feather's `folder-plus` — the "new empty folder" route.
  'folder-plus': {
    paths: [
      'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
      'M12 11v6',
      'M9 14h6',
    ],
  },
  // Feather's `git-branch`, its two <circle>s expressed as arc pairs so the
  // template stays one path loop. Marks a row that IS a git repo.
  'git-branch': {
    paths: [
      'M6 3v12',
      'M18 3a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
      'M6 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
      'M18 9a9 9 0 0 1-9 9',
    ],
  },
  // Feather's `home` — "back to $HOME" in the project browser's breadcrumb.
  home: { paths: ['M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10'] },
  // Feather's `image` — the picture being annotated, and the "add a picture"
  // source. Its rounded <rect> is the same frame `panel-left` and `square`
  // convert; its <circle> is an arc pair; its <polyline> a relative path.
  image: {
    paths: [
      'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
      'M8.5 7a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3',
      'M21 15l-5-5-11 11',
    ],
  },
  // Feather's `minus`, its <line x1=5 x2=19 y=12> as a path. Two jobs: the
  // straight-line tool, and the stroke-width affordance (a rule of ink).
  minus: { paths: ['M5 12h14'] },
  // Feather's `more-horizontal`, its three <circle r=1> as arc pairs — the
  // same conversion `dot`, `search` and `settings` use. The overflow mark: it
  // is the one glyph that reliably reads as "there is more here" without
  // claiming what, which is exactly what a menu of named items needs from its
  // trigger. Filled rather than stroked, because a 1px-radius outline circle
  // at 14px is a smudge; `dot` is filled for the same reason.
  'more-horizontal': {
    paths: [
      'M5 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2',
      'M12 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2',
      'M19 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2',
    ],
    filled: true,
  },
  // Feather's `sidebar`, its <rect> expressed as a path so the template stays
  // a single path loop. This is VS Code's "toggle sidebar" mark.
  'panel-left': {
    paths: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 3v18'],
  },
  paperclip: {
    paths: [
      'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
    ],
  },
  plus: { paths: ['M12 5v14', 'M5 12h14'] },
  // Feather's `rotate-cw` (one arc + one arrowhead), chosen over `refresh-cw`
  // (two arcs) for calm at 14px — and it spins cleanly while loading.
  refresh: { paths: ['M23 4v6h-6', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10'] },
  // Feather's `rotate-ccw` — undo. Deliberately the exact mirror of `refresh`
  // above (which is Feather's `rotate-cw`, same arc, same arrowhead): the pair
  // has to be one family, or undo and reload read as unrelated marks.
  'rotate-ccw': { paths: ['M1 4v6h6', 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10'] },
  // Feather's `search`, its <circle> as an arc pair. Filter fields only.
  search: { paths: ['M11 3a8 8 0 1 0 0 16a8 8 0 1 0 0-16', 'M21 21l-4.35-4.35'] },
  // Feather's `settings` — the gear, opening the app-level settings panel. Its
  // <circle cx=12 cy=12 r=3> is an arc pair, the same conversion `dot` and
  // `search` use; the outer path is verbatim. The gear rather than `sliders`:
  // sliders reads as "filter/adjust this view", and this control is not scoped
  // to the screen it sits on.
  settings: {
    paths: [
      'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
      'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z',
    ],
  },
  // Feather's `square` — the rectangle shape tool. Same rounded <rect> as
  // `panel-left`'s frame, converted the same way.
  square: {
    paths: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'],
  },
  // "Default host" in the picker, in its two states. Outline vs solid is a
  // SHAPE difference, not a colour one, for the same reason `toggle-left` and
  // `toggle-right` exist as a pair: a two-state control has to be readable
  // without relying on the tint.
  star: { paths: [STAR_PATH] },
  'star-filled': { paths: [STAR_PATH], filled: true },
  symlink: { paths: ['M4 4v7a4 4 0 0 0 4 4h12', 'M15 10l5 5-5 5'] },
  // Feather's `toggle-left` / `toggle-right`: the port panel's per-row on/off.
  // A real two-state mark, so "forwarded" and "silenced" differ in SHAPE and
  // not only in colour (the knob moves), which a checkbox tick cannot do.
  'toggle-left': {
    paths: ['M8 5h8a7 7 0 0 1 0 14H8a7 7 0 0 1 0-14z', 'M8 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6'],
  },
  'toggle-right': {
    paths: ['M8 5h8a7 7 0 0 1 0 14H8a7 7 0 0 1 0-14z', 'M16 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6'],
  },
  tool: {
    paths: [
      'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
    ],
  },
  // Feather's `trash-2` — clear the canvas. Its lid <polyline> (3 6, 5 6, 21 6,
  // three collinear points) is the single span they describe; its two <line>
  // ribs are paths. `trash-2` over `trash` because the ribs keep the mark from
  // collapsing into a solid blob at 14px.
  'trash-2': {
    paths: [
      'M3 6h18',
      'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
      'M10 11v6',
      'M14 11v6',
    ],
  },
};

const props = withDefaults(
  defineProps<{
    name: AppIconName;
    size?: 12 | 14 | 16;
    /** Decorative by default — the surrounding button carries the label. */
    title?: string;
  }>(),
  { size: 16, title: undefined },
);
</script>

<template>
  <svg
    class="app-icon"
    viewBox="0 0 24 24"
    :width="props.size"
    :height="props.size"
    :fill="GEOMETRY[props.name].filled ? 'currentColor' : 'none'"
    :stroke="GEOMETRY[props.name].filled ? 'none' : 'currentColor'"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="props.title ? undefined : 'true'"
    :role="props.title ? 'img' : undefined"
    focusable="false"
  >
    <title v-if="props.title">{{ props.title }}</title>
    <path v-for="(d, i) in GEOMETRY[props.name].paths" :key="i" :d="d" />
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
