import { computed, onBeforeUnmount, ref } from 'vue';

/**
 * One horizontally-dragged, localStorage-remembered pane width.
 *
 * HostWorkspaceView's session panel and FilesView's tree are the same feature
 * in two fonts: a splitter, a clamp-on-read-and-write width, a document-level
 * mousemove/mouseup pair per drag, and one localStorage write per drag. Those
 * two copies are why this composable exists — the comment they shared said
 * "the two must not drift", and a shared function is the only way to keep
 * that promise.
 *
 * [measureOrigin] maps the drag-start event to the viewport x the width is
 * measured from. A pane that starts at x=0 (the host workspace's panel) does
 * not need it; a nested pane measures its own left edge, because `clientX`
 * alone is the workspace's width, not the pane's.
 */
export function usePaneWidth(options: {
  storageKey: string;
  min: number;
  max: number;
  defaultWidth: number;
  measureOrigin?: (event: MouseEvent) => number;
}) {
  const { storageKey, min, max, defaultWidth, measureOrigin } = options;

  function load(): number {
    const stored = Number.parseInt(window.localStorage.getItem(storageKey) ?? '', 10);
    if (Number.isNaN(stored)) return defaultWidth;
    // Clamped on read as well as on write: the stored value predates any
    // change to the clamp, and a hand-edited or corrupt entry must not be
    // able to strand the pane offscreen.
    return Math.min(max, Math.max(min, stored));
  }

  const width = ref(load());
  const style = computed(() => ({ flex: `0 0 ${width.value}px` }));

  let origin = 0;

  function onDragStart(event: MouseEvent): void {
    origin = measureOrigin ? measureOrigin(event) : 0;
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(event: MouseEvent): void {
    width.value = Math.min(max, Math.max(min, event.clientX - origin));
  }

  function onDragEnd(): void {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    // Written once per drag, not per mousemove: this is a preference, and a
    // localStorage write on every pointer sample is a synchronous disk touch
    // inside the drag loop.
    window.localStorage.setItem(storageKey, String(width.value));
  }

  onBeforeUnmount(onDragEnd);

  return { width, style, onDragStart };
}
