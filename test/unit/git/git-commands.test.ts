import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGit } from '../../../extensions/pocketshell/src/feature/git/git-commands';
import type { ExecResult, SshConnection } from '../../../src/ssh/connection/ssh-client';

const vscodeMock = vi.hoisted(() => {
  const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const panels: Array<{
    title: string;
    webview: { html: string; cspSource: string; onDidReceiveMessage: ReturnType<typeof vi.fn> };
    onDidDispose: ReturnType<typeof vi.fn>;
    reveal: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    commandHandlers,
    createdPanels: panels,
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
    createWebviewPanel: vi.fn((_viewType: string, title: string) => {
      const panel = {
        title,
        webview: {
          html: '',
          cspSource: 'https://localhost',
          onDidReceiveMessage: vi.fn(),
        },
        onDidDispose: vi.fn(),
        reveal: vi.fn(),
        dispose: vi.fn(),
      };
      panels.push(panel);
      return panel;
    }),
    openExternal: vi.fn(async () => true),
    Uri: { parse: (url: string) => ({ toString: () => url }) },
    executeCommand: vi.fn(),
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => unknown) => {
      commandHandlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    showWarningMessage: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  commands: {
    executeCommand: vscodeMock.executeCommand,
    registerCommand: vscodeMock.registerCommand,
  },
  env: {
    openExternal: vscodeMock.openExternal,
  },
  ViewColumn: { Active: 1 },
  Uri: vscodeMock.Uri,
  l10n: {
    t: (message: string, ...args: string[]) =>
      args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), message),
  },
  window: {
    createOutputChannel: vscodeMock.createOutputChannel,
    createWebviewPanel: vscodeMock.createWebviewPanel,
    showErrorMessage: vscodeMock.showErrorMessage,
    showInformationMessage: vscodeMock.showInformationMessage,
    showInputBox: vscodeMock.showInputBox,
    showQuickPick: vscodeMock.showQuickPick,
    showWarningMessage: vscodeMock.showWarningMessage,
  },
}));

