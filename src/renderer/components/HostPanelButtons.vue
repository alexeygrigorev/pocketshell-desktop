<script setup lang="ts">
// HostPanelButtons: the two host overlays as DIRECT icon buttons, rendered
// identically from the session panel's header and from the collapsed rail.
//
// §5.3e killed the overflow menu at the user's ask ("we can kill the kebab here
// and have two icons instead"). What makes that affordable — what answers
// ca79ae2's "two unlabelled glyphs are a memory test" without reopening it as
// an argument — is that each button keeps its WORD in one place a tooltip is
// enough for: the `title`, which is also its whole accessible name. The same
// held for the retired `⋯` trigger ("Ports, Usage") and holds now per button.
//
// It is a component rather than two `<button>`s written twice because it has
// exactly two call sites that must not drift, which is the reason
// HostActionsMenu existed; this replaces it with the smallest shape that
// preserves that property. Items come from HOST_PANEL_ITEMS (../hostPanels.ts)
// rather than written out, so the triggers and the workspace's own `panel` ref
// keep sharing one vocabulary.
import AppIcon from './AppIcon.vue';
import { HOST_PANEL_ITEMS, type HostPanel } from '../hostPanels';

const emit = defineEmits<{ select: [panel: HostPanel] }>();
</script>

<template>
  <!-- No local styling: `.icon-btn` is the app-wide ghost square (App.vue),
       sized by --control-h exactly like the refresh/gear/hide marks it stands
       between. The order of the strip lives in HOST_PANEL_ITEMS. -->
  <button
    v-for="item in HOST_PANEL_ITEMS"
    :key="item.panel"
    class="icon-btn"
    :title="item.label"
    @click="emit('select', item.panel)"
  >
    <AppIcon :name="item.icon" :size="14" />
  </button>
</template>
