/**
 * Live SSH-config host resolver for PocketShell Desktop.
 *
 * `~/.ssh/config` is the SINGLE SOURCE OF TRUTH for the host list and for
 * connection details (hostname, port, user, identity file). This module turns
 * a live parse of the config into the `Host[]` shape that the rest of the
 * extension consumes, merging in any PocketShell-specific metadata stored
 * alongside (port-forwarding defaults, enabled flag, bootstrap cache, agent
 * profiles).
 *
 * There is no import/copy step: every call re-reads the resolved hosts from the
 * config entries. Hosts that cannot be used (wildcards, missing identity file,
 * ProxyJump, etc.) are reported via {@link getHostSkipReason} so the UI can
 * explain why an entry is not offered.
 */

import * as os from 'os';
import * as path from 'path';
import type { SshConfigHost } from './ssh-config-parser';
import type { Host } from './host-store';
import type { HostMetadata } from './host-metadata-store';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Build the stable string identity for a host.
 *
 * Prefers the SSH `Host` alias (the concrete, non-wildcard pattern). When no
 * alias is available, falls back to a normalized `hostname|port|user` key so
 * the same physical host keeps its metadata across restarts.
 */
export function hostIdentityForAlias(alias: string): string {
  return `alias:${alias}`;
}

export function hostIdentityForConnection(hostname: string, port: number, user: string): string {
  return `conn:${hostname.toLowerCase()}|${port}|${user}`;
}

/**
 * Derive a connection identity from a parsed (resolved) SSH config entry.
 * Used when an entry has no usable alias.
 */
export function hostIdentityFromResolved(resolved: SshConfigHost, defaultUsername: string): string {
  const hostname = resolved.hostname || resolved.host;
  const port = resolved.port ?? 22;
  const user = resolved.user || defaultUsername;
  return hostIdentityForConnection(hostname, port, user);
}

/**
 * Deterministic, stable positive integer id for a host identity string.
 *
 * ConnectionManager keys active connections by numeric hostId, so the id must
 * be stable across restarts and refreshes for the same alias. We derive it
 * from a 30-bit FNV-1a hash of the identity so it stays a safe positive int
 * and is collision-resistant for realistic host counts.
 */
export function stableHostId(identity: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i);
    // hash * 16777619, keep within 32 bits
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  // Mask to 30 bits to guarantee a positive 32-bit signed int.
  return (hash & 0x3fffffff) || 1;
}

// ---------------------------------------------------------------------------
// Resolution (OpenSSH first-value-wins semantics)
// ---------------------------------------------------------------------------

/**
 * Resolve all effective values for a concrete alias by walking every Host
 * block whose pattern matches the alias, using OpenSSH "first-value-wins"
 * semantics for scalars and accumulating IdentityFiles.
 */
export function resolveHostForAlias(
  alias: string,
  parsedHosts: SshConfigHost[],
  source: SshConfigHost,
): SshConfigHost {
  const resolved: SshConfigHost = {
    host: source.host,
    patterns: source.patterns,
    extra: {},
  };

  for (const parsed of parsedHosts) {
    if (!hostBlockMatchesAlias(parsed, alias)) {
      continue;
    }

    resolved.hostname = resolved.hostname ?? parsed.hostname;
    resolved.user = resolved.user ?? parsed.user;
    resolved.proxyCommand = resolved.proxyCommand ?? parsed.proxyCommand;
    resolved.proxyJump = resolved.proxyJump ?? parsed.proxyJump;
    resolved.strictHostKeyChecking =
      resolved.strictHostKeyChecking ?? parsed.strictHostKeyChecking;
    resolved.userKnownHostsFile = resolved.userKnownHostsFile ?? parsed.userKnownHostsFile;

    if (resolved.port === undefined && resolved.invalidPort === undefined) {
      resolved.port = parsed.port;
      resolved.invalidPort = parsed.invalidPort;
    }

    if (parsed.identityFiles) {
      resolved.identityFiles = [...(resolved.identityFiles ?? []), ...parsed.identityFiles];
      resolved.identityFile = resolved.identityFile ?? parsed.identityFiles[0];
    }

    for (const [key, value] of Object.entries(parsed.extra)) {
      resolved.extra[key] = resolved.extra[key] ?? value;
    }
  }

  return resolved;
}

