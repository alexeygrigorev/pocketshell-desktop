/**
 * Pure startup-connection decider for PocketShell Desktop.
 *
 * Given the current auto-connect settings, the last-connected host id, and
 * the live host list, returns the action the shell-rework "on start" flow
 * should perform:
 *
 *   - 'connect' — auto-connect is on AND the last host is still present.
 *   - 'pick'    — there are hosts, but the connect precondition isn't met, so
 *                 the user should pick one (auto-connect off, no last host,
 *                 or the last host is gone).
 *   - 'noop'    — there is nothing to connect to or pick from (no hosts).
 *
 * This module is PURE: it has no vscode / node / disk dependencies and is
 * mirrored byte-identical at
 * `extensions/pocketshell/src/backend/startup/decision.ts`. The vscode-aware
 * execution lives in the feature layer.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal host shape the decider needs.
 *
 * Deliberately a structural subset of the extension's `Host` type so this pure
 * module does not import the (vscode-adjacent) data-store layer and can be
 * mirrored byte-identically. Any `Host` is assignable to `StartupHost`.
 */
export interface StartupHost {
  id: number;
  /** Display label (the host alias, or hostname if unset). */
  name: string;
  hostname: string;
  username: string;
  port: number;
}

/** Inputs to {@link decideStartupAction}. */
export interface StartupDecisionInput {
  /** Whether auto-connect to the last host is enabled. */
  autoConnect: boolean;
  /**
   * Id of the most recently connected host, or null. This is a hint, not
   * authoritative — the host may have been removed from the config.
   */
  lastHostId: number | null;
  /** The current live host list (e.g. `connectionService.getHosts()`). */
  hosts: StartupHost[];
}

/** Discriminated action returned by {@link decideStartupAction}. */
export type StartupAction =
  | { kind: 'connect'; hostId: number }
  | { kind: 'pick'; hosts: StartupHost[] }
  | { kind: 'noop' };

// ---------------------------------------------------------------------------
// Decider
// ---------------------------------------------------------------------------

/**
 * Decide what the startup connection flow should do.
 *
 * Precedence (first match wins):
 *
 *   1. No usable hosts at all → `noop`.
 *   2. autoConnect is on AND lastHostId is non-null AND a host with that id
 *      is still in `hosts` → `connect` (target = lastHostId).
 *   3. Otherwise (auto-connect off, lastHostId null, or lastHostId stale) but
 *      hosts exist → `pick`.
 *
 * Edge cases handled explicitly:
 *   - lastHostId present but its host gone → `pick` (stale hint falls through).
 *   - autoConnect false with hosts present → `pick`.
 *   - lastHostId null with hosts present → `pick`.
 *   - zero hosts → `noop` (regardless of autoConnect / lastHostId).
 */
export function decideStartupAction(input: StartupDecisionInput): StartupAction {
  const { autoConnect, lastHostId, hosts } = input;

  // 1. Nothing to connect to or pick from.
  if (hosts.length === 0) {
    return { kind: 'noop' };
  }

  // 2. Auto-connect to the last host, but only if it is still around.
  if (autoConnect && lastHostId !== null) {
    const stillPresent = hosts.some((host) => host.id === lastHostId);
    if (stillPresent) {
      return { kind: 'connect', hostId: lastHostId };
    }
    // lastHostId is stale — fall through to 'pick'.
  }

  // 3. Hosts exist but the connect precondition wasn't met.
  return { kind: 'pick', hosts };
}
