<script setup lang="ts">
// HostActionsMenu: the three host-scoped destinations — Ports, Usage, Settings
// — as one menu, in one place, used from two triggers.
//
// It is a component rather than three `<li>`s written twice because it has
// exactly two call sites that must not drift: the session panel's header
// (where the user asked for these controls to live) and the COLLAPSED RAIL
// (which exists precisely so host controls are not stranded off-screen when the
// panel is hidden — commit ca79ae2). If those two lists ever disagreed, the
// collapsed state would quietly offer less than the expanded one, which is the
// exact failure the rail was invented to prevent.
//
// ## Why a menu, and why the labels are words
//
// ca79ae2 put these at the panel's foot and argued against a header row in one
// line: "two unlabelled overlay glyphs would be a memory test". That objection
// is right and it is not answered by moving the buttons — it is answered by not
// having buttons. Inside a menu, Ports and Usage keep their words; the strip
// spends a single 14px overflow mark; and the gear stays icon-only beside its
// own label, as it is app-wide.
import PopupMenu from './PopupMenu.vue';
import AppIcon from './AppIcon.vue';
import type { Box } from '../../shared/popupPlacement';
import { HOST_PANEL_ITEMS, type HostPanel } from '../hostPanels';

defineProps<{
  /** Measured box of the control that opened it. */
  anchor: Box;
  /** The trigger, so its own press is not read as a click-outside. */
  trigger?: HTMLElement | null;
}>();

const emit = defineEmits<{ select: [panel: HostPanel]; close: [] }>();
</script>

<template>
  <PopupMenu
    :anchor="anchor"
    :ignore="[trigger]"
    label="Host actions"
    @close="emit('close')"
  >
    <!-- Rendered from HOST_PANEL_ITEMS rather than written out, so the two
         triggers and the workspace's own `panel` ref share one vocabulary. -->
    <ul>
      <template v-for="item in HOST_PANEL_ITEMS" :key="item.panel">
        <!-- Settings is APP-level while the pair above is host-level, so it
             sits below a rule. Same distinction the retired foot row drew by
             pushing the gear to the far corner. -->
        <li v-if="item.appLevel" class="menu-sep" />
        <li>
          <button class="menu-item" @click="emit('select', item.panel)">
            <AppIcon v-if="item.appLevel" name="settings" :size="14" />
            {{ item.label }}
          </button>
        </li>
      </template>
    </ul>
  </PopupMenu>
</template>
