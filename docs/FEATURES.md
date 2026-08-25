# PocketShell Desktop — Feature Backlog

Features grouped by priority. Each entry lists its **acceptance criteria**
and the **helper subcommand / SSH primitive** it calls. Priorities:

- **P0** — ship-blocker. The app is unusable or broken without it.
- **P1** — core value. The headline flows from the request.
- **P2** — strong value-add; expected of a desktop SSH/tmux client.
- **P3** — polish / later phase.

See [PLAN.md](./PLAN.md) for which phase delivers each priority.

---

## P0 — Foundation

### F1. App boots, sandboxed, single window
- Electron main process opens a 1280×800 window; `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`. Preload exposes a typed
  `window.api`. No native modules reachable from the renderer.
- **Acceptance:** `npm run dev` opens the window; closing it quits the app
  cleanly; DevTools available in dev only.
- **Calls:** none.

### F2. SSH service (connect / exec / shell / tail / close)
- `SshService` wrapping `ssh2`: `connect`, `exec → {stdout, stderr,
  exitCode}` (no throw on non-zero), `tail(path, onLine)`,
  `shell({term:'xterm-256color', cols, rows})` returning a PTY stream +
  `setWindow`, `close`. 15s keepalive, 30s connect timeout.
- **Acceptance:** unit + integration tests pass against the `ssh` Docker
  image (ed25519 key auth, `whoami` → `testuser`, tail a file, open a shell
  and round-trip bytes).
- **Calls:** `ssh2` directly.

### F3. `~/.ssh/config` parser + known_hosts verification
- Parse Host/HostName/Port/User/IdentityFile/ProxyJump/ForwardAgent/
  LocalForward/RemoteForward. TOFU prompt on unknown host key; reject on
  mismatch against `~/.ssh/known_hosts`.
- **Acceptance:** reads the user's real config (or a fixture in tests);
  host picker lists every `Host` block; a tampered known_hosts entry
  blocks connect with a clear message.
- **Calls:** filesystem reads; `ssh2` host-key verifier.

### F4. IPC boundary + preload bridge
- Every privileged operation (connect, exec, sftp, forward) is an
  `ipcMain.handle`. The preload exposes a typed surface. Keys/passphrases
  never leave the main process; the renderer only sees opaque connection
  ids and results.
- **Acceptance:** a grep for `ssh2`/`fs`/`require` in `src/renderer/`
  returns nothing.
- **Calls:** Electron `ipcMain`/`contextBridge`.

### F5. Deterministic Docker test fixtures
- `tests-docker/`: `Dockerfile.ssh`, `Dockerfile.tmux`, `Dockerfile.helper`
  (real `pocketshell` via `uv tool install`), `docker-compose.yml`,
  committed `test_key`. `scripts/smoke.sh` brings them up and verifies.
- **Acceptance:** `docker compose up -d helper && ssh … 'pocketshell
  sessions list && pocketshell usage --json'` returns the expected shapes.
- **Calls:** Docker only.

---

## P1 — Core flows (the request)

### F6. Host picker view
- Left rail lists hosts parsed from `~/.ssh/config` (name, hostname,
  user, port). Manual-add fallback (host/port/user/key picker). Recent /
  favourites optional. Click → connect + bootstrap.
- **Acceptance:** user's real hosts appear; connecting to the Docker
  fixture succeeds; a missing key shows a file picker.
- **Calls:** `~/.ssh/config` read; `SshService.connect`.

### F7. Bootstrap probe + install UX
- On connect: PATH detection, `command -v pocketshell`, `command -v tmux`,
  `command -v uv`/`pipx`, daemon status. When missing, show a one-click
  install action (`uv tool install pocketshell`, OS-aware `tmux` install).
- **Acceptance:** against the `helper` container everything is detected;
  against the bare `ssh` container the install prompt appears; running an
  install makes the next probe succeed.
- **Calls:** `pocketshell` bootstrap commands; `uv tool install`.

### F8. Session tree view
- Under each connected host, render the session tree from
  `pocketshell sessions list --by activity` (name, created, activity,
  attached, path). Refresh button; "new session" action
  (`pocketshell sessions create <name> --cwd D`).
- **Acceptance:** sessions started in the `tmux`/`helper` container
  appear; creating a session then refreshing shows it; killing it remotely
  removes it on refresh.
- **Calls:** `pocketshell sessions list`, `pocketshell sessions create`.

### F9. Terminal view (helper-driven attach)
- Clicking a session opens an `xterm.js` whose backing SSH shell channel
  runs `tmux attach -t '<name>'`. Real tiled tmux renders; keystrokes and
  resize go over the PTY. Multiple terminals (one per session) coexist;
  switching is instant. Detach cleanly on close.
- **Acceptance:** E2E against the `helper` container: pick host → see
  session → click → type `echo hi` → see output. Resize updates the remote
  PTY. Detach then reattach shows the same session.
- **Calls:** `SshService.shell`; `tmux attach`.

