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
//
// The Ports button additionally carries the auto-forward indicator: a tinted
// ring + a small dot while the engine is running for this host (§16 of
// docs/PORTFWD.md). The workspace owns the value and hands it down so the two
// surfaces stay identical; the state has to live THERE because the forwards
// store is only fresh while the ports overlay is open.
import AppIcon from './AppIcon.vue';
import { HOST_PANEL_ITEMS, type HostPanel, type HostPanelItem } from '../hostPanels';

const props = withDefaults(defineProps<{ autoForward?: boolean }>(), { autoForward: false });

const emit = defineEmits<{ select: [panel: HostPanel] }>();

/**
 * The button's word, extended while the indicator is up. "Port forwarding"
 * alone stops being the whole truth when the glyph also claims the engine is
 * running — and the tooltip is still the button's entire accessible name, so
 * the suffix is what keeps §5.3e's rule (the word travels with the mark)
 * honest rather than merely styled.
 */
function title(item: HostPanelItem): string {
  return item.panel === 'ports' && props.autoForward
    ? `${item.label} — auto-forward on`
    : item.label;
}
</script>

<template>
  <!-- `.icon-btn` is the app-wide ghost square (App.vue), sized by --control-h
       exactly like the refresh/gear/hide marks it stands between. The order of
       the strip lives in HOST_PANEL_ITEMS. The one local exception is the
       auto-forward state below: the ghost register is invisible at rest, and an
       invisible indicator is no indicator. -->
  <button
    v-for="item in HOST_PANEL_ITEMS"
    :key="item.panel"
    :class="['icon-btn', { 'auto-on': item.panel === 'ports' && autoForward }]"
    :title="title(item)"
    @click="emit('select', item.panel)"
  >
    <AppIcon :name="item.icon" :size="14" />
    <span v-if="item.panel === 'ports' && autoForward" class="auto-dot" />
  </button>
</template>

<style scoped>
/* Auto-forward ON (docs/PORTFWD.md §16). The tinted ring is the same "on"
   register the panel's own toggle words it (.toggle.on in PortPanelView:
   --accent-soft fill, --accent-dim edge, --accent glyph), so one state reads
   one way in both places. The dot is the LIVE half of the message: a ring
   alone could be read as "selected", a glowing dot says "running". The ring is
   an inset shadow rather than a border so the glyph stays centred in the fixed
   square instead of shifting half a pixel when the state flips. */
.icon-btn.auto-on {
  position: relative;
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent-dim);
}
/* Hover keeps the register: the global ghost hover would repaint the fill and
   glyph neutral, and an indicator that vanishes under the cursor is worse than
   none. Only the fill deepens a step, which is what the ghost hover already
   means. */
.icon-btn.auto-on:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-soft) 60%, var(--state-hover));
  color: var(--accent);
}
.icon-btn.auto-on:active:not(:disabled) {
  background: var(--accent-soft);
}
.auto-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 5px 0 var(--accent);
}
</style>
