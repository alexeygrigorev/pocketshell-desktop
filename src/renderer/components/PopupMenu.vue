<script setup lang="ts">
// PopupMenu: one menu implementation, teleported out of every clipping
// ancestor and positioned from its anchor's measured box.
//
// It exists because the first menu in this app did not work. The folder
// workspace's `+` rendered a `position: absolute` dropdown inside the tab
// strip, and the strip has `overflow-x: auto` so that many tabs scroll rather
// than wrap — which, per CSS, makes `overflow-y` compute to `auto` as well. The
// menu was laid out exactly at the strip's clip edge and nothing was ever
// visible. See the header of src/shared/popupPlacement.ts for the measurement.
//
// The file tree's context menu would have hit the identical wall (its anchor is
// a row inside a scrolling list), so the fix is a component rather than a patch:
// `Teleport` to `<body>` puts the menu outside every `overflow` on the page, and
// `position: fixed` against a measured rect keeps it attached to an anchor whose
// container may be mid-scroll.
//
// Dismissal is the composer's rule (commit bc86cf7), reused rather than
// reinvented: `mousedown` in CAPTURE, gated on where the press LANDED. Gating
// on the press rather than the click is what stops a drag that began inside the
// menu — or inside the control that opened it — from dismissing on mouse-up
// somewhere else.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { popupPlacement, type Box } from '../../shared/popupPlacement';

const props = defineProps<{
  /**
   * The box to hang the menu off, in VIEWPORT coordinates — a control's
   * `getBoundingClientRect()`, or `pointAnchor(e.clientX, e.clientY)` for a
   * context menu.
   */
  anchor: Box;
  /**
   * Elements whose own presses must not count as "outside".
   *
   * The control that OPENED the menu is the case this exists for: without it,
   * clicking `+` a second time would be seen here first, close the menu, and
   * then let the button's own handler re-open it — so the menu would appear
   * frozen open, and the bug would look like the toggle not working. Same
   * reasoning as the composer's pinned toggle.
   */
  ignore?: (HTMLElement | null | undefined)[];
  /** Accessible name for the menu itself. */
  label?: string;
}>();

const emit = defineEmits<{ close: [] }>();

const rootEl = ref<HTMLElement | null>(null);
/**
 * Null until the menu has been measured.
 *
 * The menu is rendered once, invisibly, so its natural size can be read; the
 * placement needs a real height to decide whether to flip. Rendering it at the
 * un-placed origin first would show a frame of menu in the top-left corner,
 * which reads as a glitch — so it is `visibility: hidden` for exactly one tick.
 */
const placed = ref<{ left: number; top: number; flipped: boolean; maxHeight: number } | null>(null);

const style = computed(() => {
  const p = placed.value;
  if (!p) return { visibility: 'hidden' as const, left: '0px', top: '0px' };
  return {
    left: `${p.left}px`,
    top: `${p.top}px`,
    maxHeight: `${p.maxHeight}px`,
    transformOrigin: p.flipped ? 'bottom left' : 'top left',
  };
});

function measure(): void {
  const el = rootEl.value;
  if (!el) return;
  const box = el.getBoundingClientRect();
  placed.value = popupPlacement(
    props.anchor,
    { left: 0, top: 0, width: box.width, height: box.height },
    { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
  );
}

// Re-measure when the anchor moves. A context menu re-opened on another row is
// the same component instance with a new anchor, and without this it would stay
// where it was first placed.
watch(() => props.anchor, () => void nextTick(measure), { deep: true });

/**
 * Escape closes, and it is taken in CAPTURE and stopped.
 *
 * Stopping it matters: the composer also listens for Escape in capture, as its
 * "put the panel away" gesture, and TerminalView forwards keystrokes to the
 * remote shell. Without `stopPropagation` a single Escape aimed at this menu
 * would also dismiss the composer, or reach the agent running in the pane —
 * one keypress doing three things, two of them unasked for.
 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  emit('close');
}

function onPointerDown(e: MouseEvent): void {
  const target = e.target;
  if (!(target instanceof Node)) return;
  if (rootEl.value?.contains(target)) return;
  for (const el of props.ignore ?? []) {
    if (el && el.contains(target)) return;
  }
  emit('close');
}

/**
 * A scroll anywhere closes the menu rather than chasing the anchor.
 *
 * The anchor can live inside a scrolling strip or list, so scrolling moves the
 * control out from under a `fixed` menu that stays put. Following it would mean
 * a measurement per scroll event; closing is what every native menu does and is
 * what the user expects from a menu they have started scrolling away from.
 * Capture, because the scroll happens on an inner element, not on `window`.
 */
function onScroll(): void {
  emit('close');
}

onMounted(() => {
  void nextTick(measure);
  window.addEventListener('keydown', onKeydown, { capture: true });
  window.addEventListener('mousedown', onPointerDown, { capture: true });
  window.addEventListener('scroll', onScroll, { capture: true });
  window.addEventListener('resize', onScroll);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, { capture: true });
  window.removeEventListener('mousedown', onPointerDown, { capture: true });
  window.removeEventListener('scroll', onScroll, { capture: true });
  window.removeEventListener('resize', onScroll);
});
</script>

<template>
  <!-- To `body`, which is the whole point: it is the one place with no
       `overflow` between it and the viewport. Teleported nodes keep their
       scope id, so the scoped styles below still apply. -->
  <Teleport to="body">
    <div
      ref="rootEl"
      class="popup-menu"
      role="menu"
      :aria-label="label"
      :style="style"
      @contextmenu.prevent
    >
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.popup-menu {
  position: fixed;
  /* Above the composer dock (z-index 5) and the overlay scrim's siblings, but
     this is a `body` child so it is competing with the app root rather than
     with anything inside it. */
  z-index: 60;
  min-width: 180px;
  overflow-y: auto;
  padding: var(--sp-1);
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: 0 8px 24px var(--scrim);
}
/* The item register, published here so both call sites get one menu rather
   than two that drift. `:deep` because the items arrive through the slot and
   so carry the PARENT's scope id, not this component's. */
.popup-menu :deep(.menu-head) {
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-muted);
}
.popup-menu :deep(.menu-sep) {
  height: 1px;
  margin: var(--sp-1) 0;
  background: var(--border);
  list-style: none;
}
.popup-menu :deep(.menu-item) {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg);
  padding: var(--sp-1) var(--sp-2);
  cursor: pointer;
  white-space: nowrap;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
}
.popup-menu :deep(.menu-item:hover) {
  background: var(--state-hover);
}
.popup-menu :deep(.menu-item:disabled) {
  color: var(--fg-muted);
  cursor: default;
}
.popup-menu :deep(.menu-item:disabled:hover) {
  background: transparent;
}
.popup-menu :deep(ul) {
  list-style: none;
  margin: 0;
  padding: 0;
}
</style>