/**
 * Enumerate concrete (non-wildcard) aliases from the parsed config, in config
 * order, de-duplicated. Wildcard patterns are returned separately so callers
 * can report them.
 */
export function collectConcreteAliases(
  parsedHosts: SshConfigHost[],
): { aliases: { alias: string; source: SshConfigHost }[]; wildcards: SshConfigHost[] } {
  const aliases: { alias: string; source: SshConfigHost }[] = [];
  const wildcards: SshConfigHost[] = [];
  const seen = new Set<string>();

  for (const parsed of parsedHosts) {
    const patterns =
      parsed.patterns && parsed.patterns.length > 0 ? parsed.patterns : [parsed.host];
    let emittedConcrete = false;
    for (const pattern of patterns) {
      if (hasWildcard(pattern)) {
        continue;
      }
      const key = nameKey(pattern);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      aliases.push({ alias: pattern, source: parsed });
      emittedConcrete = true;
    }
    if (!emittedConcrete && patterns.every(p => hasWildcard(p))) {
      wildcards.push(parsed);
    }
  }

  return { aliases, wildcards };
}

// ---------------------------------------------------------------------------
// Usability / skip reason
// ---------------------------------------------------------------------------

/** Options for {@link getHostSkipReason}. */
export interface SkipReasonOptions {
  defaultUsername?: string;
}

/**
 * Return a human-readable reason a resolved SSH config entry cannot be used as
 * a PocketShell host, or `undefined` if it is usable.
 *
 * Usable hosts require: a concrete (non-wildcard) alias, exactly one
 * IdentityFile that is not `none` and has no OpenSSH percent tokens, a valid
 * Port, a User (or a resolvable local default), and no ProxyJump/ProxyCommand.
 */
