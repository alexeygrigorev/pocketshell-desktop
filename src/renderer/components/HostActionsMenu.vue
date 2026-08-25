<script setup lang="ts">
// HostActionsMenu: the host-scoped OVERLAY destinations that need words —
// Ports and Usage — as one menu, in one place, used from two triggers.
//
// It is a component rather than two `<li>`s written twice because it has
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
// having buttons. Inside a menu, Ports and Usage keep their words, and the
// strip spends a single 14px overflow mark for both.
//
// ## Why SETTINGS is no longer in here
//
// The user asked for the strip to read `⋯ · refresh · settings · hide`, which
// promotes the gear back out to its own control. That does not reopen the
// argument above, it sits outside it: the objection was about glyphs nobody can
// read, and the gear is the one mark in this trio that is already icon-only
// everywhere else in the app. Ports and Usage stay. The rail grew its own gear
// at the same time, so the collapsed state still reaches all three.
import PopupMenu from './PopupMenu.vue';
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
         triggers and the workspace's own `panel` ref share one vocabulary.
         No icons and no separator: both rows are host-level overlays, both are
         named in words, and there is nothing left in the list to set apart now
         that the app-level gear has its own control on both surfaces. -->
    <ul>
      <li v-for="item in HOST_PANEL_ITEMS" :key="item.panel">
        <button class="menu-item" @click="emit('select', item.panel)">
          {{ item.label }}
        </button>
      </li>
    </ul>
  </PopupMenu>
</template>
