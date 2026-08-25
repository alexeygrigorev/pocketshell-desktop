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
    /**
     * Show a tmux session in this connection's terminal. Distinct from
     * `shell:open` because it is NOT necessarily a new PTY: main keeps one
     * attached tmux client per connection and moves it with `switch-client`,
     * so the reply can carry the SAME shellId the renderer already holds.
     * See src/main/ssh/TmuxClientPool.ts.
     */
    attachSession: 'shell:attachSession',
    input: 'shell:input', // write bytes to a shell's stdin
    resize: 'shell:resize', // setWindow(cols, rows)
    close: 'shell:close', // close a shell
    data: 'shell:event:data', // event: { shellId, data: Uint8Array }
    exited: 'shell:event:exited', // event: { shellId, exitCode }
  },
  helper: {
    bootstrap: 'helper:bootstrap',
    sessionsList: 'helper:sessionsList',
    /**
     * Create a session under an EXPLICIT name. The folder-first flow uses
     * `projects:startSession` instead, which derives the name from the folder;
     * this stays as the escape hatch for a caller that already knows the exact
     * tmux session name it wants.
     */
    sessionsCreate: 'helper:sessionsCreate',
    usage: 'helper:usage',
  },
  /**
   * Project-folder-first session creation: pick a folder (existing / new /
   * freshly cloned), and the session name is derived from it.
   */
  projects: {
    home: 'projects:home', // resolve the remote $HOME (browse root + name input)
    deriveName: 'projects:deriveName', // preview the name a folder would get
    createFolder: 'projects:createFolder', // mkdir -p a new empty project folder
    reposList: 'projects:reposList', // local clones + GitHub repos
    reposClone: 'projects:reposClone', // clone a GitHub repo, return its path
    startSession: 'projects:startSession', // folder-first session create
    cloneProgress: 'projects:event:cloneProgress', // event: CloneProgress
  },
  sftp: {
    list: 'sftp:list',
    stat: 'sftp:stat',
    readFile: 'sftp:readFile', // UTF-8 text; mangles anything binary
    readBinary: 'sftp:readBinary', // raw bytes, size-capped (images, audio, pdf)
    writeFile: 'sftp:writeFile',
    mkdir: 'sftp:mkdir',
    rename: 'sftp:rename',
    deleteFile: 'sftp:deleteFile',
    rmdir: 'sftp:rmdir',
    realPath: 'sftp:realPath',
    upload: 'sftp:upload',
    download: 'sftp:download',
    saveAs: 'sftp:saveAs', // download to a location picked in a native dialog
    progress: 'sftp:event:progress', // event: { transferId, bytes, total? }
  },
  forwards: {
    scan: 'forwards:scan', // run a one-shot port scan, return RemotePort[]
    startAuto: 'forwards:startAuto', // start the auto-forwarder (+ ssh-config LocalForwards)
    stopAuto: 'forwards:stopAuto',
    addManual: 'forwards:addManual', // add a -L/-R/-D forward
    remove: 'forwards:remove', // remove a forward by key
    list: 'forwards:list', // current snapshot
    refresh: 'forwards:refresh', // one policy-applying scan pass now ("Scan" button)
    discovered: 'forwards:discovered', // DiscoveredPort[] — incl. ports we do NOT forward
    status: 'forwards:status', // AutoForwarderStatus | null — scan health
    setName: 'forwards:setName', // set/clear a port's friendly name (persisted)
    setRemap: 'forwards:setRemap', // pin a remote port to a local port (persisted)
    clearRemap: 'forwards:clearRemap', // drop a pin (persisted)
    setIntent: 'forwards:setIntent', // force-on / force-off / null (persisted)
    togglePort: 'forwards:togglePort', // flip a remote port forwarded <-> silenced
    isAutoEnabled: 'forwards:isAutoEnabled', // was auto left enabled for this host?
    states: 'forwards:event:states', // event: { connectionId, states[] }
  },
  attachments: {
    stage: 'attachments:stage', // upload pasted bytes / picked files, return ~/ display paths
    pickFiles: 'attachments:pickFiles', // native open dialog, returns local paths
    readLocal: 'attachments:readLocal', // bytes of a path pickFiles handed out THIS session
  },
  agent: {
    log: 'agent:log', // agent-log --json for an engine+session
    sessionLog: 'agent:sessionLog', // the conversation of ONE tmux session, id resolved for us
    resumable: 'agent:resumable', // sessions resumable
    profiles: 'agent:profiles', // profiles list --json
    envList: 'agent:envList', // env list --dir --json
    envGet: 'agent:envGet', // env get --dir --json
  },
} as const;

export type IpcChannelMap = typeof ipc;
