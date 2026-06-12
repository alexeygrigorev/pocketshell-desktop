/**
 * SSH config file parser for PocketShell Desktop.
 *
 * Parses `~/.ssh/config` and returns structured host entries.
 * Used for the "Import from SSH config" feature.
 *
 * Supports the standard OpenSSH config format:
 *   Host <pattern>
 *     HostName <value>
 *     Port <value>
 *     User <value>
 *     IdentityFile <value>
 *     ...
 *
 * Handles:
 * - Multiple Host blocks
 * - Quoted values
 * - = separator (Host = name)
 * - Comments (# and empty lines)
 * - Pattern-based hosts (wildcards)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single parsed Host block from an SSH config file. */
export interface SshConfigHost {
  /** The Host pattern (may include wildcards like `*`). */
  host: string;

  /** Resolved hostname or IP. May be absent if only a Host alias is used. */
  hostname?: string;

  /** SSH port. Default is 22 if not specified. */
  port?: number;

  /** Remote username. */
  user?: string;

  /** Path to the identity (private key) file. */
  identityFile?: string;

  /** ProxyCommand, if set. */
  proxyCommand?: string;

  /** ProxyJump, if set. */
  proxyJump?: string;

  /** StrictHostKeyChecking value. */
  strictHostKeyChecking?: string;

  /** UserKnownHostsFile value. */
  userKnownHostsFile?: string;

  /** Any unrecognized directives, stored as key-value pairs. */
  extra: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const KNOWN_DIRECTIVES = new Set([
  'host',
  'hostname',
  'port',
  'user',
  'identityfile',
  'proxycommand',
  'proxyjump',
  'stricthostkeychecking',
  'userknownhostsfile',
]);

/**
 * Parse an SSH config file and return an array of host entries.
 *
 * @param configPath - Path to the SSH config file.
 *   Defaults to `~/.ssh/config`.
 * @returns Array of parsed `SshConfigHost` objects.
 * @throws If the config file cannot be read.
 */
export function parseSshConfig(configPath?: string): SshConfigHost[] {
  const resolvedPath =
    configPath ?? path.join(os.homedir(), '.ssh', 'config');

  if (!fs.existsSync(resolvedPath)) {
    return [];
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  return parseSshConfigString(content);
}

/**
 * Parse an SSH config string and return an array of host entries.
 * Useful for testing with fixture strings.
 */
export function parseSshConfigString(content: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  let current: SshConfigHost | null = null;

  for (const rawLine of content.split('\n')) {
    // Strip comments
    const commentIdx = rawLine.indexOf('#');
    const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim();

    if (line.length === 0) continue;

    // Parse directive: "Keyword value" or "Keyword=value" or "Keyword = value"
    const parsed = parseDirective(line);
    if (!parsed) continue;

    const { keyword, value } = parsed;

    if (keyword === 'host') {
      // Flush previous host block
      if (current) {
        hosts.push(current);
      }
      current = { host: value, extra: {} };
      continue;
    }

    // Ignore directives outside of a Host block
    if (!current) continue;

    switch (keyword) {
      case 'hostname':
        current.hostname = value;
        break;
      case 'port':
        current.port = parseInt(value, 10);
        if (isNaN(current.port)) current.port = undefined;
        break;
      case 'user':
        current.user = value;
        break;
      case 'identityfile':
        // Resolve ~ to home directory
        current.identityFile = expandPath(value);
        break;
      case 'proxycommand':
        current.proxyCommand = value;
        break;
      case 'proxyjump':
        current.proxyJump = value;
        break;
      case 'stricthostkeychecking':
        current.strictHostKeyChecking = value;
        break;
      case 'userknownhostsfile':
        current.userKnownHostsFile = value;
        break;
      default:
        current.extra[keyword] = value;
        break;
    }
  }

  // Flush last host block
  if (current) {
    hosts.push(current);
  }

  return hosts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a single config directive line.
 *
 * Handles:
 * - `Keyword value`
 * - `Keyword=value`
 * - `Keyword = value`
 * - Quoted values: `Keyword "value with spaces"`
 */
function parseDirective(line: string): { keyword: string; value: string } | null {
  // Try "=" form first
  const eqIdx = line.indexOf('=');
  if (eqIdx > 0) {
    const keyword = line.slice(0, eqIdx).trim().toLowerCase();
    const value = unquote(line.slice(eqIdx + 1).trim());
    if (keyword && value) return { keyword, value };
  }

  // Space-separated form
  const spaceIdx = line.search(/\s/);
  if (spaceIdx <= 0) return null;

  const keyword = line.slice(0, spaceIdx).trim().toLowerCase();
  const rawValue = line.slice(spaceIdx + 1).trim();
  const value = unquote(rawValue);

  if (keyword && value) return { keyword, value };
  return null;
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

function expandPath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Filter parsed hosts to only concrete (non-wildcard) entries.
 * Useful when offering hosts for import — wildcard patterns
 * like `Host *` are not useful as individual connections.
 */
export function filterConcreteHosts(hosts: SshConfigHost[]): SshConfigHost[] {
  return hosts.filter((h) => !h.host.includes('*') && !h.host.includes('?'));
}
