import { describe, expect, it } from 'vitest';
import {
  buildDiscoveryCommand,
  discoveredRootToWatchedFolder,
  parseDiscoveryOutput,
} from '../../../src/ssh/data/watched-folder-discovery';

describe('watched folder discovery', () => {
  it('parses common roots and first-level project directories', () => {
    const discovered = parseDiscoveryOutput([
      'ROOT\t/home/alice/git',
      'DIR\t/home/alice/git/api',
      'DIR\t/home/alice/git/web',
      'ROOT\t/home/alice/code',
      'DIR\t/home/alice/code/tools',
      '',
    ].join('\n'));

    expect(discovered).toEqual([
      { root: '/home/alice/git', path: '/home/alice/git', label: 'git' },
      { root: '/home/alice/git', path: '/home/alice/git/api', label: 'api' },
      { root: '/home/alice/git', path: '/home/alice/git/web', label: 'web' },
      { root: '/home/alice/code', path: '/home/alice/code', label: 'code' },
      { root: '/home/alice/code', path: '/home/alice/code/tools', label: 'tools' },
    ]);
  });

  it('converts discovered roots into watched folder records', () => {
    expect(discoveredRootToWatchedFolder(7, {
      root: '/home/alice/projects',
      path: '/home/alice/projects/site',
      label: 'site',
    })).toEqual({
      hostId: 7,
      label: 'site',
      path: '/home/alice/projects/site',
      source: 'discovered',
      enabled: true,
    });
  });

  it('checks git, code, and projects roots', () => {
    const command = buildDiscoveryCommand();

    expect(command).toContain('$HOME/git');
    expect(command).toContain('$HOME/code');
    expect(command).toContain('$HOME/projects');
    expect(command).toContain('-maxdepth 1');
  });
});
