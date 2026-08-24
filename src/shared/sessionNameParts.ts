/**
 * The single path-component sanitiser, shared across the process boundary.
 *
 * This is pure string logic with no Node dependency, and both sides need the
 * SAME one: the main process derives the session name the host will use
 * (../main/projects/sessionName.ts), and the renderer's redundancy test —
 * "is this session name just its folder restated?" — must run the exact regex
 * that derived it, or it suppresses the wrong rows. Duplicating the pattern
 * would let the two copies drift silently, so it lives here and
 * `sessionName.ts` re-exports it for its existing callers.
 */

/**
 * Normalise a single path component to tmux-safe characters.
 *
 * Order matters and mirrors tmuxctl: `.` and `:` collapse to `_` FIRST
 * (tmux forbids both in session names — `:` is its window/pane separator),
 * then any other disallowed run collapses to a single `-`, then leading and
 * trailing `-` are stripped.
 */
export function sanitisePart(part: string): string {
  return part
    .replace(/[.:]+/g, '_')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}
