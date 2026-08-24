# PocketShell Desktop — Source App Analysis

This document records what the original **PocketShell Android app**
(`github.com/alexeygrigorev/pocketshell`, analysed at the local clone
`C:\Users\alexey\git\pocketshell`) does, so the desktop (Electron) port can
decide what to keep, simplify, or extend. It grounds
[FEATURES.md](./FEATURES.md), [ARCHITECTURE.md](./ARCHITECTURE.md), and
[PLAN.md](./PLAN.md).

---

## 1. What PocketShell is

A voice-first, tmux-native, agent-aware **SSH client**. Today it is an
Android (Kotlin / Jetpack Compose) app that turns a phone into a cockpit
for the tmux sessions and AI coding agents running on a dev box. The
desktop port replaces "phone" with "desktop"; the dev-box side stays
identical.

Three load-bearing decisions in the Android app shape everything:

1. **`tmux -CC` control mode** (iTerm2-style structured protocol), not
   screen-scraping. tmux emits `%output`, `%session-changed`,
   `%layout-change`, etc. so the client gets real-time session/window/pane
   state without polling.
2. **sshj** (not the abandoned JSch) for SSH — ed25519, modern KEX.
3. **Per-pane terminal rendering** — one pane at a time in a real VT
   emulator (vendored Termux), swipe between panes. The user never sees
   tmux's own status bar; the app *is* the status bar.

