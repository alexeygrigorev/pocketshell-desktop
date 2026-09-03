import { ref } from 'vue';

/**
 * The mechanics of a one-strip HTML5 reorder drag: what starts it, where the
 * pointer sits relative to a row's midpoint, and what clears it. The POLICY
 * stays at the call site — when a drag may start, where a row may land, and
 * what a landed drop commits — because that is the part that differs between
 * the workspace tab bar (horizontal, one strip) and the session panel's folder
 * list (vertical, one strip per root).
 *
 * FolderWorkspaceView and SessionTree are the two call sites; their
 * drop-indicator shapes differ (a gap in one strip vs root+gap across many),
 * so the indicator refs stay site-local and this module owns everything that
 * is genuinely the same.
 */
export function useStripDrag(options: { dragType: string; axis: 'x' | 'y' }) {
  /** The strip-local id being dragged, or null between drags. */
  const dragging = ref<string | null>(null);

  /**
   * Begin the drag of [id].
   *
   * A payload is required — Firefox refuses to start a drag without one — and
   * the id is the honest thing to carry. It is deliberately NOT what the drop
   * reads: `dragging` is, because the drop only ever happens inside the
   * component that started the drag, and a cross-window drop of that id would
   * mean nothing here. A type nothing else in the window claims is also what
   * keeps other drop zones (the composer's) from lighting up as a row passes
   * over them.
   */
  function startDrag(id: string, e: DragEvent): void {
    dragging.value = id;
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(options.dragType, id);
  }

  /**
   * Which gap the pointer is in, given the row it is over.
   *
   * The MIDPOINT of the hovered row, so the indicator flips to the far side
   * once the cursor is past half of it — the behaviour every tab strip has,
   * and the one that makes the first and last positions reachable without
   * pixel accuracy.
   */
  function gapFor(index: number, e: DragEvent): number {
    const box = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    if (!box) return index;
    const horizontal = options.axis === 'x';
    const along = horizontal ? e.clientX : e.clientY;
    const edge = horizontal ? box.left : box.top;
    const size = horizontal ? box.width : box.height;
    return along >= edge + size / 2 ? index + 1 : index;
  }

  /**
   * Mark the hovered strip as a legal drop target for this event.
   *
   * `preventDefault` is what MAKES it one — without it the browser refuses the
   * drop and plays the snap-back animation, which is the exact thing a visible
   * refusal (the site's job: clear its indicator and return) is trying not to
   * look like.
   */
  function markDroppable(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  /** Clear everything — after a drop lands or a drag is cancelled. */
  function endDrag(): void {
    dragging.value = null;
  }

  return { dragging, startDrag, gapFor, markDroppable, endDrag };
}
