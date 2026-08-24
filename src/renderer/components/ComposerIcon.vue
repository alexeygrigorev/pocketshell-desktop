<script setup lang="ts">
// ComposerIcon: the composer panel's icon set, as real inline SVG.
//
// No character stands in for a graphic affordance anywhere in this panel — the
// close, maximize/restore, chevron, paperclip and file marks are all drawn, not
// typed. Emoji and box-drawing characters render in whatever fallback font the
// OS picks, at whatever weight it feels like, and they do not respond to a
// design token; these do.
//
// Rules the geometry follows:
//   - one 24x24 viewBox for every mark, displayed at 16px, so stroke weights
//     stay identical across icons;
//   - `stroke="currentColor"` and never a literal colour, so an icon inherits
//     the button's token colour and its hover/disabled states for free;
//   - thin, geometric, unfilled — the VS Code Codicon register, not a rounded
//     or filled set. Geometry is Feather-derived (MIT).
//
// This is deliberately local. A shared app-wide icon component is being
// specified separately in docs/POLISH.md; folding these into it later is a
// rename, whereas blocking on it now would stall the panel.
export type ComposerIconName =
  | 'chevron-up'
  | 'chevron-down'
  | 'close'
  | 'paperclip'
  | 'file'
  | 'dot';

defineProps<{
  name: ComposerIconName;
  /** Decorative by default — the surrounding button carries the label. */
  title?: string;
}>();
</script>

<template>
  <svg
    class="icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="title ? undefined : 'true'"
    :role="title ? 'img' : undefined"
    focusable="false"
  >
    <title v-if="title">{{ title }}</title>

    <path v-if="name === 'chevron-up'" d="M18 15l-6-6-6 6" />

    <path v-else-if="name === 'chevron-down'" d="M6 9l6 6 6-6" />

    <template v-else-if="name === 'close'">
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </template>

    <path
      v-else-if="name === 'paperclip'"
      d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
    />

    <template v-else-if="name === 'file'">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M13 2v7h7" />
    </template>

    <!-- The one filled mark: a status dot has no outline to speak of. -->
    <circle v-else-if="name === 'dot'" cx="12" cy="12" r="5" fill="currentColor" stroke="none" />
  </svg>
</template>

<style scoped>
.icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  display: block;
}
</style>
