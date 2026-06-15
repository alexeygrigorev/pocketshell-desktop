import type { SshConnection } from '../connection/ssh-client';
import type { NewWatchedFolder } from './watched-folder-store';

export const COMMON_REMOTE_ROOTS = ['~/git', '~/code', '~/projects'] as const;

export interface DiscoveredRemoteRoot {
  root: string;
  path: string;
  label: string;
}

export async function discoverRemoteProjectRoots(
  connection: SshConnection,
): Promise<DiscoveredRemoteRoot[]> {
  const result = await connection.exec(buildDiscoveryCommand(), 15_000);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Remote project root discovery failed');
  }
  return parseDiscoveryOutput(result.stdout);
}

export function discoveredRootToWatchedFolder(
  hostId: number,
  root: DiscoveredRemoteRoot,
): NewWatchedFolder {
  return {
    hostId,
    label: root.label,
    path: root.path,
    source: 'discovered',
    enabled: true,
  };
}

export function parseDiscoveryOutput(output: string): DiscoveredRemoteRoot[] {
  const roots = new Set<string>();
  const discovered: DiscoveredRemoteRoot[] = [];
  const seenPaths = new Set<string>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const [kind, value] = splitDiscoveryLine(line);
    if (!value) {
      continue;
    }
    if (kind === 'ROOT') {
      roots.add(value);
      addDiscovery(discovered, seenPaths, value, value);
      continue;
    }
    if (kind === 'DIR') {
      const root = findOwningRoot(roots, value);
      addDiscovery(discovered, seenPaths, root ?? parentPath(value), value);
    }
  }

  return discovered;
}

export function buildDiscoveryCommand(): string {
  const roots = '$HOME/git $HOME/code $HOME/projects';
  return [
    'for root in ' + roots + '; do',
    '  if [ -d "$root" ]; then',
    '    printf "ROOT\\t%s\\n" "$root";',
    '    find "$root" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | sed "s/^/DIR\\t/";',
    '  fi;',
    'done',
  ].join(' ');
}

function splitDiscoveryLine(line: string): [string, string] {
  const tab = line.indexOf('\t');
  if (tab < 0) {
    return ['', ''];
  }
  return [line.slice(0, tab), line.slice(tab + 1)];
}

function addDiscovery(
  discovered: DiscoveredRemoteRoot[],
  seenPaths: Set<string>,
  root: string,
  folderPath: string,
): void {
  if (seenPaths.has(folderPath)) {
    return;
  }
  seenPaths.add(folderPath);
  discovered.push({
    root,
    path: folderPath,
    label: labelFromPath(folderPath),
  });
}

function findOwningRoot(roots: Set<string>, folderPath: string): string | undefined {
  for (const root of roots) {
    if (folderPath === root || folderPath.startsWith(`${root}/`)) {
      return root;
    }
  }
  return undefined;
}

function parentPath(folderPath: string): string {
  const parts = folderPath.replace(/\/+$/, '').split('/');
  parts.pop();
  return parts.join('/') || '/';
}

function labelFromPath(folderPath: string): string {
  const parts = folderPath.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || folderPath;
}
