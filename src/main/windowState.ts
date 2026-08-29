import Store from 'electron-store';
import { screen, type BrowserWindow } from 'electron';
import { sanitizeWindowBounds, type PersistedWindowBounds } from '../shared/windowBounds.js';

/**
 * Cross-launch persistence for the main window's size, position and maximized
 * state.
 *
 * electron-store, following PortfwdStore's precedent — this is main-process
 * app state, not a renderer preference, and the renderer has no business
 * holding geometry it cannot see (it knows nothing of maximization or of the
 * OS work areas the restore has to be validated against).
 *
 * The store is opened LAZILY: `electron-store` resolves `app.getPath(
 * 'userData')` at construction, which throws outside a running app — the same
 * reason PortfwdStore defers its backend.
 */
const KEY = 'windowBounds';

let store: Store | null = null;

function getStore(): Store {
  store ??= new Store();
  return store;
}

/**
 * The bounds to open with, or null for "default size, OS-placed".
 *
 * Anything on disk is run through the shared sanitizer against the CURRENT
 * displays, so a record naming a monitor that is no longer attached degrades
 * to a centered window instead of stranding the app off-screen — which on a
 * laptop that last ran docked is the common case, not the edge case.
 */
export function readWindowBounds(): PersistedWindowBounds | null {
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  return sanitizeWindowBounds(getStore().get(KEY), workAreas);
}

/**
 * Capture the window's geometry for the next launch.
 *
 * `getNormalBounds()`, not `getBounds()`: when the window is maximized the
 * normal rect is the pre-maximize geometry, which is what an un-maximize must
 * land on. Persisting the maximized rect instead would grow the stored size a
 * little on every maximize/close cycle and make "restore" drop a maximized
 * window into a stretched normal one.
 *
 * Called from main's `close` handler; a synchronous write there is fine — it
 * is once per launch, and an async write racing process exit is how the value
 * gets lost.
 */
export function writeWindowBounds(win: BrowserWindow): void {
  const { x, y, width, height } = win.getNormalBounds();
  getStore().set(KEY, { x, y, width, height, maximized: win.isMaximized() });
}
