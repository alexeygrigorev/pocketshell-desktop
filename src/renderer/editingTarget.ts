/**
 * Is this keystroke aimed at something the user is EDITING?
 *
 * Every window-level capture chord in the renderer consults this before it
 * acts: while the user is typing prose — the composer's draft, the Files path
 * box, the tree filter, the creation picker's search — navigation and
 * creation chords do not interrupt. It lived as a private copy in
 * `HostWorkspaceView` and `FolderWorkspaceView`, and each copy carried the
 * same "the two must not drift" warning beside it; a third chord needing the
 * answer is what turned the warning into a module, because a rule three call
 * sites must agree about is a derivation, not a snippet.
 *
 * The terminal is deliberately NOT in the editable set, and that exception is
 * the load-bearing half — the reason this is a function rather than an
 * `instanceof HTMLTextAreaElement` test: xterm's own input sink IS a
 * `<textarea>` (`.xterm-helper-textarea`), always focused while the pane has
 * the keyboard. A naive editable check would exempt the terminal — the one
 * surface most chords exist for — and the chord would appear to do nothing at
 * all. So an editable inside `.xterm` is not an editable.
 */
export function editingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.xterm')) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
