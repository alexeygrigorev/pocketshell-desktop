import * as os from 'os';
import * as path from 'path';
import type { SshConfigHost } from './ssh-config-parser';

export interface SshConfigImportHost {
  name: string;
  hostname: string;
  port: number;
  username: string;
  keyPath: string;
  maxAutoPort: number;
  skipPortsBelow: number;
  scanIntervalSec: number;
  enabled: boolean;
}

export type ExistingSshConfigImportHost = Pick<
  SshConfigImportHost,
  'name' | 'hostname' | 'port' | 'username' | 'keyPath'
>;

export interface SshConfigImportCandidate {
  alias: string;
  source: SshConfigHost;
  host: SshConfigImportHost;
  proxyMetadata?: string;
}

export interface SshConfigImportSkipped {
  alias: string;
  source: SshConfigHost;
  reason: string;
  proxyMetadata?: string;
}

export interface SshConfigImportPlan {
  importable: SshConfigImportCandidate[];
  skipped: SshConfigImportSkipped[];
}

export interface SshConfigImportPlanOptions {
  defaultUsername?: string;
}

export function createSshConfigImportPlan(
  parsedHosts: SshConfigHost[],
  existingHosts: ExistingSshConfigImportHost[],
  options: SshConfigImportPlanOptions = {},
): SshConfigImportPlan {
  const defaultUsername = options.defaultUsername ?? safeDefaultUsername();
  const importable: SshConfigImportCandidate[] = [];
  const skipped: SshConfigImportSkipped[] = [];
  const seen = new Set<string>();
  const aliases = collectImportAliases(parsedHosts, skipped);

  for (const { alias, source } of aliases) {
    const resolved = resolveHostForAlias(alias, parsedHosts, source);
    const proxyMetadata = formatProxyMetadata(resolved);
    const skip = getUnsupportedReason(alias, resolved, defaultUsername);
    if (skip) {
      skipped.push({ alias, source: resolved, reason: skip, proxyMetadata });
      continue;
    }

    const planned: SshConfigImportHost = {
      name: alias,
      hostname: resolved.hostname || alias,
      port: resolved.port ?? 22,
      username: resolved.user || defaultUsername,
      keyPath: resolved.identityFile!,
      maxAutoPort: 10000,
      skipPortsBelow: 1000,
      scanIntervalSec: 5,
      enabled: true,
    };

    const duplicateReason = getDuplicateReason(planned, existingHosts, seen);
    if (duplicateReason) {
      skipped.push({ alias, source: resolved, reason: duplicateReason, proxyMetadata });
      continue;
    }

    seen.add(importKey(planned));
    seen.add(nameKey(planned.name));
    importable.push({ alias, source: resolved, host: planned, proxyMetadata });
  }

  return { importable, skipped };
}

function collectImportAliases(
  parsedHosts: SshConfigHost[],
  skipped: SshConfigImportSkipped[],
): { alias: string; source: SshConfigHost }[] {
  const aliases: { alias: string; source: SshConfigHost }[] = [];
  const seen = new Set<string>();

  for (const parsed of parsedHosts) {
    const patterns = parsed.patterns && parsed.patterns.length > 0 ? parsed.patterns : [parsed.host];
    for (const pattern of patterns) {
      if (hasWildcard(pattern)) {
        skipped.push({
          alias: pattern,
          source: parsed,
          reason: 'wildcard Host patterns are not importable as concrete PocketShell hosts',
          proxyMetadata: formatProxyMetadata(parsed),
        });
        continue;
      }
      const key = nameKey(pattern);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      aliases.push({ alias: pattern, source: parsed });
    }
  }

  return aliases;
}

function resolveHostForAlias(
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
    resolved.strictHostKeyChecking = resolved.strictHostKeyChecking ?? parsed.strictHostKeyChecking;
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

function getUnsupportedReason(
  alias: string,
  parsed: SshConfigHost,
  defaultUsername: string,
): string | undefined {
  if (hasWildcard(alias)) {
    return 'wildcard Host patterns are not importable as concrete PocketShell hosts';
  }
  if (!parsed.identityFile) {
    return 'IdentityFile is required because PocketShell currently imports key-based SSH hosts only';
  }
  if (parsed.identityFile.toLowerCase() === 'none') {
    return 'IdentityFile none disables key authentication and cannot be imported as a key-based PocketShell host';
  }
  if ((parsed.identityFiles?.length ?? 0) > 1) {
    return 'multiple IdentityFile directives are not supported by the current PocketShell host model';
  }
  if (parsed.invalidPort) {
    return `Port is invalid (${parsed.invalidPort})`;
  }
  if (hasToken(parsed.identityFile)) {
    return 'IdentityFile contains OpenSSH percent tokens that PocketShell cannot resolve safely';
  }
  if (!parsed.user && !defaultUsername) {
    return 'User is missing and the local default username could not be resolved';
  }
  if (parsed.proxyJump) {
    return `ProxyJump is not supported by the current PocketShell connection path (${parsed.proxyJump})`;
  }
  if (parsed.proxyCommand) {
    return `ProxyCommand is not supported by the current PocketShell connection path (${parsed.proxyCommand})`;
  }
  return undefined;
}

function getDuplicateReason(
  host: Pick<SshConfigImportHost, 'name' | 'hostname' | 'port' | 'username' | 'keyPath'>,
  existingHosts: ExistingSshConfigImportHost[],
  seen: Set<string>,
): string | undefined {
  if (seen.has(importKey(host)) || existingHosts.some(existing => importKey(existing) === importKey(host))) {
    return 'already exists with the same hostname, port, username, and key path';
  }
  if (seen.has(nameKey(host.name)) || existingHosts.some(existing => nameKey(existing.name) === nameKey(host.name))) {
    return 'already exists with the same host name';
  }
  return undefined;
}

function hasWildcard(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?') || pattern.startsWith('!');
}

function hostBlockMatchesAlias(parsed: SshConfigHost, alias: string): boolean {
  const patterns = parsed.patterns && parsed.patterns.length > 0 ? parsed.patterns : [parsed.host];
  if (patterns.some(pattern => pattern.startsWith('!') && patternMatchesAlias(pattern.slice(1), alias))) {
    return false;
  }
  return patterns.some(pattern => !pattern.startsWith('!') && patternMatchesAlias(pattern, alias));
}

function patternMatchesAlias(pattern: string, alias: string): boolean {
  const regex = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`, 'i');
  return regex.test(alias);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function hasToken(value: string): boolean {
  return /%[A-Za-z%]/.test(value);
}

function importKey(host: Pick<SshConfigImportHost, 'hostname' | 'port' | 'username' | 'keyPath'>): string {
  return [
    host.hostname.toLowerCase(),
    String(host.port),
    host.username,
    normalizeKeyPath(host.keyPath),
  ].join('\0');
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeKeyPath(keyPath: string): string {
  if (keyPath === '~' || keyPath.startsWith('~/')) {
    return path.join(os.homedir(), keyPath.slice(1));
  }
  return path.normalize(keyPath);
}

function formatProxyMetadata(parsed: SshConfigHost): string | undefined {
  if (parsed.proxyJump) return `ProxyJump ${parsed.proxyJump}`;
  if (parsed.proxyCommand) return `ProxyCommand ${parsed.proxyCommand}`;
  return undefined;
}

function safeDefaultUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}
