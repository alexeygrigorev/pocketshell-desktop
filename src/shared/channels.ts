/**
 * IPC channel names. Defined once here so main and preload agree and the
 * preload's typed surface stays in sync. The preload wraps these into a
 * typed `window.api` (see src/preload/index.ts).
 *
 * Convention: request/response channels use `<domain>:<verb>`; streaming
 * events (main -> renderer) use `<domain>:event:<name>` and carry a payload
 * keyed by the relevant id (connectionId / shellId).
 */

export const ipc = {
  ssh: {
    listConfigHosts: 'ssh:listConfigHosts',
    connect: 'ssh:connect',
    exec: 'ssh:exec',
    close: 'ssh:close',
    state: 'ssh:event:state', // event: ConnectionState per connectionId
  },
  shell: {
    open: 'shell:open', // open a PTY shell (optionally running a command)
    input: 'shell:input', // write bytes to a shell's stdin
    resize: 'shell:resize', // setWindow(cols, rows)
    close: 'shell:close', // close a shell
    data: 'shell:event:data', // event: { shellId, data: Uint8Array }
    exited: 'shell:event:exited', // event: { shellId, exitCode }
  },
  helper: {
    bootstrap: 'helper:bootstrap',
    sessionsList: 'helper:sessionsList',
    sessionsCreate: 'helper:sessionsCreate',
    usage: 'helper:usage',
  },
  sftp: {
    list: 'sftp:list',
    stat: 'sftp:stat',
    readFile: 'sftp:readFile',
    writeFile: 'sftp:writeFile',
    mkdir: 'sftp:mkdir',
    rename: 'sftp:rename',
    deleteFile: 'sftp:deleteFile',
    rmdir: 'sftp:rmdir',
    realPath: 'sftp:realPath',
    upload: 'sftp:upload',
    download: 'sftp:download',
    progress: 'sftp:event:progress', // event: { transferId, bytes, total? }
  },
  forwards: {
    scan: 'forwards:scan', // run a one-shot port scan, return RemotePort[]
    startAuto: 'forwards:startAuto', // start the auto-forwarder for a connection
    stopAuto: 'forwards:stopAuto',
    addManual: 'forwards:addManual', // add a -L/-R/-D forward
    remove: 'forwards:remove', // remove a forward by key
    list: 'forwards:list', // current snapshot
    states: 'forwards:event:states', // event: { connectionId, states[] }
  },
  agent: {
    log: 'agent:log', // agent-log --json for an engine+session
    resumable: 'agent:resumable', // sessions resumable
    profiles: 'agent:profiles', // profiles list --json
    envList: 'agent:envList', // env list --dir --json
    envGet: 'agent:envGet', // env get --dir --json
  },
} as const;

export type IpcChannelMap = typeof ipc;
