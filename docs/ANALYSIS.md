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

> **The `tests-docker` helper image is now pinned.** `Dockerfile.helper` sets
> `ARG POCKETSHELL_VERSION=0.4.44` and installs `pocketshell==${POCKETSHELL_VERSION}`,
> on `alpine:3.20` (tmux 3.4) — the same pair a real host runs. It previously
> ran a bare `uv tool install pocketshell`, which does not mean "latest" but
> "whatever was latest when the layer was first cached": the image sat at
> **0.4.8** while hosts ran 0.4.44, and four parser bugs reached the app
> through that gap (the `{profiles: […]}` envelope, a null `percent_remaining`,
> a removed `--json` flag, and the overflowing fixed-width resumable table).
> The `tests/unit/fixtures/v0.4.44-*` files are captured against this image;
> re-capture them whenever the pin moves.
>
> **The image still cannot serve `sessions list`.** Its `tmuxctl` asks tmux for
> a tab-delimited `list-sessions` format and tmux rewrites those tabs to
> underscores, so the command dies with
> `Error: not enough values to unpack (expected 3, got 1)`. This reproduces on
> tmux 3.4 and 3.6b alike, so it is not a version regression — it is
> [tmuxctl#6](https://github.com/alexeygrigorev/tmuxctl/issues/6). Until that
> is fixed upstream the integration tests only ever reach the raw-tmux
> fallback path, and the `sessions-list` / `sessions-resumable` /
> `usage` / `tmux-list-panes` fixtures stay **host**-captured: the image also
> has no agent history for `sessions resumable` to find and no provider
> credentials, so every `usage --json` row on it comes back `status: "error"`.

### Subcommand surface (what the desktop app will call)

| Command | Purpose | Output shape |
|---|---|---|
| `sessions list --by activity\|created` | Live tmux sessions (delegates to `tmuxctl list`) | Fixed-width table: `IDX SESSION CREATED` (+ footer hints, which now name `tmuxctl` not `pocketshell sessions`). Anchor: trailing `YYYY-MM-DD HH:MM:SS`. **Three columns only** — no cwd, no attached flag, no agent kind. |
| `sessions resumable [--all] [--engine E] [-n N]` | Resumable AI-CLI conversations (claude/codex/opencode) discovered from disk | Table `f"{idx:<4}{engine:<10}{project:<20}{when:<8}{label}"` (live ones tagged `(running)`). Newest-first. **No `--json`.** Padding never truncates, so a >20-char project shifts WHEN/LABEL right, and `just now` (exactly 8) abuts LABEL with no separator. |
| `sessions resume <selector> [--mem 24G]` | Resume a conversation in a memory-capped tmux session via `tmuxctl create-or-attach --mem`, cd'ing to its cwd first | exit code; refuses live sessions (exit 3) |
| `sessions create <name> [-c/--cwd D] [--mem M]` | Create a capped **detached** tmux session (`tmuxctl create-detached`) | Prints the **resolved session name on stdout**, exit 0; idempotent (a no-op when the session exists). `--mem` must be left UNSET — tmuxctl resolves the per-project cap from the repo's `cgroups.toml`. On a host with no cgroup v2 it prints `tmuxctl: systemd-run unavailable; session runs without a memory cap` to **stderr** and still exits 0. **A `--cwd` that does not exist ALSO exits 0**, creating a session whose pane lands in `$HOME` — the client must pre-check `[ -d … ]`. |
| `agent <codex\|claude\|opencode> --dir D [--skip-permissions] [--profile P]` | Launch a coding agent in a folder with first-run prompts suppressed, provider keys stripped (subscription billing) | `os.execvpe` — replaces the process |
| `agent-log --engine E --session S [--cwd D] [--tail N] [--json]` | Read per-engine JSONL conversation log | raw JSONL lines, or `--json` envelope `{count, engine, lines, path, session}`; exit 66 = not found |
| `usage [--json] [--no-daemon] [--no-cache] [--capture] [--cached] [--reset-events]` | Provider quota (delegates to `quse`, 30s daemon cache) | NDJSON rows, keys sorted: `{provider, status, short_term:{percent_remaining, reset_at, window}, long_term:{...}, error, details}`. **`block_reason` is gone**; `percent_remaining`/`reset_at`/`window` are **nullable** for a provider with no such window (codex, grok). |
| `profiles list [--engine E] [--json]` | Agent config-dir profiles (claude `CLAUDE_CONFIG_DIR`, codex `CODEX_HOME`) | YAML default / `--json` **envelope** `{"profiles": [{name, engine, config_dir, default}]}` — not a bare array |
| `env list/get/set/unset/copy/export --dir D` | Read/write a folder's `.env` + `.envrc` (secrets via stdin, never argv) | `list --json`: `[{file, has_value, key}]` — names only, never values (write-only default, D24). `get --json`: `{KEY: val}`, but **`--key` is REQUIRED and repeatable** — there is no "reveal everything" mode, and `env get --dir D --json` alone exits **2** with `Error: Missing option '--key'`. Reading a whole folder therefore costs `env list` **then** `env get --key …` per name. Missing keys are simply absent from the output; only a hard error is non-zero. |
| `jobs list/add/edit/remove/trigger [--session S]` | Recurring tmux-send jobs (delegates to `tmuxctl jobs`) | text table / plain status lines |
| `jobs daemon start/status/stop` | Lifecycle of the scheduler | `status` → `running`/`not running` (exit 0/3) |
| `hooks install/uninstall/status/events` | Cross-engine stop/idle hooks → normalised JSONL bus | `status --json` |
| `repos list [--local\|--remote] [--json] [--root R]… [--max-depth N] [--limit N] [--no-daemon] [--no-cache]` | Local clones + remote GitHub repos via `gh api user/repos --paginate --slurp` | `--json` array of the unified schema `{owner, name, full_name, local:{path,head}, remote:{default_branch,html_url,ssh_url,updated_at}}`. `--local` rows always have `remote: null` and vice versa — **the join is the client's job**. `owner`/`full_name` are **null** for a clone with a non-GitHub origin or none, so consumers must fall back to `name`. With NEITHER flag it defaults to `--local` **and prints a discoverability hint** — always pass the scope explicitly. `--remote` with no `gh` on PATH exits **127** with ``pocketshell: `gh` is not installed on this host…`` on stderr (the same 127 a missing `pocketshell` gives — the stderr text is what distinguishes them). A missing `--root` warns on stderr and still exits 0 with `[]`. |
| `repos clone <owner/repo> [--root R] [--folder F] [--protocol ssh\|https]` | Clone into the configured root (default `~/git`, default protocol `ssh`) | Plain path on stdout, exit 0. **Not idempotent**: re-cloning exits **1** with `pocketshell repos clone: clone target already exists: <path>` — the path is recoverable from that message. A git failure surfaces git's own exit (e.g. **128**) and stderr. |
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
| `env get --json` | `--dir D --json` returns the folder's env | `--key` is a REQUIRED, repeatable option; without it the command exits **2** (`Missing option '--key'`) | A client that omits `--key` hits the non-zero branch and silently returns `{}` — the env editor can never show a value. Read the names with `env list` first. |
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
- **`agent-log --session S`** takes the ENGINE's transcript id — the stem of
  the JSONL file (`demo-claude`, a claude uuid, a codex rollout name) — and
  **not** the tmux session name. Nothing the helper lists returns that id:
  `sessions list` is IDX/SESSION/CREATED and `sessions resumable` is
  ENGINE/PROJECT/WHEN/LABEL, neither of which carries it. A session-scoped
  caller therefore has to recover it from the on-disk layout itself, keyed on
  the session's cwd and its recorded `@ps_agent_kind`; only claude's path
  encodes the cwd, so for codex and opencode the match is by engine plus
  recency and cannot be verified.

  **This finding is kept and the code that used it is gone.** The desktop's
  conversation view was deleted (docs/WORKSPACE.md §9) and `transcripts.ts`
  went with it. What is recorded here is a fact about the HELPER's interface,
  not about our port of it, and it is exactly the fact anyone reimplementing
  this would have to rediscover — the id is not derivable from anything the
  helper prints.
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
- **Desktop divergence — persistence.** The Python tool persists only
  `~/.ssh-auto-forward/port-names.json`, and Android's manual toggles die with
  the session. The desktop persists friendly names, local remaps, per-port
  on/off intents and the auto-enabled flag across restarts, in `PortfwdStore`
  (electron-store, `portfwd.json`). State is keyed by **`~/.ssh/config` host
  alias** when the connection carries one — `ConnectionRecord.hostAlias`,
  threaded from `ConnectOptions` — matching the Python's `self.host_alias`, so
  two aliases on the same box keep separate name sets and a host's settings
  survive its IP changing. A manually-entered host has no alias and falls back
  to `user@host:port`. `hostKeyFor` is the single place that choice is made.

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

> **D22, applied to the v0.4.8 shims.** The `block_reason` field, the bare-array
> `profiles list` shape and the `--muted` alias went first. The last one to go
> was version *sniffing*: `isHelperMissing` (`src/main/projects/repos.ts`) used
> to answer true for Click's exit-2 `No such command` / `No such option` as
> well as for the shell's 127, on the reading "a helper too old for the
> subcommand is as good as no helper". Against 0.4.44 that reading is dead —
> every subcommand and option this app sends exists — so those exits now mean
> a fault, and are reported as one with an explanatory line appended to the
> host's own message (`describeHelperRejection`). It mattered most on
> `sessions create`, whose only fallback is a raw `tmux new-session` with **no
> memory cap**: while the shim stood, a command this client built wrong would
> have been laundered into a successful-looking, uncapped session. The
> fallback itself stays, gated on the one thing it was ever for — no
> `pocketshell` binary on PATH.

**Decisions we deliberately diverge on** (desktop context):

| Area | Android | Desktop | Why |
|---|---|---|---|
| Host source | QR / manual / DB | **`~/.ssh/config`** + manual | Desktop expectation; the original has no parser to port. |
| Terminal model | Full `tmux -CC` per-pane | Helper-driven attach (`tmux attach` in xterm.js) for v1; per-pane control-mode tab later | User-directed ("use pocketshell cli"). Far simpler, still satisfies "click tree → see terminal". |
| Files | None | Full SFTP: browse + edit + transfer | User-directed. |
| Port forwards | Local (`-L`) only | Local + remote (`-R`) + dynamic (`-D`/SOCKS) | Desktop expectation. |
| Background | Foreground service carve-out | App stays open; tunnels live while window/process is open | No mobile constraint. |
