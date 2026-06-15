import { describe, expect, it } from 'vitest';
import { buildHostDetailModel, renderHostDetailHtml } from '../../../../src/ui/host-detail';
import type { HostDetailHost } from '../../../../src/ui/host-detail';

describe('host detail panel', () => {
  it('builds a host workspace model with explicit terminal and host actions', () => {
    const model = buildHostDetailModel(host(), { connectionState: 'Connected' });

    expect(model.title).toBe('prod');
    expect(model.subtitle).toBe('alice@prod.example.com:2222');
    expect(model.statusRows).toContain('Connection: Connected');
    expect(model.primaryActions.map((action) => [action.label, action.command, action.args])).toEqual([
      ['Open Terminal', 'pocketshell.connect', [7]],
      ['Disconnect', 'pocketshell.disconnect', [7]],
      ['Browse Files', 'pocketshell.files.browse', [7]],
      ['Usage', 'pocketshell.usage.show', [7]],
      ['Tmux Sessions', 'pocketshell.tmux.list', [7]],
      ['Edit Host', 'pocketshell.editHost', [7]],
    ]);
    expect(model.sections.map((section) => section.title)).toEqual([
      'Bootstrap',
      'Recent Sessions',
      'Watched Folders',
      'Workspace Actions',
    ]);
  });

  it('renders honest empty session and watched-folder sections with command links', () => {
    const model = buildHostDetailModel(host(), { connectionState: 'Idle' });
    const html = renderHostDetailHtml(model);

    expect(html).toContain('Recent session data is not available yet');
    expect(html).toContain('No watched folders are configured');
    expect(html).toContain('command:pocketshell.connect?%5B7%5D');
    expect(html).toContain('command:pocketshell.tmux.new?%5B7%5D');
    expect(html).toContain('PocketShell CLI: installed (1.2.3)');
  });

  it('renders watched folders with row actions', () => {
    const model = buildHostDetailModel(host(), {
      connectionState: 'Connected',
      watchedFolders: [
        {
          id: 12,
          label: 'api',
          path: '/home/alice/git/api',
          source: 'discovered',
          enabled: true,
        },
      ],
    });
    const html = renderHostDetailHtml(model);

    expect(html).toContain('<strong>api</strong>');
    expect(html).toContain('/home/alice/git/api');
    expect(html).toContain('discovered');
    expect(html).toContain('command:pocketshell.watchedFolders.openSession?');
    expect(html).toContain('command:pocketshell.files.browse?');
    expect(html).toContain('command:pocketshell.git.status?');
    expect(html).toContain('command:pocketshell.git.history?');
    expect(html).toContain(encodeURIComponent(JSON.stringify([{ hostId: 7, folderId: 12, path: '/home/alice/git/api' }])));
  });

  it('escapes host text in rendered html', () => {
    const html = renderHostDetailHtml(
      buildHostDetailModel({
        ...host(),
        name: '<prod>',
        hostname: 'prod&ops.example.com',
      }, { connectionState: 'Idle' }),
    );

    expect(html).toContain('&lt;prod&gt;');
    expect(html).toContain('prod&amp;ops.example.com');
    expect(html).not.toContain('<prod>');
  });
});

function host(): HostDetailHost {
  return {
    id: 7,
    name: 'prod',
    hostname: 'prod.example.com',
    port: 2222,
    username: 'alice',
    enabled: true,
    lastConnectedAt: Date.parse('2026-06-14T12:30:00.000Z'),
    tmuxInstalled: true,
    lastBootstrapAt: Date.parse('2026-06-14T12:00:00.000Z'),
    pocketshellInstalled: true,
    pocketshellLastDetectedAt: Date.parse('2026-06-14T12:01:00.000Z'),
    pocketshellCliVersion: '1.2.3',
    pocketshellExpectedCliVersion: '1.2.0',
    pocketshellVersionCompatible: true,
    pocketshellDaemonRunning: false,
    pocketshellDaemonEnabled: null,
  };
}
