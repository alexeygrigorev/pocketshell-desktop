/**
 * Directory-derived tmux session naming.
 *
 * A faithful port of the Android app's
 * `app/src/main/java/com/pocketshell/app/projects/SessionNameDerivation.kt`
 * (`baseName` at :100, `sanitisePart` at :149, `resolveSessionName` at :74).
 * Both apps must name the same folder the same way, because the session name
 * IS the folder identity on the host — `tmuxctl` uses the same convention, so
 * a session created from the phone and one created from the desktop in
 * `~/git/pocketshell` are the same session, not two.
 *
 * The convention:
 *
 *  - the directory IS `$HOME`            -> `home-<homeBasename>`  (`/home/alexey` -> `home-alexey`)
 *  - the directory is UNDER `$HOME`      -> home-relative components joined by `-`
 *                                          (`~/git/pocketshell` -> `git-pocketshell`)
 *  - anything else (or home unknown)     -> absolute components joined by `-`
 *                                          (`/var/log` -> `var-log`)
 *
 * The name is a pure path prefix: agent and shell sessions in one folder
 * derive the SAME base name. That is deliberate — it is what makes
 * `sessions create` idempotent per folder.
 *
 * This module NEVER decides uniqueness. The Kotlin removed its client-side
 * `-2`/`-3` disambiguation for a reason (a stale UI cache silently requested
 * names that were already taken); the host answers "is this name free?" at
 * create time. See `freeSessionNameCommand` in ./commands.ts.
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

/** Sanitise a whole user-entered label (trimmed, then per-component rules). */
export function sanitiseName(name: string): string {
  return sanitisePart(name.trim());
}

function splitPathParts(path: string): string[] {
  return path.split('/').filter((p) => p.length > 0 && p !== '.');
}

function joinParts(parts: string[]): string {
  return parts
    .map(sanitisePart)
    .filter((p) => p.length > 0)
    .join('-');
}

/** Drop a trailing `/` (but never turn `/` itself into the empty string twice). */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * The directory-derived base name — the port of `SessionNameDerivation.baseName`.
 *
 * @param startDirectory the folder the session will start in. May be absolute,
 *   `~`, or `~/...`; a `~` form is resolved against [homeDirectory] so the same
 *   folder yields the same name whichever form the caller passed.
 * @param homeDirectory the remote `$HOME`, or null when it could not be resolved.
 */
export function sessionBaseName(startDirectory: string, homeDirectory: string | null): string {
  const trimmedHome = trimTrailingSlash((homeDirectory ?? '').trim());
  const home = trimmedHome.length > 0 ? trimmedHome : null;
  const raw = trimTrailingSlash(startDirectory.trim());

  let resolved: string;
  if (raw.length === 0) resolved = home ?? '';
  else if (raw === '~') resolved = home ?? raw;
  else if (raw.startsWith('~/')) resolved = home !== null ? `${home}/${raw.slice(2)}` : raw;
  else resolved = raw;

  // The directory IS $HOME.
  if (home !== null && resolved === home) {
    const homeTail = home.slice(home.lastIndexOf('/') + 1) || 'home';
    return joinParts(['home', homeTail]);
  }

  // The directory is UNDER $HOME.
  if (home !== null && resolved.startsWith(`${home}/`)) {
    return joinParts(splitPathParts(resolved.slice(home.length + 1))) || 'shell';
  }

  // Unresolved `~` form with no known home: best effort.
  if (resolved === '~') return 'home';
  if (resolved.startsWith('~/')) {
    return joinParts(splitPathParts(resolved.slice(2))) || 'shell';
  }

  return joinParts(splitPathParts(resolved)) || 'shell';
}

/**
 * The final BASE name for a new session, honouring an optional user label.
 *
 * A label that sanitises to something with at least one letter or digit wins;
 * anything else (blank, whitespace, `...`, `:::`) falls back to the
 * directory-derived name. Port of `SessionNameDerivation.resolveSessionName`.
 *
 * Still just the base: no `-2` suffix is appended here.
 */
export function resolveSessionName(
  customName: string | null | undefined,
  startDirectory: string,
  homeDirectory: string | null,
): string {
  if (customName != null) {
    const custom = sanitiseName(customName);
    if (/[A-Za-z0-9]/.test(custom)) return custom;
  }
  return sessionBaseName(startDirectory, homeDirectory) || 'shell';
}

/**
 * Validate a new-folder name typed by the user — port of
 * `FolderListGateway.normaliseProjectFolderName` (FolderListGateway.kt:2059).
 *
 * Returns the cleaned name, or null when it cannot be a single folder under
 * the chosen parent. Rejecting `/` and `\` here is what keeps "create a new
 * empty folder" from silently creating a nested tree (or escaping the parent
 * via `..`); it is a usability rule, not the security boundary — the shell
 * quoting in ./commands.ts is that.
 */
export function normaliseProjectFolderName(value: string): string | null {
  const trimmed = value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed.length === 0) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

/** Join a parent directory and a child name into a remote path. */
export function childPath(parentPath: string, childName: string): string {
  const parent = trimTrailingSlash(parentPath.trim());
  return parent.length === 0 || parent === '/' ? `/${childName}` : `${parent}/${childName}`;
}
