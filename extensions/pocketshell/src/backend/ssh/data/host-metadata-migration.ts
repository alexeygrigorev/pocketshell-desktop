/**
 * One-time migration from the legacy `hosts` table (which duplicated
 * connection details) to the new `host_metadata` table keyed by stable alias
 * identity.
 *
 * With `~/.ssh/config` as the single source of truth, connection details are
 * no longer stored. This migration preserves the PocketShell-specific data a
 * user has accumulated (enabled flag, bootstrap cache, agent profiles,
 * port-forwarding defaults, last-connected timestamp) by matching each legacy
 * row to an alias in the live config on hostname+port+user, then writing a
 * metadata row keyed by that alias.
 *
 * Legacy rows whose connection details no longer match any SSH config entry
 * are reported (not silently dropped) so the user can re-add the stanza or
 * discard them deliberately. Because migration runs on every activation and
 * unmatched rows are never deleted (we don't own the legacy table from here),
 * each unmatched row is marked "seen" in the metadata store so it is surfaced
 * at most ONCE — not re-reported on every launch.
 */

import type { SshConfigHost } from './ssh-config-parser';
import type { Host } from './host-store';
import type { HostMetadata, HostMetadataPatch, HostMetadataStore } from './host-metadata-store';
import {
  collectConcreteAliases,
  getHostSkipReason,
  hostIdentityForAlias,
  resolveHostForAlias,
} from './ssh-host-resolver';

export interface MigrationMatched {
  /** Legacy numeric id (for reporting only). */
  legacyId: number;
  legacyName: string;
  alias: string;
  identity: string;
}

export interface MigrationUnmatched {
  legacyId: number;
  legacyName: string;
  hostname: string;
  port: number;
  username: string;
  reason: string;
}

export interface MigrationResult {
  matched: MigrationMatched[];
  unmatched: MigrationUnmatched[];
}

/** Options for {@link migrateLegacyHosts}. */
export interface MigrationOptions {
  /** Whether to delete legacy rows after a successful migration. Default true. */
  deleteLegacy?: boolean;
  defaultUsername?: string;
}

/**
 * Build a map from "hostname|port|user" (lowercased) to alias for every
 * concrete, usable alias in the live config. Used to match legacy rows back
 * to their alias.
 */
export function buildConnectionToAliasMap(
  parsedHosts: SshConfigHost[],
  options: { defaultUsername?: string } = {},
): Map<string, string> {
  const map = new Map<string, string>();
  const { aliases } = collectConcreteAliases(parsedHosts);
  for (const { alias, source } of aliases) {
    const resolved = resolveHostForAlias(alias, parsedHosts, source);
    if (getHostSkipReason(alias, resolved, options)) {
      continue;
    }
    const hostname = (resolved.hostname || alias).toLowerCase();
    const port = resolved.port ?? 22;
    const user = (resolved.user || options.defaultUsername || '').toLowerCase();
    map.set(connectionKey(hostname, port, user), alias);
  }
  return map;
}

function connectionKey(hostname: string, port: number, user: string): string {
  return `${hostname}|${port}|${user}`;
}

/**
 * Stable identity for a legacy row used to remember that we've already
 * reported it as unmatched. This is the same `hostname|port|user` (lowercased)
 * key used for matching, so a row that later gains a matching config stanza
 * simply migrates normally — the seen marker is inert in that path.
 */
export function unmatchedSeenKey(hostname: string, port: number, user: string): string {
  return connectionKey(hostname.toLowerCase(), port, user.toLowerCase());
}

/**
 * Migrate legacy `hosts` rows into the metadata store.
 *
 * Matched rows are upserted (keyed by alias identity) and, when
 * `options.deleteLegacy` is true, deleted from the legacy table — idempotent
 * across re-runs. Unmatched rows are reported via the returned `unmatched`
 * list, but each distinct row (by hostname|port|user) is surfaced at most ONCE
 * across activations: the metadata store remembers which unmatched keys have
 * already been reported, so subsequent launches stay quiet without silently
 * dropping data. A row that later gains a matching config stanza migrates
 * normally regardless of any prior seen marker.
 *
 * @param legacyHosts rows from the old table (read by the caller).
 * @param parsedHosts live parse of ~/.ssh/config.
 * @param store metadata store to write into (also persists the seen set).
 * @param deleteLegacy callback invoked once per matched legacy id when
 *   `options.deleteLegacy` is true (the caller owns the legacy table).
 */