### F10. Files view (browse + edit + transfer)
- `SftpService`: list/read/write/mkdir/rename/delete + upload/download
  (streaming). UI: left = SFTP tree (lazy expand), right = a CodeMirror editor
  for text / image preview / hex-or-download for binary. Save writes back
  over SFTP (confirm overwrite). Drag-and-drop upload/download.
  Create/delete/rename with confirm.
- **Acceptance:** integration tests against the `ssh` image round-trip a
  file; E2E against `helper`: browse `~`, edit a file, verify the change
  via a second `ssh exec cat`.
- **Calls:** `ssh2`'s sftp channel.

---

## P2 — Strong value-add

### F11. Port forwarding (local / remote / dynamic)
- `AutoForwarder` + supervisor FSM (exp backoff 5s→60s, health poll).
  Three forward types: `-L` (local), `-R` (remote), `-D` (dynamic SOCKS).
  `PortScanner` (`ss -tlnp` → `netstat` → `ss`) feeds auto-forward for
  local. Per-host table: type, local, remote, status, bytes in/out, speed.
  Manual add/remove, toggle auto, edit remap. Persisted config.
- **Acceptance:** integration: start `python -m http.server` in the
  container, auto-forward it, `curl localhost:<port>` succeeds; tear down
  on disconnect; `-R` and `-D` round-trips pass; the `flaky-helper`
  container exercises reconnect.
- **Calls:** `ssh2` `forwardOut`/`forwardIn`/`openssh_forwardInStreamLocal`.

### F12. Reconnect + reliability
- On transport drop: surface "Reconnecting…" state, exponential backoff,
  re-run bootstrap + session refresh, re-open forwards. Health poll 1s.
  Desktop sleep/wake reconnects on focus.
- **Acceptance:** `flaky-helper` (kills ssh after Ns) test passes: the app
  reconnects within backoff window and the session tree repopulates.
- **Calls:** `SshService` reconnect FSM.

---

## P3 — Agent awareness (Phase 4, all three selected)

### F13. Agent conversation view — **CUT** (docs/WORKSPACE.md §9)
Built, then deleted on the user's instruction: "let's drop conversations
completely - also remove it completely from the code". The view, the transcript
resolver, the `agent-log` client, the `agent:log` / `agent:sessionLog` channels
and their tests are gone, per docs/ANALYSIS.md D22 (hard cuts, no unused paths).
The `agent-log --session` semantics that were discovered for it are kept in
ANALYSIS.md as a finding about the HELPER, which is still true.

### F14. Agent launcher (the resumable picker half is **CUT**)
- The resumable half went with F13: `pocketshell sessions resumable` lists
  *resumable conversations*, so it is the same feature entering by a different
  door. `agent:resumable`, `parseResumableTable` and `ResumableSession` are
  removed.
- The launcher half survives and is built as the folder workspace's `+` menu
  (docs/WORKSPACE.md §5): pick an engine, the folder is already chosen by the
  workspace, and the new session runs `pocketshell agent <kind>` — through the
  WRAPPER, because that is what records `@ps_agent_kind` and a session started
  around it is classified `unknown` forever.
- **Acceptance:** against `helper`, launching an agent opens a terminal running
  the (stubbed) agent CLI in the workspace's folder.
- **Calls:** `projects:startSession`, `pocketshell agent`.

### F15. Usage / quota dashboard
- `pocketshell usage --json` → per-provider quota cards (percent remaining,
  reset-at). Foreground-only refresh (per D21).
- **Acceptance:** against `helper`, the cards populate from the seeded
  `usage.ndjson` and match the numbers.
- **Calls:** `pocketshell usage`.

### F16. Env editor (server-side)
- `pocketshell env list/get/set` per folder — surfaced as a panel when
  browsing a folder with `.env`/`.envrc`. Secrets written via stdin.
- **Acceptance:** against `helper`, edit a `.env` key and read it back.
- **Calls:** `pocketshell env`.

---

## P3 — Polish / packaging

### F17. Packaging (Windows / macOS / Linux)
- electron-builder produces nsis (win), dmg (mac), AppImage+deb (linux).
  CI builds on tag.
- **Acceptance:** a clean install launches on all three platforms.
- **Calls:** electron-builder.

### F18. Window state + UX polish
- Remember window size/position; recent hosts; keyboard nav for the tree;
  dark/light theme; multi-window.
- **Acceptance:** state survives restart; tree is fully keyboard-navigable.

### F19. CI
- GitHub Actions: unit + integration (testcontainers) on push; E2E
  (compose + Playwright) on PR; release build on tag.
- **Acceptance:** a PR cannot merge with a red E2E against Docker.

---

## Explicitly out of scope (v1)

- Voice input (Whisper) — mobile-only.
- QR host import — mobile-only; desktop uses `~/.ssh/config`.
- Full `tmux -CC` per-pane control-mode renderer — Phase 6+ opt-in.
- Android share-target, push notifications, biometric unlock.
- Real `claude`/`codex`/`opencode` execution in automated tests —
  deterministic stubs only; real-agent interaction is a manual suite later.
