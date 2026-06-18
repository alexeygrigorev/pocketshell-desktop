/**
 * IPC channel names. Defined once here so main and preload agree and the
 * preload's typed surface stays in sync. The preload wraps these into a
 * typed `window.api` (see src/preload/index.ts).
 *
 * Convention: request/response channels use `<domain>:<verb>`; streaming
 * events (main -> renderer) use `<domain>:event:<name>`.
 */

export const ipc = {
  ssh: {
    listConfigHosts: 'ssh:listConfigHosts',
    connect: 'ssh:connect',
    exec: 'ssh:exec',
    close: 'ssh:close',
    state: 'ssh:event:state', // event: ConnectionState per connectionId
    // shell + tail arrive in Phase 1/4
  },
  helper: {
    bootstrap: 'helper:bootstrap',
    sessionsList: 'helper:sessionsList',
  },
} as const;

export type IpcChannelMap = typeof ipc;
