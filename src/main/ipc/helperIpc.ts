import type { IpcContext } from './context.js';
import { ipcMain } from 'electron';
import { ipc } from '../../shared/channels.js';
import type { BootstrapResult, SessionSummary } from '../../shared/types.js';
import { runBootstrap } from '../helper/bootstrap.js';
import type { UsageRow } from '../helper/usageParsers.js';


export function registerHelperIpc(ctx: IpcContext): void {
  const { ssh, helper } = ctx;
  // --- helper:bootstrap ----------------------------------------------------
  ipcMain.handle(ipc.helper.bootstrap, async (_evt, connectionId: string): Promise<BootstrapResult> => {
    return runBootstrap(ssh, connectionId);
  });

  // --- helper:sessionsList -------------------------------------------------
  ipcMain.handle(
    ipc.helper.sessionsList,
    async (
      _evt,
      connectionId: string,
      sortBy?: 'activity' | 'created',
    ): Promise<SessionSummary[]> => {
      return helper.listSessions(connectionId, sortBy ?? 'activity');
    },
  );

  // --- helper:sessionsCreate ----------------------------------------------
  // Explicit-name create. The folder-first flow goes through
  // `projects:startSession`; this remains for a caller that genuinely knows
  // the tmux session name it wants (and it must supply the cwd — a session
  // with no start folder is not a project session).
  ipcMain.handle(
    ipc.helper.sessionsCreate,
    async (_evt, connectionId: string, name: string, cwd: string): Promise<boolean> => {
      const outcome = await helper.createSession(connectionId, { name, cwd });
      return outcome.ok;
    },
  );

  // --- helper:usage --------------------------------------------------------
  ipcMain.handle(ipc.helper.usage, async (_evt, connectionId: string): Promise<UsageRow[]> => {
    return helper.usage(connectionId);
  });

}
