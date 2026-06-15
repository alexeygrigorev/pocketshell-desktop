import { AgentType, AGENT_METADATA } from '../agents/types';
import type { WatchedFolder } from '../ssh/data/watched-folder-store';

export type SessionKind = 'shell' | AgentType.Claude | AgentType.Codex | AgentType.OpenCode;

export interface DirectorySuggestion {
  label: string;
  path: string;
  source: 'watched' | 'remote';
}

export function buildAgentStartCommand(kind: Exclude<SessionKind, 'shell'>, startDirectory: string): string {
  return `pocketshell agent ${AGENT_METADATA[kind].binary} --dir ${quoteShellArg(startDirectory)}`;
}

export function buildSessionName(startDirectory: string | undefined, kind: SessionKind): string {
  const base = startDirectory ? basenameFromRemotePath(startDirectory) : 'pocketshell';
  return sanitizeTmuxSessionName(kind === 'shell' ? base : `${base}-${AGENT_METADATA[kind].binary}`);
}

export function buildWindowName(startDirectory: string | undefined, kind: SessionKind): string {
  if (kind === 'shell') {
    return startDirectory ? basenameFromRemotePath(startDirectory) : 'shell';
  }
  return AGENT_METADATA[kind].binary;
}

export function sanitizeTmuxSessionName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'pocketshell';
}

export function buildDirectorySuggestions(
  watchedFolders: Pick<WatchedFolder, 'label' | 'path' | 'enabled'>[],
  remoteOutput: string,
): DirectorySuggestion[] {
  const suggestions: DirectorySuggestion[] = [];
  const seen = new Set<string>();

  for (const folder of watchedFolders) {
    if (!folder.enabled || !folder.path.trim() || seen.has(folder.path)) {
      continue;
    }
    seen.add(folder.path);
    suggestions.push({ label: folder.label || basenameFromRemotePath(folder.path), path: folder.path, source: 'watched' });
  }

  for (const path of parseRemoteDirectoryOutput(remoteOutput)) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    suggestions.push({ label: basenameFromRemotePath(path), path, source: 'remote' });
  }

  return suggestions;
}

export function parseRemoteDirectoryOutput(output: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const path = line.trim();
    if (!path || seen.has(path) || path.includes('\0')) {
      continue;
    }
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function buildRemoteDirectorySuggestionCommand(seedPath?: string): string {
  const seeds = [
    '$PWD',
    '$HOME',
    seedPath ? quoteShellArg(seedPath) : undefined,
  ].filter(Boolean).join(' ');
  return [
    'sh -lc',
    quoteShellArg(
      `for d in ${seeds}; do [ -d "$d" ] && printf '%s\\n' "$d"; done; ` +
      `find "$HOME" -maxdepth 2 -type d 2>/dev/null | head -100`,
    ),
  ].join(' ');
}

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function basenameFromRemotePath(remotePath: string): string {
  const parts = remotePath.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || remotePath || 'pocketshell';
}
