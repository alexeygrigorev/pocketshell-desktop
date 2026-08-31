# PocketShell Desktop — Architecture

How the Electron app is structured: process boundaries, module layout,
the terminal model, state, and security.

---

## 1. Process model

Standard hardened Electron: three processes.

```
┌─────────────────────────────┐   contextBridge   ┌──────────────────────────┐
│  Renderer (Vue 3, sandboxed)│ ◀──────────────▶ │  Preload (trusted)        │
│  - views, components, Pinia  │   window.api      │  - typed IPC surface      │
│  - xterm.js, CodeMirror      │                   └────────────┬─────────────┘
└─────────────────────────────┘                                │ ipcRenderer
                                                               │
┌──────────────────────────────────────────────────────────────▼──────────────┐
│  Main (Node, privileged — the only process that touches ssh2/keys/fs)        │
│  - SshService, SftpService, PortForwarder, AutoForwarderSupervisor           │
│  - SshConfigParser, KnownHostsVerifier, PocketshellHelper client             │
│  - ConnectionRegistry (connection id → live ssh2 Client)                      │
│  - PortfwdStore (electron-store); NO keychain — see the rule below           │
│  - ipcMain handlers                                                          │
└─────────────────────────────────────────────────────────────┬───────────────┘
                                                              │ ssh2 (TCP/SSH)
                                                              ▼
                                              ┌────────────────────────────┐
                                              │  Remote dev box            │
                                              │  tmux + pocketshell helper │
                                              └────────────────────────────┘
```

**Rules:**
- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.
- The renderer **never** imports `ssh2`, `fs`, `net`, or sees private keys.
  It only calls typed methods on `window.api` and receives results /
  streams.
- All connections live in the main process, keyed by an opaque `connectionId`
  the renderer holds.
- Passphrases are **not stored at all**. One is supplied with a connect
  call, used by `ssh2`, and forgotten; nothing writes it anywhere. This
  paragraph used to promise the OS keychain via `keytar`, which was a
  dependency for a year with no `import` of it anywhere in the app — the
  package shipped in every installer, was rebuilt natively on every
  `npm run dist`, and did nothing. It has been removed. Storing passphrases
  is still a reasonable feature; it is simply not one this app has.

---

## 2. Module layout

```
src/
├─ main/
│  ├─ index.ts                # app/window lifecycle, registers ipc handlers
│  ├─ ipc.ts                  # ipcMain.handle registrations (the API surface)
│  ├─ ssh/
│  │  ├─ SshService.ts        # connect/exec/tail/shell/close (ssh2 wrapper)
│  │  ├─ ConnectionRegistry.ts# connectionId -> Client + metadata
│  │  └─ types.ts             # HostConfig, ExecResult, ShellHandle, ...
│  ├─ ssh-config/
│  │  ├─ SshConfigParser.ts   # ~/.ssh/config -> HostEntry[]
│  │  └─ KnownHosts.ts        # parse + verify against ~/.ssh/known_hosts (TOFU)
│  ├─ portfwd/
│  │  ├─ Forwarder.ts         # one -L/-R/-D forward (ssh2 forwardOut/forwardIn)
│  │  ├─ AutoForwarder.ts     # scan-loop + mirror/allocate (extends Android local-only)
│  │  ├─ AutoForwarderSupervisor.ts  # reconnect FSM (exp backoff 5s->60s)
│  │  └─ PortScanner.ts       # ss -tlnp -> netstat -> ss
│  ├─ sftp/
│  │  └─ SftpService.ts       # list/read/write/mkdir/rename/delete/upload/download
│  ├─ helper/
│  │  ├─ PocketshellClient.ts # runs `pocketshell <cmd>` over an SshService exec
│  │  ├─ bootstrap.ts         # PATH detection + probe sequence + install actions
│  │  └─ parsers.ts           # sessions-list / enrichment / usage / bootstrap parsers
│  ├─ portfwd/PortfwdStore.ts # electron-store: forward rules (the only store)
│  └─ util/                   # logging, errors, shell-quote
├─ preload/
│  └─ index.ts                # contextBridge.exposeInMainWorld('api', ...)
└─ renderer/
   ├─ main.ts                 # Vue app bootstrap
   ├─ App.vue
   ├─ ipc.ts                  # typed wrapper over window.api
   ├─ router.ts               # host-picker / host-workspace / folder-workspace
   ├─ stores/                 # Pinia: connection, sessions, files, agents, usage, forwards
   ├─ views/
   │  ├─ HostPickerView.vue
   │  ├─ HostWorkspaceView.vue# shell: folder panel + right pane
   │  ├─ FolderWorkspaceView.vue # one folder: a tab per session, then Files
   │  ├─ FilesView.vue
   │  ├─ UsageView.vue
   │  └─ PortPanelView.vue
   └─ components/
      ├─ HostList.vue, SessionTree.vue
      ├─ TerminalView.vue     # xterm.js + attach/detach + resize
      ├─ FileTree.vue, CodeEditor.vue (CodeMirror), ImagePreview.vue
      └─ ForwardTable.vue
```

