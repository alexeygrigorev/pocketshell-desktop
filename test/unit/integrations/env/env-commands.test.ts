import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerEnv } from '../../../../extensions/pocketshell/src/feature/env/env-commands';
import type { ExecResult, SshConnection } from '../../../../src/ssh/connection/ssh-client';

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

describe('env commands', () => {
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

  it('prompts for a known watched folder before command-palette set', async () => {
    const commands: string[] = [];
    const conn = mockConnection(commands, new Map([
      ['pocketshell env set', { stdout: 'ok\n', stderr: '', exitCode: 0 }],
    ]));
    const service = mockService(conn);
    registerEnv(service, {} as never, { refreshTrees: vi.fn() });

    vscodeMock.showQuickPick
      .mockImplementationOnce(async (items: Array<{ hostId: number }>) => items[0])
      .mockImplementationOnce(async (items: Array<{ label: string; description: string }>) => {
        expect(items).toEqual([
          expect.objectContaining({ label: 'api', description: '/home/alice/git/api' }),
        ]);
        return items[0];
      });
    vscodeMock.showInputBox
      .mockResolvedValueOnce('API_KEY')
      .mockResolvedValueOnce('secret-value');

    await vscodeMock.commandHandlers.get('pocketshell.env.set')?.();

    expect(vscodeMock.showInputBox).toHaveBeenCalledTimes(2);
    expect(vscodeMock.showInputBox.mock.calls.map((call) => call[0]?.prompt)).toEqual([
      'Variable name',
      'Variable value',
    ]);
    expect(commands).toEqual([
      "pocketshell env set 'API_KEY' 'secret-value' --scope '/home/alice/git/api'",
    ]);
  });

  it('refuses command-palette set when no watched folder can be selected', async () => {
    const commands: string[] = [];
    const conn = mockConnection(commands, new Map([
      ['pocketshell env set', { stdout: 'ok\n', stderr: '', exitCode: 0 }],
    ]));
    const service = mockService(conn, []);
    registerEnv(service, {} as never, { refreshTrees: vi.fn() });

    vscodeMock.showQuickPick.mockImplementationOnce(async (items: Array<{ hostId: number }>) => items[0]);

    await vscodeMock.commandHandlers.get('pocketshell.env.set')?.();

    expect(vscodeMock.showInformationMessage).toHaveBeenCalledWith('No watched folders configured.');
    expect(vscodeMock.showInputBox).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it('prompts for a known watched folder before command-palette unset', async () => {
    const commands: string[] = [];
    const conn = mockConnection(commands, new Map([
      [
        "pocketshell env list --scope '/home/alice/git/api'",
        { stdout: 'API_KEY=***\n', stderr: '', exitCode: 0 },
      ],
      ['pocketshell env unset', { stdout: 'ok\n', stderr: '', exitCode: 0 }],
    ]));
    const service = mockService(conn);
    registerEnv(service, {} as never, { refreshTrees: vi.fn() });

    vscodeMock.showQuickPick
      .mockImplementationOnce(async (items: Array<{ hostId: number }>) => items[0])
      .mockImplementationOnce(async (items: Array<{ label: string; description: string }>) => {
        expect(items).toEqual([
          expect.objectContaining({ label: 'api', description: '/home/alice/git/api' }),
        ]);
        return items[0];
      })
      .mockImplementationOnce(async (items: Array<{ label: string; description: string }>) => {
        expect(items).toEqual([
          expect.objectContaining({ label: 'API_KEY', description: '***' }),
        ]);
        return items[0];
      });

    await vscodeMock.commandHandlers.get('pocketshell.env.unset')?.();

    expect(commands).toEqual([
      "pocketshell env list --scope '/home/alice/git/api'",
      "pocketshell env unset 'API_KEY' --scope '/home/alice/git/api'",
    ]);
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

function mockService(
  conn: SshConnection,
  watchedFolders = [
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
      label: 'disabled',
      path: '/home/alice/git/disabled',
      source: 'manual' as const,
      enabled: false,
      orderIndex: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
) {
  return {
    getConnection: vi.fn(() => conn),
    getHosts: vi.fn(async () => [{
      id: 7,
      name: 'dev',
      hostname: 'dev.example.com',
      username: 'alice',
      port: 22,
    }]),
    getWatchedFolders: vi.fn(async () => watchedFolders),
  } as never;
}
