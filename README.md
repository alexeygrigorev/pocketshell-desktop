# PocketShell Desktop

PocketShell Desktop is a **terminal-first, agent-aware SSH client** built as a
**VS Code fork** (like Cursor or Windsurf), not a standalone Electron app. It is
a desktop companion to [PocketShell Android](https://github.com/alexeygrigorev/pocketshell):
a terminal-focused IDE that connects to your remote dev boxes over SSH, integrates
with tmux, and surfaces AI agent (Claude Code / Codex / OpenCode) conversations as
a first-class panel. Unlike VS Code's Remote-SSH, it stays thin — there is **no VS
Code server on the remote**; the app talks SSH directly (SFTP for files, SSH exec
for commands, tmux `-CC` control mode for sessions). Cross-platform, **Windows-first**.

## Architecture

```
pocketshell-desktop/                 SSH (ssh2) / SFTP / tmux -CC       Remote dev box
┌──────────────────────────────────────┐         ───────────>          ┌──────────────────┐
│ vendor/vscode/   VS Code v1.125.0    │   files: SFTP read/write      │ filesystem       │
│   (gitignored — cloned at build)     │   shell: SSH exec / PTY       │ tmux server      │
│ extensions/pocketshell/              │   sessions: tmux -CC          │ pocketshell CLI  │
│   built-in extension (public API:    │   agent logs: tail JSONL/SQLite│ agent logs       │
│   Pseudoterminal, FileSystemProvider,│                               │                  │
│   terminal profiles)                 │                               │                  │
│ product.json   PocketShell branding  │                               │                  │
└──────────────────────────────────────┘                               └──────────────────┘
```

- **VS Code source** lives at `vendor/vscode/` (v1.125.0, Electron 42.2.0). It is
  **gitignored** and cloned at build time — it is not checked into this repo.
- **PocketShell is a built-in extension** at `extensions/pocketshell/` (tracked),
  synced into `vendor/vscode/extensions/pocketshell/` during the build. It uses
  VS Code's public API: `vscode.Pseudoterminal`, `vscode.FileSystemProvider`, and
  terminal profiles.
- **Product branding** (app name, data folders, window IDs) is in `product.json`
  and applied to `vendor/vscode/product.json` by the build scripts.
- **Backend modules** (SSH via `ssh2`, SFTP, tmux `-CC` parser, SQLite store) live
  in `src/` and are copied into the extension at build time.

## Status

**v0.1.0 is in progress.** As of 2026-06-13, the **connect→terminal flow is verified
end-to-end on Linux**: a test run inside the real extension host added a host,
connected over SSH to the Docker fixture, ran a remote command, opened an
interactive PTY, and created a VS Code terminal.

Honestly, what is **not** done yet:

- **Windows and macOS builds are unverified** (the Windows CI build still times out; see #28).
- **Agent awareness** (detection + conversation view) is not wired into the UI.
- **Remote file editor** (Monaco write-back via SFTP) is not wired in.
- **tmux `-CC` session/window/pane management** is not wired into the sidebar.
- **Utility panels** (usage, jobs, env, logs) exist as backend modules under `src/`
  but are not surfaced in the UI yet.

See [agents.md](agents.md) for the full, compaction-surviving project state and
[docs/plan.md](docs/plan.md) for the v0.1.0 scope and phases.

## Prerequisites

- **Node.js v24.15.0+** (VS Code 1.125 requires Node 24; `scripts/build.sh` enforces this).
- **Linux build dependencies** for native modules (libsecret, keytar, native node
  bindings):

  ```bash
  sudo apt-get install -y libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev
  ```

- **Git** (to clone the VS Code source at build time).
- **Docker** (only for running the E2E SSH fixture — see
  [docs/getting-started.md](docs/getting-started.md#run-the-docker-ssh-fixture)).
- On a headless Linux box, **Xvfb** to run the Electron app (`xvfb-run`).

## Build & run

```bash
# 1. Install repo dev dependencies
npm install

# 2. Clone VS Code into vendor/vscode/ and build the base (one-time, ~heavy)
#    Installs VS Code deps, downloads Electron, compiles the core.
bash scripts/build-base.sh

# 3. Build the PocketShell extension (fast — seconds)
bash scripts/build-extension.sh

# 4. Launch the dev app
bash scripts/dev.sh
```

`scripts/dev.sh` re-syncs the extension source, compiles it if needed, and launches
the Electron app with all dev data isolated under `./.dev-data/`.

**Iterating:** after editing extension source in `extensions/pocketshell/`, rebuild
with `bash scripts/build-extension.sh` and press **Ctrl+R** in the running app to
reload (no full restart needed).

For a **production build** (bundling + packaging) of the current platform:

```bash
bash scripts/build-base.sh --production
```

## Config directories

The running app stores data in (per `product.json`):

- `~/.pocketshell/` — user data (settings, storage DB, logs)
- `~/.pocketshell-shared/` — shared data across app versions

In **dev mode**, `scripts/dev.sh` overrides this with `--user-data-dir .dev-data/`
so all config/logs/cache stay inside the project directory and don't pollute your
home folder.

## Tests

```bash
npm test                    # unit tests (Vitest)
npm run test:e2e            # E2E tests (Playwright, needs Docker fixture running)
npm run test:docker:up      # start the Docker SSH fixture on localhost:2222
npm run test:docker:down    # stop and remove the Docker fixture
```

See [docs/getting-started.md](docs/getting-started.md) for the full walkthrough.

## Documentation

- [docs/getting-started.md](docs/getting-started.md) — build, run, and test guide
- [docs/plan.md](docs/plan.md) — v0.1.0 architecture, scope, and phases
- [agents.md](agents.md) — **source of truth** for project state, open issues, and hard-won lessons
- [process.md](process.md) — the mandatory three-actor (orchestrator/implementer/reviewer) process
- [docs/vscode-fork-guide.md](docs/vscode-fork-guide.md), [docs/ssh-connection-reference.md](docs/ssh-connection-reference.md), [docs/tmux-protocol-reference.md](docs/tmux-protocol-reference.md) — deeper references

## Related

- [PocketShell Android](https://github.com/alexeygrigorev/pocketshell) — the mobile app this is a companion to
- [pocketshell on PyPI](https://pypi.org/project/pocketshell/) — the server-side helper CLI

## License

MIT.