Two `tsconfig.json`s: `tsconfig.node.json` (main + preload, `@types/node`)
and `tsconfig.web.json` (renderer, DOM libs). A shared `tsconfig.base.json`
holds strict options.

---

## 3. The terminal model — helper-driven attach

The Android app speaks the full `tmux -CC` control-mode protocol itself
(per-pane VT rendering). The desktop port deliberately does **not** re-port
that. Instead it uses the **helper-driven attach** model, chosen with the
maintainer:

1. The session tree is fetched from `pocketshell sessions list --by
   activity` over a normal SSH exec channel (fast, cheap, pollable).
2. Clicking a session opens an `xterm.js` whose backing SSH **shell**
   channel runs `tmux attach -t '<name>'`. tmux's real tiled layout renders
   in the terminal; tmux owns the panes.
3. Input goes over the PTY (`shell.stdin.write`); resize calls
   `shell.setWindow(cols, rows)`.
4. For resumable AI conversations, the tree offers `pocketshell sessions
   resume <id>` which creates a capped tmux session and attaches it the
   same way.

**Why not control mode?** Control mode gives per-pane structured state and
single-pane rendering — valuable on a phone, less so on a big desktop where
tiled tmux is perfectly readable. Attach is ~70% less protocol code, no
VT-escape un-decoding, no `%output` demuxer, and it satisfies the
requirement: *click a tree node → see the terminal/session view*. A future
"Per-pane" tab can add control mode as an additive feature without
rewrites.

**PTY contract (matches the Android app):** term `xterm-256color`, initial
80×24, resized via `setWindow`. The shell channel's stdout → xterm.js
`write`; xterm.js `onData` → shell stdin.

---

## 4. SSH service contract

`SshService` mirrors the Android `RealSshSession` surface, adapted to
`ssh2`'s event model:

| Method | Behaviour |
|---|---|
| `connect(cfg): Promise<connectionId>` | publickey auth; 30s timeout; `keepaliveInterval=15`; verifies host key via `KnownHosts`. Never throws — returns a result object; non-ready is an error result. |
| `exec(connectionId, cmd): Promise<ExecResult>` | `{stdout, stderr, exitCode}`. **No throw on non-zero exit** (exit codes are semantic: `command -v`, `tmux has-session`). |
| `tail(connectionId, path, fromLine, onLine): TailHandle` | spawns `tail -F -n +N '<path>'`; swallows transport drops; the caller (reconnect FSM) re-launches on a new connection. |
| `shell(connectionId, {term, cols, rows}): Promise<ShellHandle>` | PTY shell; `ShellHandle { stdin, stdout, setWindow, close }`. |
| `close(connectionId)` | idempotent; cancels tails, closes forwards/shells, disconnects. |

Key formats: `ssh2` parses PEM / OpenSSH-v1 / PKCS8 directly (ed25519 +
RSA). PuTTY `.ppk` via a parser if needed later. Passphrases resolved from
the keychain before connect.

---

## 5. Port forwarding

Extends the Android local-only model with the two forward types desktop
users expect:

- **Local `-L`**: `net.createServer` → per-conn `ssh.forwardOut`. Auto-forward
  loop scans remote ports (`PortScanner`) and mirrors/allocates a local
  port — same algorithm as Android (mirror if port ∈ [1024,10000] else
  allocate from 3000..3999, failed-port TTL 60s).
- **Remote `-R`**: `ssh.forwardIn(remoteHost, remotePort)` → the server
  accepts and channels back via `tcpip` events.
- **Dynamic `-D` (SOCKS)**: a local SOCKS5 server (`socksv` style) that
  opens `ssh.forwardOut` per SOCKS request.

`AutoForwarderSupervisor` owns reconnect across transport drops: exp
backoff 5s→60s (capped), 1s health poll, `reconnectNow()` wakes the
backoff. On drop it tears down the forwarder and lets the new scan loop
rediscover — matching the Android contract. Manual-toggle and persisted
remappings survive across reconnects (persisted config), unlike the
Android in-memory-only manual toggles.

---

## 6. Files (SFTP)

