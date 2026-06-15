import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGit } from '../../../extensions/pocketshell/src/feature/git/git-commands';
import type { ExecResult, SshConnection } from '../../../src/ssh/connection/ssh-client';

const vscodeMock = vi.hoisted(() => {
  const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    commandHandlers,
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
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
  l10n: {
    t: (message: string, ...args: string[]) =>
      args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), message),
  },
  window: {
    createOutputChannel: vscodeMock.createOutputChannel,
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
});

function mockConnection(
  commands: string[],
  responses: Map<string, ExecResult>,
): SshConnection {
  return {
    connected: true,
    exec: vi.fn(async (command: string): Promise<ExecResult> => {
      commands.push(command);
      return responses.get(command) ?? { stdout: '', stderr: '', exitCode: 0 };
    }),
    shell: vi.fn(),
    sftp: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as SshConnection;
}

function mockService(conn: SshConnection) {
  return {
    getConnection: vi.fn(() => conn),
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