export function migrateLegacyHosts(
  legacyHosts: Host[],
  parsedHosts: SshConfigHost[],
  store: HostMetadataStore,
  deleteLegacy: (legacyId: number) => void,
  options: MigrationOptions = {},
): MigrationResult {
  const deleteLegacyRows = options.deleteLegacy ?? true;
  const aliasByConnection = buildConnectionToAliasMap(parsedHosts, {
    defaultUsername: options.defaultUsername,
  });
  const usedAliases = new Set<string>();

  const matched: MigrationMatched[] = [];
  const unmatched: MigrationUnmatched[] = [];

  for (const legacy of legacyHosts) {
    const hostname = (legacy.hostname || '').toLowerCase();
    const user = (legacy.username || '').toLowerCase();
    const key = connectionKey(hostname, legacy.port, user);
    const alias = aliasByConnection.get(key);

    if (!alias) {
      // Surface at most once: if we've already reported this unmatched row
      // on a previous activation, suppress it now (no silent drop on first
      // encounter, no noise on later launches).
      const seenKey = unmatchedSeenKey(legacy.hostname || '', legacy.port, legacy.username || '');
      if (store.isMigrationSeen(seenKey)) {
        continue;
      }
      unmatched.push({
        legacyId: legacy.id,
        legacyName: legacy.name,
        hostname: legacy.hostname,
        port: legacy.port,
        username: legacy.username,
        reason:
          'no matching Host entry in ~/.ssh/config (add a Host stanza with this hostname/port/user to keep its PocketShell metadata)',
      });
      store.markMigrationSeen(seenKey);
      continue;
    }

    // If two legacy rows map to the same alias, keep the first and report the
    // rest as unmatched so no data is silently lost. These collisions are also
    // marked seen so they don't recur on every launch.
    if (usedAliases.has(alias)) {
      const seenKey = unmatchedSeenKey(legacy.hostname || '', legacy.port, legacy.username || '');
      if (store.isMigrationSeen(seenKey)) {
        continue;
      }
      unmatched.push({
        legacyId: legacy.id,
        legacyName: legacy.name,
        hostname: legacy.hostname,
        port: legacy.port,
        username: legacy.username,
        reason: `another legacy row already migrated to alias "${alias}"`,
      });
      store.markMigrationSeen(seenKey);
      continue;
    }
    usedAliases.add(alias);

    const identity = hostIdentityForAlias(alias);
    const patch = legacyToPatch(legacy, alias);
    store.upsert(identity, alias, patch);
    matched.push({ legacyId: legacy.id, legacyName: legacy.name, alias, identity });

    if (deleteLegacyRows) {
      deleteLegacy(legacy.id);
    }
  }

  return { matched, unmatched };
}

/** Map a legacy Host row onto a metadata patch. */
export function legacyToPatch(legacy: Host, alias: string): HostMetadataPatch & {
  alias: string;
  createdAt: number;
} {
  return {
    alias,
    maxAutoPort: legacy.maxAutoPort,
    skipPortsBelow: legacy.skipPortsBelow,
    scanIntervalSec: legacy.scanIntervalSec,
    enabled: legacy.enabled,
    createdAt: legacy.createdAt,
    lastConnectedAt: legacy.lastConnectedAt,
    tmuxInstalled: legacy.tmuxInstalled,
    lastBootstrapAt: legacy.lastBootstrapAt,
    pocketshellInstalled: legacy.pocketshellInstalled,
    pocketshellLastDetectedAt: legacy.pocketshellLastDetectedAt,
    pocketshellCliVersion: legacy.pocketshellCliVersion,
    pocketshellExpectedCliVersion: legacy.pocketshellExpectedCliVersion,
    pocketshellVersionCompatible: legacy.pocketshellVersionCompatible,
    pocketshellDaemonRunning: legacy.pocketshellDaemonRunning,
    pocketshellDaemonEnabled: legacy.pocketshellDaemonEnabled,
    usageCommandOverride: legacy.usageCommandOverride,
    claudeProfilesJson: legacy.claudeProfilesJson,
    codexProfilesJson: legacy.codexProfilesJson,
  };
}

/** Read-only helper: does the given metadata row carry any real PocketShell state? */
export function metadataHasState(m: HostMetadata): boolean {
  return (
    m.lastConnectedAt !== null ||
    m.tmuxInstalled !== null ||
    m.lastBootstrapAt !== null ||
    m.pocketshellInstalled !== null ||
    m.pocketshellLastDetectedAt !== null ||
    m.pocketshellCliVersion !== null ||
    m.pocketshellExpectedCliVersion !== null ||
    m.pocketshellVersionCompatible !== null ||
    m.pocketshellDaemonRunning !== null ||
    m.pocketshellDaemonEnabled !== null ||
    m.usageCommandOverride !== null ||
    m.claudeProfilesJson !== null ||
    m.codexProfilesJson !== null ||
    !m.enabled
  );
}