`SftpService` over `ssh2`'s own sftp channel (`client.sftp()` → `SFTPWrapper`;
`ssh2-sftp-client` was in `package.json` for a year and imported by nothing,
and has been dropped):
`list`, `readFile`/`stat`, `createWriteStream`/`writeFile`,
`mkdir`, `rename`, `delete`, `fastPut`/`fastGet` (upload/download, with
progress events). The renderer's `CodeEditor` uses CodeMirror 6 (Monaco was
planned, never imported, and dropped in `c2fe2bb`); save calls
`window.api.sftp.writeFile`. Binary detection by extension + stat;
images get an `<img>` preview, other binary offers hex/download.

Why not reuse the helper's `pocketshell env` for editing? It is scoped to
`.env`/`.envrc` only and writes via stdin. General file editing needs a
real SFTP channel. The env panel (F16) layers on top for the `.env` case
to get the helper's secret-via-stdin safety.

---

## 7. State management

Pinia stores in the renderer hold **view state only** — never secrets:

| Store | Holds |
|---|---|
| `connection` | active connectionId per host, connection/error state, bootstrap result |
| `sessions` | per-host `SessionSummary[]`, refresh state |
| `files` | current path, tree cache, open file buffers |
| `agents` | per-pane detection + current conversation events |
| `usage` | per-provider quota rows + last-refresh |
| `forwards` | per-host forward table + statuses |

Streams (terminal bytes, tail lines, forward bytes) are pushed from main
to renderer over IPC events keyed by id; the stores subscribe and the
components render.

---

## 8. Security model

- Renderer is sandboxed; no Node, no filesystem, no network primitives.
- Private keys and passphrases never cross into the renderer; only
  connection ids and parsed results do.
- `~/.ssh/known_hosts` is **enforced** (unlike the Android `AcceptAll`):
  unknown host → TOFU prompt (accept once / always); mismatch → hard
  block. No silent accept.
- Provider credentials are never on the client (D19): usage/quota comes
  from the server-side `pocketshell usage`; repo browsing from `gh` on the
  host (D23).
- Logs redact secrets (the helper's `logs ingest` already does this).
- The committed `test_key` is a fixture used **only** by Docker tests.

---

## 9. Error + reconnect contract

- `SshService` operations return result objects, never throw for
  expected failures (auth refused, host unreachable, non-zero exit).
- A transport drop emits a `connection:lost` event; the supervisor runs
  the backoff reconnect and, on success, re-runs bootstrap + session
  refresh + re-opens forwards. The UI shows a "Reconnecting…" banner.
- Tails and shells are torn down on drop and re-established by their
  owners on the new connection (same contract as Android — tail does not
  self-heal).

### 9.1 Terminal parse stalls

The renderer's unhandled errors reach the desktop log through
`diag.log` (renderer/diag.ts), but one failure class needs more than a
stack trace: xterm's write loop is a `setTimeout` queue, and when a byte
sequence makes the parser throw — an xterm-internal buffer invariant,
broken by the remote's region/scroll-heavy TUI output, not by our code —
the throw kills the loop and every pane fed by it silently stops
rendering. The thrown error lands in the log, but with no pane, no
bytes, and no hint that anything but a one-off glitch happened.

So every byte a `TerminalView` feeds xterm goes through
`ParseStallMonitor` (renderer/parseStall.ts), which wraps each chunk
with the completion callback xterm already supports. A healthy chunk
parses in microseconds; when the head chunk's callback has not run
within two seconds the loop is dead, and the monitor reports
`terminal-stall` with what the root cause is reconstructed from: the
session and connection, the terminal's buffer state (line count, baseY,
cursor), the exact stalled bytes in printable and hex form, and how
much output was queued behind them. The same report drives the diag
banner, so a frozen pane says so instead of just stopping.

Recovery (renderer/xtermWriteBuffer.ts): a stall with a thrown
unhandled error just before it is a parser death, and
`resumeWriteBufferAfterError` restarts the loop — the chunk it died on
is retired, the backlog behind it parses again. That alone does not
make the pane whole (the dead chunk left the parser mid-escape, and its
un-parsed tail is gone), so the pane follows with a bounded fresh join
— the same repair, and the same anti-hammer budget, as a dead geometry
probe: the one thing that re-initialises both ends of the stream. The
regression test (tests/unit/xtermWriteBuffer.test.ts) drives the real
`@xterm/headless` internals through the identical sync-throw path;
`scripts/xterm-fuzz.mjs` is the fuzzer that found the original
invariant break (seed 32) and is the tool to rerun when upgrading
xterm.

