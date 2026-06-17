/**
 * Pure helpers for editing ~/.ssh/config.
 *
 * The config is the single source of truth for hosts, so adding a host or
 * assigning a managed key means editing the config file rather than copying
 * details into a separate store. These helpers are pure (no `vscode`, no
 * filesystem) so they can be unit-tested directly; the connection service
 * wraps them with file I/O.
 */

import type { NewHost } from './host-store';

/** Format a NewHost into an SSH config Host stanza string (trailing newline). */
export function formatHostStanza(host: NewHost): string {
  const lines: string[] = ['', `Host ${host.name || host.hostname}`];
  lines.push(`  HostName ${host.hostname}`);
  lines.push(`  Port ${host.port}`);
  lines.push(`  User ${host.username}`);
  lines.push(`  IdentityFile ${host.keyPath}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Rewrite the IdentityFile directive of the first concrete Host block matching
 * `alias`. Returns the original text unchanged if no matching block exists.
 * If the matched block has no IdentityFile, one is inserted right after the
 * Host line. Exported for testing and reuse.
 */
export function patchIdentityFileForAlias(
  configText: string,
  alias: string,
  keyPath: string,
): string {
  const lines = configText.split('\n');
  let i = 0;
  const aliasLower = alias.toLowerCase();
  while (i < lines.length) {
    const parsed = parseLine(lines[i]);
    if (parsed && parsed.keyword === 'host') {
      const patterns = parsed.value.split(/\s+/).filter(Boolean);
      const matches = patterns.some(
        p =>
          !p.startsWith('!') &&
          !p.includes('*') &&
          !p.includes('?') &&
          p.toLowerCase() === aliasLower,
      );
      if (matches) {
        let identityIndex = -1;
        for (let j = i + 1; j < lines.length; j++) {
          const body = parseLine(lines[j]);
          if (body && body.keyword === 'host') {
            break;
          }
          if (body && body.keyword === 'identityfile' && identityIndex === -1) {
            identityIndex = j;
          }
        }
        if (identityIndex >= 0) {
          const indent = lines[identityIndex].match(/^\s*/)?.[0] ?? '  ';
          lines[identityIndex] = `${indent}IdentityFile ${keyPath}`;
        } else {
          const indent = lines[i].match(/^\s*/)?.[0] ?? '';
          lines.splice(i + 1, 0, `${indent}  IdentityFile ${keyPath}`);
        }
        return lines.join('\n');
      }
    }
    i++;
  }
  return configText;
}

/**
 * Remove the first Host stanza whose Host line is a single pattern equal to
 * `alias` (case-insensitive). Stanzas with multiple patterns, wildcards, or
 * negated patterns are left intact — this is conservative so we never corrupt
 * another host. Returns the original text unchanged when no stanza matches.
 * Exported for testing and reuse.
 */
export function removeHostStanzaForAlias(
  configText: string,
  alias: string,
): string {
  const lines = configText.split('\n');
  const aliasLower = alias.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i]);
    if (!parsed || parsed.keyword !== 'host') {
      continue;
    }
    const patterns = parsed.value.split(/\s+/).filter(Boolean);
    if (patterns.length !== 1) {
      continue;
    }
    const pattern = patterns[0];
    if (
      pattern.startsWith('!') ||
      pattern.includes('*') ||
      pattern.includes('?') ||
      pattern.toLowerCase() !== aliasLower
    ) {
      continue;
    }
    // Found the stanza to remove: lines[i] through the line before the next
    // Host keyword (or EOF). Find the exclusive end index.
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const body = parseLine(lines[j]);
      if (body && body.keyword === 'host') {
        end = j;
        break;
      }
    }
    // When the removed stanza sat between other stanzas, also drop the single
    // blank separator line that followed it so we don't leave a doubled gap.
    // (The blank line preceding the stanza, which belongs to the prior stanza's
    // trailing whitespace, is preserved.)
    let removeCount = end - i;
    if (end < lines.length && lines[end].trim() === '') {
      removeCount += 1;
    }
    lines.splice(i, removeCount);
    return lines.join('\n');
  }
  return configText;
}

function parseLine(raw: string): { keyword: string; value: string } | null {
  const commentIdx = raw.indexOf('#');
  const line = (commentIdx >= 0 ? raw.slice(0, commentIdx) : raw).trim();
  if (!line) return null;
  const eqIdx = line.indexOf('=');
  if (eqIdx > 0) {
    const keyword = line.slice(0, eqIdx).trim().toLowerCase();
    const value = line.slice(eqIdx + 1).trim();
    if (keyword && value) return { keyword, value: unquote(value) };
  }
  const spaceIdx = line.search(/\s/);
  if (spaceIdx <= 0) return null;
  const keyword = line.slice(0, spaceIdx).trim().toLowerCase();
  const value = line.slice(spaceIdx + 1).trim();
  if (keyword && value) return { keyword, value: unquote(value) };
  return null;
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}