The Android app speaks the full `tmux -CC` protocol itself. For the
desktop port we **do not** re-port the control-mode parser from scratch;
instead we lean on the server-side `pocketshell` helper (see §3) and use a
simpler attach model. See [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 2. The Android app's surface (what works on `main`)

| Area | Android capability |
|---|---|
| Hosts | Multi-host SSH, QR-code host import, key gen/import, biometric unlock. **No `~/.ssh/config` parsing** — hosts come from QR, manual entry, or Room DB. |
| Terminal | Persistent tmux sessions via `tmux -CC`, per-pane VT rendering, swipe nav, detach/reattach, PTY resize (`xterm-256color`, 80×24 default). |
| Input | Voice composer (Whisper), inline dictation, key bar (Esc/Tab/Ctrl/Alt/arrows), snippet library, command chips. |
| Agents | Conversation view for Claude Code / Codex / OpenCode by tailing per-engine JSONL/SQLite logs over SSH. Reply-in-place to the visible agent pane. |
| Usage | Per-provider quota (Claude/Codex/Copilot/Z.AI) via server-side `pocketshell usage`. Zero provider credentials on the phone. |
| Port forwarding | Auto-forward engine ported from `ssh-auto-forward-android`. Local forwards (`-L`) only; scans remote listening ports and mirrors them to localhost. |
| Jobs | Recurring tmux-send jobs scheduled server-side (`tmuxctl jobs daemon`). Survives phone offline. |
| Background | Strict no-background rule (D21) with one carve-out: a foreground service while ≥1 tunnel is active. |

### Areas that do **not** exist in the Android app

- **No file browser / SFTP.** Explicitly out of scope for the mobile app
  (open question O5). The desktop port adds this net-new.
- **No `~/.ssh/config` parsing.** Desktop users expect this; we add it
  net-new.
- **No known_hosts enforcement in prod.** The API supports it but
  production paths pass `AcceptAll`. Desktop honours `~/.ssh/known_hosts`.

---

## 3. The server-side `pocketshell` helper (v0.4.44)

This is the **integration hub** the desktop app targets. It is a Python
CLI (`tools/pocketshell/`, published to PyPI) installed on each dev box.
The app probes `command -v pocketshell` on connect and gates helper-backed
features on its presence. Version analysed: **0.4.44** — re-verified against
a live host (`pocketshell --version` → `0.4.44`, tmux 3.4) by running each
command below and reading the installed package source.

> **The `tests-docker` helper image pins nothing.** `Dockerfile.helper` runs
> a bare `uv tool install pocketshell`, so the version baked into the image is
> whatever was latest when the layer was first built — today that layer holds
> **0.4.8**, four minor-patch generations behind what the app actually meets.
> Every integration and E2E run has therefore been exercising a helper nobody
> runs. Worse, the same unpinned install means a cache-busting rebuild would
> silently jump versions mid-suite. That image also cannot serve
> `sessions list` at all: its bundled `tmuxctl` fails with
> `Error: not enough values to unpack (expected 3, got 1)`, so the integration
> tests only ever reach the raw-tmux fallback. Pinning both tools to an
> explicit version is a prerequisite for trusting those tiers.

### Subcommand surface (what the desktop app will call)

| Command | Purpose | Output shape |
|---|---|---|
| `sessions list --by activity\|created` | Live tmux sessions (delegates to `tmuxctl list`) | Fixed-width table: `IDX SESSION CREATED` (+ footer hints, which now name `tmuxctl` not `pocketshell sessions`). Anchor: trailing `YYYY-MM-DD HH:MM:SS`. **Three columns only** — no cwd, no attached flag, no agent kind. |
| `sessions resumable [--all] [--engine E] [-n N]` | Resumable AI-CLI conversations (claude/codex/opencode) discovered from disk | Table `f"{idx:<4}{engine:<10}{project:<20}{when:<8}{label}"` (live ones tagged `(running)`). Newest-first. **No `--json`.** Padding never truncates, so a >20-char project shifts WHEN/LABEL right, and `just now` (exactly 8) abuts LABEL with no separator. |
| `sessions resume <selector> [--mem 24G]` | Resume a conversation in a memory-capped tmux session via `tmuxctl create-or-attach --mem`, cd'ing to its cwd first | exit code; refuses live sessions (exit 3) |
| `sessions create <name> [--cwd D] [--mem M]` | Create a capped **detached** tmux session (`tmuxctl create-detached`) | exit code; idempotent |
| `agent <codex\|claude\|opencode> --dir D [--skip-permissions] [--profile P]` | Launch a coding agent in a folder with first-run prompts suppressed, provider keys stripped (subscription billing) | `os.execvpe` — replaces the process |
| `agent-log --engine E --session S [--cwd D] [--tail N] [--json]` | Read per-engine JSONL conversation log | raw JSONL lines, or `--json` envelope `{count, engine, lines, path, session}`; exit 66 = not found |
| `usage [--json] [--no-daemon] [--no-cache] [--capture] [--cached] [--reset-events]` | Provider quota (delegates to `quse`, 30s daemon cache) | NDJSON rows, keys sorted: `{provider, status, short_term:{percent_remaining, reset_at, window}, long_term:{...}, error, details}`. **`block_reason` is gone**; `percent_remaining`/`reset_at`/`window` are **nullable** for a provider with no such window (codex, grok). |
| `profiles list [--engine E] [--json]` | Agent config-dir profiles (claude `CLAUDE_CONFIG_DIR`, codex `CODEX_HOME`) | YAML default / `--json` **envelope** `{"profiles": [{name, engine, config_dir, default}]}` — not a bare array |
| `env list/get/set/unset/copy/export --dir D` | Read/write a folder's `.env` + `.envrc` (secrets via stdin, never argv) | `list --json`: `[{file, has_value, key}]`; `get --json`: `{KEY:val}` |
| `jobs list/add/edit/remove/trigger [--session S]` | Recurring tmux-send jobs (delegates to `tmuxctl jobs`) | text table / plain status lines |
| `jobs daemon start/status/stop` | Lifecycle of the scheduler | `status` → `running`/`not running` (exit 0/3) |
| `hooks install/uninstall/status/events` | Cross-engine stop/idle hooks → normalised JSONL bus | `status --json` |
| `repos list [--local\|--remote] [--json]` | Local clones + remote GitHub repos via `gh` | `--json` array: `{full_name, local:{head,path}, name, owner, remote}` |
| `repos clone <owner/repo>` | Clone into configured root | plain path |
| `logs ingest/tail/path` | Canonical agent-trace + crash sink (redacted JSONL) | records with `kind/schema/ts/result` |
| `qr-share [alias]` | Build QR import payload (mobile-only; **not used by desktop**) | QR blocks / PNGs |
| `daemon start/stop/status` | Unix-socket JSON-RPC cache daemon | `status` → `running (pid, socket)` (exit 0/3) |

### Drift from the v0.4.8 contract this document used to describe

| Command | v0.4.8 contract said | v0.4.44 reality | Consequence |
|---|---|---|---|
| `sessions resumable` | (nothing about `--json`) | `Error: No such option '--json'` — the flags are `--all`, `--engine`, `-n` only | The table is the only wire format; it must be parsed exactly |
| `sessions resumable` | "fixed-width table", widths implied stable | `<`-padding never truncates: PROJECT overflows past 20 chars, and `just now` fills WHEN's 8 with zero separator | Naive column slicing and "split on a 2+ space gap" both corrupt rows |
| `usage --json` | row carries `block_reason` | Field absent — `normalize_usage_stdout` is a thin pass-through of quse's record and quse dropped it | Any `block_reason` UI is dead |
| `usage --json` | `percent_remaining` a number | `null` for a provider with no window in that band (codex/grok short-term) | Formatting it unguarded throws |
| `usage --json` | `{percent_remaining, reset_at}` | plus a `window` label (`5h`/`7d`/`weekly`/`monthly`) | New field available to label meters |
| `profiles list --json` | bare JSON array | `{"profiles": [...]}` envelope | An `Array.isArray` guard silently yields zero profiles |
| `sessions list` footer | `Join a session: pocketshell sessions <id>` | `Join a session: tmuxctl <id>` | Cosmetic; the timestamp anchor is unaffected |
| `agent-log --json` | `{count, engine, lines, path, session}` | unchanged | — |
| `sessions list` table | unchanged | unchanged | — |

### Session metadata the helper does *not* provide: the tmux companion probe

`sessions list` delegates to `tmuxctl list` and prints `IDX SESSION CREATED`,
full stop. The desktop's folder-grouped session list needs three things that
table cannot answer — the session's cwd (the grouping key), whether it is
attached (the folder header's status dot), and what agent is running in it —
so the app pairs the helper call with **one** tmux probe, the way the phone's
`FolderListGateway` does:

```
tmux -u list-panes -a -F '#{session_name}::#{window_active}::#{pane_active}::
  #{pane_current_path}::#{session_path}::#{session_attached}::#{@ps_agent_kind}'
```

tmux resolves *session*-scoped formats (including session user options) inside
a *pane*-scoped `list-panes` context, so this single command replaces the
phone's `list-sessions` + `list-panes` pair. Verified on tmux 3.4 and 3.6b.

- **cwd** is the active pane's `pane_current_path`, falling back to
  `session_path`. Pane-primary matters: a session created with `-c ~/git`
  reports the literal unexpanded `~/git` as its `session_path`, which would
  become a bogus folder group of its own.
- **`@ps_agent_kind`** is the authoritative agent classification (epic #821).
  The `pocketshell agent` wrapper writes it with `tmux set-option
  @ps_agent_kind <kind>` in the process that becomes the agent, so it cannot
  drift from what actually launched, and it survives reconnect/restart because
  tmux session options live as long as the session. Recorded values are
  `claude` / `codex` / `opencode` / `grok` / `shell`. An absent option means a
  session we did not launch; an *unrecognised* one (real hosts carry values
  like `test-engine`) is treated the same way — unknown, never guessed.
  Siblings `@ps_agent_profile`, `@ps_agent_state`, and
  `@ps_agent_state_updated_at` exist on the same sessions and are available to
  the same probe if the desktop later wants profile chips or idle badges.

### Discovery details that matter for the desktop port

- **`sessions resumable`** reads only the *head* (≤200 lines) of each
  JSONL for the label; last-activity comes from file mtime. Claude cwd is
  encoded as `/` → `-`. OpenCode's SQLite is opened **read-only /
  immutable** so the live WAL is never locked. Live panes (cwd+engine
  match) are tagged `running` and refused for resume (never double-attach).
- **`agent <kind>`** strips ~71 provider API-key env vars (subscription
  billing), merges `.env`/`.envrc`, suppresses codex's update-check modal
  and claude's trust dialog (seeds `~/.claude.json`), then `exec`s the
  agent so it owns the pty.
- **`profiles list`** auto-discovers `~/.claude`, `~/.codex`, and
  sibling dirs (e.g. `~/.zlaude` → "Claude (Z.AI)") by marker files;
  `~/.config/pocketshell/profiles.yaml` overrides.

---

## 4. SSH + port-forwarding layer (the contract to port)

Source: `shared/core-ssh/`, `shared/core-portfwd/`, ported to Node `ssh2`.

| Concern | Android (sshj) | Desktop (Node `ssh2`) |
|---|---|---|
| Connect | publickey only, 30s timeout, 15s keepalive, never throws (returns `Result`) | `new Client()` + `ready`; `keepaliveInterval`; preserve the no-throw-on-nonzero-exit contract |
| Key formats | sshj `loadKeys` auto-detect (PEM/OpenSSH-v1/PKCS8) — ed25519 + RSA | `ssh2` parses PEM/OpenSSH/PKCS4 directly |
| exec | `ExecResult(stdout, stderr, exitCode)` — **no throw on non-zero** (exit codes are semantic, e.g. `command -v`) | `exec(cmd, cb)` returning the same shape |
| Interactive shell | PTY `xterm-256color` 80×24, resize via `changeWindowDimensions` | `shell({term, cols, rows})` + `setWindow` |
| tail | exec `tail -F -n +N '<path>'`, swallow transport drops, caller re-launches | same |
| Local forward | own `ServerSocket` + per-conn `newDirectConnection`, byte-counted | `net.createServer` → per-conn `conn.forwardOut` |
| Remote/dynamic | **not implemented** | add net-new (desktop users expect `-R`/`-D`) |
| Reconnect | `AutoForwarderSupervisor`: exp backoff 5s→60s, health-poll 1s | re-implement the same FSM |

### Bootstrap probe sequence (run on connect)

1. PATH detection via `/bin/sh -lc` shell dispatch (bash/zsh/fish/posix),
   sourcing rc files, prepending `$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin`,
   emitting `__POCKETSHELL_PATH_BEGIN__ … __POCKETSHELL_PATH_END__`.
2. `command -v pocketshell` (wrapped in path-aware shell).
3. `command -v uv` then `command -v pipx` (installer detection).
4. If pocketshell present → `systemctl --user is-active/is-enabled
   pocketshell-jobs.service` (with `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`).
5. `command -v tmux`.

Install commands: `uv tool install pocketshell` / `pipx install
pocketshell`; OS-detect → apt/apk/dnf/pacman/zypper/brew for tmux; heredoc
systemd user unit for the jobs daemon.

### Port-forward model

- **Local forward only** in Android (`SshPortForward` = `ssh -L`).
  Remote host is always `127.0.0.1` (forwards remote-loopback services).
- `AutoForwardConfig`: scan every 10s, ports in `[1024, 10000]`, local
  range `3000..3999`, mirror port when in range else allocate, failed-port
  TTL 60s.
- `PortScanner` strategies (first non-blank wins):
  `ss -tlnp`, then `netstat -tlnp`, then `ss -tln`.
- `AutoForwarderSupervisor` survives transport drops: tears down the
  forwarder, reconnects with exponential backoff, lets the new scan loop
  rediscover. Manual-toggle ports persist only within a session's lifetime.

---

## 5. tmux control-mode protocol (reference; largely un-ported)

Source: `shared/core-tmux/`. The Android app speaks the full `-CC`
protocol itself. Key facts kept here for reference; the desktop port
largely avoids re-porting it:

- **Spawn**: write `tmux -CC new-session -A -s '<name>' -c '<dir>'\n` to
  the stdin of an SSH shell channel. `-A` reattaches or creates.
- **Notifications parsed**: `%output %N <data>` (per-pane bytes, octal/hex
  escaped), `%session-changed`, `%sessions-changed`, `%window-add/close`,
  `%window-renamed`, `%layout-change`, `%pane-mode-changed`, `%begin/%end/%error`
  (command-response framing), `%client-detached`, `%exit`.
- **Session tree model**: flat + pane-centric. `ParsedPane(paneId,
  windowId, sessionId, title, paneIndex, windowIndex, cwd,
  currentCommand, paneTty, inCopyMode)`. No rich window/session objects.
- **Session list**: `pocketshell sessions list` → fallback
  `tmux list-sessions -F '#{session_name}::#{session_created}::#{session_activity}::#{session_attached}::#{session_path}'`.
- **Pane enumeration**: `list-panes -s -t '<name>' -F '<tab-delimited fields>'`.
- **Seeding**: `capture-pane -p -e -S -N -t %N`.
- **Input**: `send-keys -l` (literal), `send-keys -t %N <NamedKey>`,
  `send-keys -H -t %N <hex>` (raw/paste), `send-keys -X -t %N cancel`
  (exit copy mode). Multi-line input as bracketed paste.

The desktop port uses the **helper-driven attach model** instead — see
[ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 6. Docker test infrastructure (the model we replicate)

Source: `tests/docker/`. The Android project has a deterministic Docker
fleet that emulates the SSH target so tests never touch real hosts.

- **Base image** (`Dockerfile.ssh`): Alpine + openssh, non-root `testuser`
  (password-locked, pubkey-only), sshd on 22 foreground, committed
  ed25519 `test_key` installed as `authorized_keys`.
- **Compose services**: per-layer images on distinct host ports —
  `sshd` (2222), `tmux` (2224), `agents` (2222), `bootstrap-*` (2230–2235),
  `flaky-agent` (2226). Shared healthcheck: in-container `ssh … testuser@localhost true`.
- **Agent fixture** (`Dockerfile.agents`): Alpine + tmux + procps + bash
  + sqlite + git, with `/bin/sh` stub binaries (`claude`, `codex`,
  `opencode`, `pocketshell`, `quse`, `tmuxctl`, `uv`, `systemctl`, …)
  emitting canned payloads from `/opt/pocketshell-agent-fixtures/`, plus
  seeded JSONL/SQLite agent logs under canonical paths.
- **Two-tier test strategy**: (a) JVM Testcontainers integration tests on
  ephemeral ports for the SSH/tmux libraries; (b) Android-emulator
  instrumentation tests hitting fixed compose ports via `10.0.2.2`.

The desktop port replicates this with the same base image, the **real**
`pocketshell` helper installed (or the stub for fixed-shape outputs), and
Node integration tests + Playwright E2E hitting `127.0.0.1:<port>`. See
[TESTING.md](./TESTING.md).

---

## 7. Design decisions inherited from the Android app

These carry over because they are product-shaping, not Android-specific:

| # | Decision | Desktop consequence |
|---|---|---|
| D5/D6 | tmux-native, per-pane model | We render tmux sessions in a real terminal; the tree is the IA. |
| D19 | Zero provider credentials on the client | Usage/quota stays server-side via `pocketshell usage`. Desktop holds no API keys. |
| D22 | No backwards-compat, hard cuts only | The desktop app is greenfield; no legacy shims. |
| D23 | GitHub nav via host `gh` CLI | Repo browsing/clone runs server-side; desktop is a viewer. |
| D7 | Recurring jobs run server-side | Jobs UI delegates to `pocketshell jobs`; desktop never schedules. |
| D21 | No background work (carve-out: tunnels) | Desktop has no battery constraint, but long-running state still lives on the remote (tmux) and reconnects on focus. |

**Decisions we deliberately diverge on** (desktop context):

| Area | Android | Desktop | Why |
|---|---|---|---|
| Host source | QR / manual / DB | **`~/.ssh/config`** + manual | Desktop expectation; the original has no parser to port. |
| Terminal model | Full `tmux -CC` per-pane | Helper-driven attach (`tmux attach` in xterm.js) for v1; per-pane control-mode tab later | User-directed ("use pocketshell cli"). Far simpler, still satisfies "click tree → see terminal". |
| Files | None | Full SFTP: browse + edit + transfer | User-directed. |
| Port forwards | Local (`-L`) only | Local + remote (`-R`) + dynamic (`-D`/SOCKS) | Desktop expectation. |
| Background | Foreground service carve-out | App stays open; tunnels live while window/process is open | No mobile constraint. |
