/**
 * The OS window title, as a pure function.
 *
 * The host workspace has no identity bar of its own any more: the row that
 * used to read `hetzner · alexey@135.181.114.209` above every terminal was a
 * full `--topbar-h` of chrome restating something the OS already provides a
 * surface for. The native title bar carries it now — which also puts the host
 * name in the taskbar and in Alt-Tab, where a multi-window future will want
 * it anyway.
 *
 * Pure and shared so the renderer can build the string, main can fall back to
 * {@link APP_TITLE} without duplicating it, and tests need no Electron.
 */

/** The subset of `HostEntry` a title needs. Structural, so callers can pass
 * a full `HostEntry` or a literal. */
export interface TitleHost {
  /** Friendly name from the `Host` directive, or a generated one. */
  name: string;
  hostname: string;
  /** May be empty — ~/.ssh/config entries without `User` parse to ''. */
  user?: string | null;
}

export const APP_TITLE = 'PocketShell';

/**
 * `hetzner · alexey@135.181.114.209 — PocketShell`, degrading gracefully:
 *
 *   - no host (the picker, or after disconnect) -> `PocketShell`
 *   - no user                                   -> `hetzner · 135.181.114.209 — PocketShell`
 *   - name IS the address (a generated name for a host entered by IP)
 *                                               -> `alexey@135.181.114.209 — PocketShell`
 *
 * The app name trails, em-dash separated, per the platform convention
 * ("Document — App"): when the taskbar truncates, the half that survives is
 * the half that tells two PocketShell windows apart.
 */
export function windowTitle(host: TitleHost | null | undefined): string {
  if (!host) return APP_TITLE;
  const endpoint = host.user ? `${host.user}@${host.hostname}` : host.hostname;
  const name = host.name.trim();
  // A host with no friendly name is "named" by its own address; rendering
  // `1.2.3.4 · user@1.2.3.4` would say the address twice.
  if (!name || name === host.hostname || name === endpoint) {
    return `${endpoint} — ${APP_TITLE}`;
  }
  return `${name} · ${endpoint} — ${APP_TITLE}`;
}