export function getHostSkipReason(
  alias: string,
  resolved: SshConfigHost,
  options: SkipReasonOptions = {},
): string | undefined {
  const defaultUsername = options.defaultUsername ?? safeDefaultUsername();
  if (hasWildcard(alias)) {
    return 'wildcard Host patterns are not usable as concrete PocketShell hosts';
  }
  if (!resolved.identityFile) {
    return 'IdentityFile is required because PocketShell currently supports key-based SSH hosts only';
  }
  if (resolved.identityFile.toLowerCase() === 'none') {
    return 'IdentityFile none disables key authentication and cannot be used as a key-based PocketShell host';
  }
  if ((resolved.identityFiles?.length ?? 0) > 1) {
    return 'multiple IdentityFile directives are not supported by the current PocketShell host model';
  }
  if (resolved.invalidPort) {
    return `Port is invalid (${resolved.invalidPort})`;
  }
  if (hasToken(resolved.identityFile)) {
    return 'IdentityFile contains OpenSSH percent tokens that PocketShell cannot resolve safely';
  }
  if (!resolved.user && !defaultUsername) {
    return 'User is missing and the local default username could not be resolved';
  }
  if (resolved.proxyJump) {
    return `ProxyJump is not supported by the current PocketShell connection path (${resolved.proxyJump})`;
  }
  if (resolved.proxyCommand) {
    return `ProxyCommand is not supported by the current PocketShell connection path (${resolved.proxyCommand})`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Live host list
// ---------------------------------------------------------------------------

/** A host that is usable, with its resolved connection details. */
export interface ResolvedHost {
  host: Host;
  identity: string;
  alias: string;
}

/** A host entry from the config that is not usable, with the reason. */
export interface SkippedHost {
  alias: string;
  reason: string;
}

/** Options for {@link resolveHostsFromConfig}. */
export interface ResolveHostsOptions {
  defaultUsername?: string;
  /** Identity string -> metadata, used to merge in PocketShell-specific data. */
  metadata?: Map<string, HostMetadata>;
}

/** Result of a live resolve. */
export interface ResolvedHostList {
  hosts: ResolvedHost[];
  skipped: SkippedHost[];
}

/**
 * Default PocketShell port-forwarding metadata used when no stored metadata
 * exists for a host.
 */
export const DEFAULT_HOST_METADATA = {
  maxAutoPort: 10000,
  skipPortsBelow: 1000,
  scanIntervalSec: 5,
  enabled: true,
} as const;

/**
 * Turn a live parse of `~/.ssh/config` into the `Host[]` the extension uses.
 *
 * For each concrete, usable alias this builds a `Host` whose connection
 * details come straight from the resolved config entry, whose `id` is a stable
 * hash of the alias, and whose PocketShell metadata fields are merged in from
 * `options.metadata` (falling back to defaults). No data is copied into a
 * separate store: the config is the source of truth and is re-read each call.
 */
export function resolveHostsFromConfig(
  parsedHosts: SshConfigHost[],
  options: ResolveHostsOptions = {},
): ResolvedHostList {
  const defaultUsername = options.defaultUsername ?? safeDefaultUsername();
  const metadata = options.metadata ?? new Map<string, HostMetadata>();
  const { aliases, wildcards } = collectConcreteAliases(parsedHosts);

  const hosts: ResolvedHost[] = [];
  const skipped: SkippedHost[] = [];
  const seenIds = new Set<number>();

  for (const wildcard of wildcards) {
    const patterns =
      wildcard.patterns && wildcard.patterns.length > 0 ? wildcard.patterns : [wildcard.host];
    for (const pattern of patterns) {
      if (hasWildcard(pattern)) {
        skipped.push({
          alias: pattern,
          reason: 'wildcard Host patterns are not usable as concrete PocketShell hosts',
        });
      }
    }
  }

  for (const { alias, source } of aliases) {
    const resolved = resolveHostForAlias(alias, parsedHosts, source);
    const skipReason = getHostSkipReason(alias, resolved, { defaultUsername });
    if (skipReason) {
      skipped.push({ alias, reason: skipReason });
      continue;
    }

    const identity = hostIdentityForAlias(alias);
    const id = stableHostId(hostIdentityForAlias(alias));
    if (seenIds.has(id)) {
      // Same alias normalized twice — skip the duplicate.
      continue;
    }
    seenIds.add(id);

    const stored = metadata.get(identity);
    const hostname = resolved.hostname || alias;
    const port = resolved.port ?? 22;
    const username = resolved.user || defaultUsername;
    const keyPath = resolved.identityFile!;

    const host: Host = {
      id,
      name: alias,
      hostname,
      port,
      username,
      keyPath,
      maxAutoPort: stored?.maxAutoPort ?? DEFAULT_HOST_METADATA.maxAutoPort,
      skipPortsBelow: stored?.skipPortsBelow ?? DEFAULT_HOST_METADATA.skipPortsBelow,
      scanIntervalSec: stored?.scanIntervalSec ?? DEFAULT_HOST_METADATA.scanIntervalSec,
      enabled: stored?.enabled ?? DEFAULT_HOST_METADATA.enabled,
      createdAt: stored?.createdAt ?? 0,
      lastConnectedAt: stored?.lastConnectedAt ?? null,
      tmuxInstalled: stored?.tmuxInstalled ?? null,
      lastBootstrapAt: stored?.lastBootstrapAt ?? null,
      pocketshellInstalled: stored?.pocketshellInstalled ?? null,
      pocketshellLastDetectedAt: stored?.pocketshellLastDetectedAt ?? null,
      pocketshellCliVersion: stored?.pocketshellCliVersion ?? null,
      pocketshellExpectedCliVersion: stored?.pocketshellExpectedCliVersion ?? null,
      pocketshellVersionCompatible: stored?.pocketshellVersionCompatible ?? null,
      pocketshellDaemonRunning: stored?.pocketshellDaemonRunning ?? null,
      pocketshellDaemonEnabled: stored?.pocketshellDaemonEnabled ?? null,
      usageCommandOverride: stored?.usageCommandOverride ?? null,
      claudeProfilesJson: stored?.claudeProfilesJson ?? null,
      codexProfilesJson: stored?.codexProfilesJson ?? null,
    };

    hosts.push({ host, identity, alias });
  }

  return { hosts, skipped };
}

/**
 * Resolve a single alias to a connection-ready `Host`, or throw with a
 * helpful message if the alias is absent or unusable. Used at connect time to
 * guarantee connection details come from the live config.
 */
export function resolveHostForConnection(
  alias: string,
  parsedHosts: SshConfigHost[],
  options: ResolveHostsOptions = {},
): Host {
  const defaultUsername = options.defaultUsername ?? safeDefaultUsername();
  const source = parsedHosts.find(p => hostBlockMatchesAlias(p, alias));
  if (!source) {
    throw new Error(`Host "${alias}" is not present in ~/.ssh/config`);
  }
  const resolved = resolveHostForAlias(alias, parsedHosts, source);
  const skipReason = getHostSkipReason(alias, resolved, { defaultUsername });
  if (skipReason) {
    throw new Error(`Host "${alias}" cannot be used: ${skipReason}`);
  }

  const identity = hostIdentityForAlias(alias);
  const stored = options.metadata?.get(identity);
  const hostname = resolved.hostname || alias;
  const port = resolved.port ?? 22;
  const username = resolved.user || defaultUsername;
  const keyPath = resolved.identityFile!;

  return {
    id: stableHostId(hostIdentityForAlias(alias)),
    name: alias,
    hostname,
    port,
    username,
    keyPath,
    maxAutoPort: stored?.maxAutoPort ?? DEFAULT_HOST_METADATA.maxAutoPort,
    skipPortsBelow: stored?.skipPortsBelow ?? DEFAULT_HOST_METADATA.skipPortsBelow,
    scanIntervalSec: stored?.scanIntervalSec ?? DEFAULT_HOST_METADATA.scanIntervalSec,
    enabled: stored?.enabled ?? DEFAULT_HOST_METADATA.enabled,
    createdAt: stored?.createdAt ?? 0,
    lastConnectedAt: stored?.lastConnectedAt ?? null,
    tmuxInstalled: stored?.tmuxInstalled ?? null,
    lastBootstrapAt: stored?.lastBootstrapAt ?? null,
    pocketshellInstalled: stored?.pocketshellInstalled ?? null,
    pocketshellLastDetectedAt: stored?.pocketshellLastDetectedAt ?? null,
    pocketshellCliVersion: stored?.pocketshellCliVersion ?? null,
    pocketshellExpectedCliVersion: stored?.pocketshellExpectedCliVersion ?? null,
    pocketshellVersionCompatible: stored?.pocketshellVersionCompatible ?? null,
    pocketshellDaemonRunning: stored?.pocketshellDaemonRunning ?? null,
    pocketshellDaemonEnabled: stored?.pocketshellDaemonEnabled ?? null,
    usageCommandOverride: stored?.usageCommandOverride ?? null,
    claudeProfilesJson: stored?.claudeProfilesJson ?? null,
    codexProfilesJson: stored?.codexProfilesJson ?? null,
  };
}

/** Stable numeric id for a concrete alias. */
export function stableHostIdFromAlias(alias: string): number {
  return stableHostId(hostIdentityForAlias(alias));
}

// ---------------------------------------------------------------------------
// Helpers (preserved from the former import planner)
// ---------------------------------------------------------------------------

function hasWildcard(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?') || pattern.startsWith('!');
}

function hostBlockMatchesAlias(parsed: SshConfigHost, alias: string): boolean {
  const patterns =
    parsed.patterns && parsed.patterns.length > 0 ? parsed.patterns : [parsed.host];
  if (
    patterns.some(
      pattern => pattern.startsWith('!') && patternMatchesAlias(pattern.slice(1), alias),
    )
  ) {
    return false;
  }
  return patterns.some(
    pattern => !pattern.startsWith('!') && patternMatchesAlias(pattern, alias),
  );
}

function patternMatchesAlias(pattern: string, alias: string): boolean {
  if (hasWildcard(pattern)) {
    const regex = new RegExp(
      `^${escapeRegex(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`,
      'i',
    );
    return regex.test(alias);
  }
  return pattern.toLowerCase() === alias.toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function hasToken(value: string): boolean {
  return /%[A-Za-z%]/.test(value);
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function safeDefaultUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

/** Normalize an IdentityFile path the way the resolver treats it at use time. */
export function normalizeIdentityPath(keyPath: string): string {
  if (keyPath === '~' || keyPath.startsWith('~/')) {
    return path.join(os.homedir(), keyPath.slice(1));
  }
  return path.normalize(keyPath);
}
