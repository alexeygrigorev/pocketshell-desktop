/**
 * How the host workspace asks the folder workspace on screen to take the
 * keyboard.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * Clicking the panel row of the folder that is ALREADY open is "take me to
 * this workspace", but it is not a navigation — same folder, same route — so
 * the host view has no arrival event to lean on and no `?tab=` hand-off rides
 * along. Every way of ARRIVING at a folder lands focus in the pane in front
 * (FolderWorkspaceView's `loadFolderState`); the re-click must land the same
 * way without arriving. The host cannot reach into a terminal it does not own,
 * so the mounted workspace advertises the one thing the host may ask of it.
 *
 * This is deliberately the smallest thing that can be — a single slot,
 * registered by `FolderWorkspaceView` on mount and cleared on unmount — the
 * same shape as `pendingAgentLaunch`: park a capability where the one caller
 * that needs it can find it, and let the component that owns the behaviour
 * stay the sole judge of what focusing means.
 *
 * A single slot and not a map because a window shows at most one folder
 * workspace: the `<router-view>` under `HostWorkspaceView` mounts exactly one
 * pane component, so there is never a second registrant to tell apart.
 */

type FocusFn = () => void;

let registered: FocusFn | null = null;

/** The mounted folder workspace advertises its focus. Idempotent per instance. */
export function registerWorkspaceFocus(fn: FocusFn): void {
  registered = fn;
}

/** The workspace is going away; a stale slot must not focus an unmounted tree. */
export function unregisterWorkspaceFocus(fn: FocusFn): void {
  if (registered === fn) registered = null;
}

/** Ask the workspace on screen to take the keyboard. A no-op when none is mounted. */
export function requestWorkspaceFocus(): void {
  registered?.();
}