describe('git commands', () => {
  beforeEach(() => {
    vscodeMock.commandHandlers.clear();
    vscodeMock.createOutputChannel.mockClear();
    vscodeMock.createWebviewPanel.mockClear();
    vscodeMock.createdPanels.length = 0;
    vscodeMock.openExternal.mockClear();
    vscodeMock.executeCommand.mockClear();
    vscodeMock.registerCommand.mockClear();
    vscodeMock.showErrorMessage.mockClear();
    vscodeMock.showInformationMessage.mockClear();
    vscodeMock.showInputBox.mockReset();
    vscodeMock.showQuickPick.mockReset();
    vscodeMock.showWarningMessage.mockClear();
  });

  it('opens an existing cloned repo through the session picker command path', async () => {
    const commands: string[] = [];
    const conn = mockConnection(commands, new Map([
      ['pocketshell repos list --remote --json', json([
        remoteRepo('alice/api', '2026-01-03T00:00:00Z'),
      ])],
      ['pocketshell repos list --local --json', json([
        localRepo('alice/api', '/home/alice/git/api'),
      ])],
    ]));
    const service = mockService(conn);
    registerGit(service, {} as never, { refreshTrees: vi.fn() });

    vscodeMock.showQuickPick.mockImplementationOnce(async (items: Array<{ row: { fullName: string } }>) => {
      expect(items).toHaveLength(1);
      expect(items[0].row.fullName).toBe('alice/api');
      return items[0];
    }).mockImplementationOnce(async (items: Array<{ action: string }>) => {
      expect(items.map((item) => item.action)).toEqual(['session', 'history']);
      return items[0];
    });

    await vscodeMock.commandHandlers.get('pocketshell.git.browse')?.({ hostId: 7 });

    expect(commands).toEqual([
      'pocketshell repos list --remote --json',
      'pocketshell repos list --local --json',
    ]);
    expect(vscodeMock.executeCommand).toHaveBeenCalledWith('pocketshell.sessions.create', {
      hostId: 7,
      path: '/home/alice/git/api',
    });
    expect(vscodeMock.showInputBox).not.toHaveBeenCalled();
  });

  it('clones a missing GitHub repo into the selected root before opening a session', async () => {
    const commands: string[] = [];
    const conn = mockConnection(commands, new Map([
      ['pocketshell repos list --remote --json', json([
        remoteRepo('alice/web', '2026-01-03T00:00:00Z'),
      ])],
      ['pocketshell repos list --local --json', json([])],
      [
        "pocketshell repos clone 'alice/web' --root '/srv/src' --protocol ssh",
        { stdout: '/srv/src/web\n', stderr: '', exitCode: 0 },
      ],
    ]));
    const refreshTrees = vi.fn();
    const service = mockService(conn);
    registerGit(service, {} as never, { refreshTrees });

    vscodeMock.showQuickPick
      .mockImplementationOnce(async (items: Array<{ row: { fullName: string; cloned: boolean } }>) => {
        expect(items[0].row).toMatchObject({ fullName: 'alice/web', cloned: false });
        return items[0];
      })
      .mockImplementationOnce(async (items: Array<{ root?: string }>) => {
        expect(items.map((item) => item.root).filter(Boolean)).toEqual(['~/git', '/home/alice/git']);
        return items[1];
      })
      .mockImplementationOnce(async (items: Array<{ action: string }>) => {
        expect(items.map((item) => item.action)).toEqual(['session', 'history']);
        return items[0];
      });
    vscodeMock.showInputBox.mockResolvedValueOnce('/srv/src');

    await vscodeMock.commandHandlers.get('pocketshell.git.browse')?.({ hostId: 7 });

    expect(commands).toEqual([
      'pocketshell repos list --remote --json',
      'pocketshell repos list --local --json',
      "pocketshell repos clone 'alice/web' --root '/srv/src' --protocol ssh",
    ]);
    expect(refreshTrees).toHaveBeenCalledOnce();
    expect(vscodeMock.executeCommand).toHaveBeenCalledWith('pocketshell.sessions.create', {
      hostId: 7,
      path: '/srv/src/web',
    });
  });

  it('opens history from a cloned repo browser row', async () => {
    const commands: string[] = [];
    const conn = mockConnection(commands, new Map([
      ['pocketshell repos list --remote --json', json([
        remoteRepo('alice/api', '2026-01-03T00:00:00Z'),
      ])],
      ['pocketshell repos list --local --json', json([
        localRepo('alice/api', '/home/alice/git/api'),
      ])],
    ]));
    const service = mockService(conn);
    registerGit(service, {} as never, { refreshTrees: vi.fn() });

    vscodeMock.showQuickPick
      .mockImplementationOnce(async (items: Array<{ row: { fullName: string } }>) => items[0])
      .mockImplementationOnce(async (items: Array<{ action: string }>) => items[1]);

    await vscodeMock.commandHandlers.get('pocketshell.git.browse')?.({ hostId: 7 });

    expect(vscodeMock.executeCommand).toHaveBeenCalledWith('pocketshell.git.history', {
      hostId: 7,
      path: '/home/alice/git/api',
    });
  });

  it('renders the commit timeline in the Git History webview panel', async () => {
    const commands: string[] = [];
    const conn = mockConnection(commands, new Map([
      ['git log', {
        stdout: [
          'ENDCOMMIT\x00hash1\x00sh1\x00Alice\x00alice@test.com\x002026-01-01T00:00:00Z\x00Ship history\x00\x00',
          '\n5\t2\tsrc/git.ts',
          '\n-\t-\tassets/logo.png',
          '\n',
        ].join(''),
        stderr: '',
        exitCode: 0,
      }],
    ]));
    const service = mockService(conn);
    registerGit(service, {} as never, { refreshTrees: vi.fn() });

    await vscodeMock.commandHandlers.get('pocketshell.git.history')?.({
      hostId: 7,
      path: '/home/alice/git/api',
    });

    // The history command now opens a webview panel (app-parity §6), not the
    // OutputChannel. The Commit timeline + Overview status are rendered as HTML.
    expect(vscodeMock.createWebviewPanel).toHaveBeenCalledTimes(1);
    const panel = vscodeMock.createdPanels[0];
    expect(panel.webview.html).toContain('Git History');
    expect(panel.webview.html).toContain('sh1');
    expect(panel.webview.html).toContain('Ship history');
    expect(panel.reveal).toHaveBeenCalled();
  });

  it('renders the missing-repo empty state for non-repo history requests', async () => {
    const commands: string[] = [];
    const conn = mockConnection(commands, new Map([
      ['git status', {
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
        exitCode: 128,
      }],
    ]));
    const service = mockService(conn);
    registerGit(service, {} as never, { refreshTrees: vi.fn() });

    await vscodeMock.commandHandlers.get('pocketshell.git.history')?.({
      hostId: 7,
      path: '/tmp/not-repo',
    });

    // A non-repo path no longer raises an error dialog; the panel surfaces a
    // "Not a Git repository." empty state (the parallel fetches swallow the
    // per-call errors and mark the repo missing).
    expect(vscodeMock.createWebviewPanel).toHaveBeenCalledTimes(1);
    const panel = vscodeMock.createdPanels[0];
    expect(panel.webview.html).toContain('Not a Git repository.');
    expect(vscodeMock.showErrorMessage).not.toHaveBeenCalled();
  });
});

function mockConnection(
  commands: string[],
  responses: Map<string, ExecResult>,
): SshConnection {
  return {
    connected: true,
    exec: vi.fn(async (command: string): Promise<ExecResult> => {
      commands.push(command);
      return responses.get(command)
        ?? Array.from(responses.entries()).find(([key]) => command.includes(key))?.[1]
        ?? { stdout: '', stderr: '', exitCode: 0 };
    }),
    shell: vi.fn(),
    sftp: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as SshConnection;
}

function mockService(conn: SshConnection) {
  return {
    getConnection: vi.fn(() => conn),
    getHost: vi.fn(async () => ({ name: 'host7', hostname: 'host7' })),
    getWatchedFolders: vi.fn(async () => [
      {
        id: 12,
        hostId: 7,
        label: 'api',
        path: '/home/alice/git/api',
        source: 'manual' as const,
        enabled: true,
        orderIndex: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 13,
        hostId: 7,
        label: 'old',
        path: '/home/alice/old',
        source: 'manual' as const,
        enabled: false,
        orderIndex: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  } as never;
}

function json(value: unknown): ExecResult {
  return {
    stdout: JSON.stringify(value),
    stderr: '',
    exitCode: 0,
  };
}

function remoteRepo(fullName: string, updatedAt: string) {
  const [owner, name] = fullName.split('/');
  return {
    owner,
    name,
    full_name: fullName,
    local: null,
    remote: {
      default_branch: 'main',
      html_url: `https://github.com/${fullName}`,
      ssh_url: `git@github.com:${fullName}.git`,
      updated_at: updatedAt,
    },
  };
}

function localRepo(fullName: string, path: string) {
  const [owner, name] = fullName.split('/');
  return {
    owner,
    name,
    full_name: fullName,
    local: { path, head: 'main' },
    remote: null,
  };
}
