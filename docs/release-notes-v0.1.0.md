# PocketShell Desktop v0.1.0

PocketShell Desktop is a terminal-first SSH client built as a fork of VS Code.
This inaugural release delivers the **connect + terminal foundation**: connect to
a remote host over SSH and get an interactive terminal inside a familiar editor
shell. It is a foundation release — the agent-aware and file-editing features
that round out the vision exist in source but are **not wired into this release**.

## What works (verified)

The core loop below was verified end-to-end on **Linux** on 2026-06-13, by
running a test suite inside the real extension host (under Xvfb) against a Docker
SSH fixture:

- **Connect to an SSH host.** Host CRUD (add / edit / delete / list hosts),
  stored locally. Connect to a host by password or key, run a remote command, and
  disconnect cleanly.
- **Get an interactive terminal.** Open a VS Code terminal backed by an SSH PTY
  channel — shell prompt, keystroke echo, and command output all flow over SSH.
  Terminal resize is forwarded to the remote.
- **Basic SFTP.** Remote filesystem access over SFTP (browse, read, write).

This is the scope of v0.1.0: a working **connect → terminal** experience inside
the VS Code shell.

## How it's built

PocketShell Desktop is a **VS Code fork**, not standalone Electron. At build
time the VS Code source is cloned (pinned to a specific commit), PocketShell is
added as a built-in extension, and branding is applied via `product.json`. There
is no VS Code Server component on the remote side — all SSH/SFTP work happens in
the client over the `ssh2` Node.js library.

| Layer | Technology |
|-------|-----------|
| Editor framework | VS Code (forked at build time) |
| SSH transport | ssh2 (Node.js) |
| Terminal emulation | xterm.js |
| File operations | SFTP over ssh2 |
| Code editor | Monaco Editor |
| Unit testing | Vitest |
| E2E testing | Playwright |
| CI/CD | GitHub Actions |

## Testing

- **Unit tests** (Vitest) cover the backend modules in `src/`.
- **E2E tests** (Playwright) run against a Docker SSH fixture.
- **CI** runs lint, unit tests, and E2E tests and is **green**.

The connect→terminal flow was additionally verified by running a live test suite
inside the actual extension host against the Docker fixture (3/3 passing) — see
`agents.md` for the record.

## Limitations

### Linux-only verification

The connect→terminal flow has been verified **on Linux only**. Windows and macOS
builds have **not** been verified by a green release run.

### Cross-platform build pipeline redesigned, not yet proven

The release build pipeline (issue #35) was redesigned to avoid recompiling all
of VS Code on every release. The `release.yml` workflow is now split into:

1. **`prepare-base`** — clones VS Code, installs deps, compiles the core, and
   downloads Electron, caching the result under a key of the form
   `vscode-{REF}-{platform}-base-v2`.
2. **`build`** — restores the cached base (fail-on-cache-miss), applies
   PocketShell branding, compiles the extension, and runs the production
   packaging (`gulp vscode-{platform}`).
3. **`release`** — attaches the three platform artifacts to a GitHub Release on
   tag push.

This split is reviewed and committed but has **not yet produced a green release
run**. Treat cross-platform artifacts as unverified until the first real tag run
succeeds.

### Deferred features (in source, not in v0.1.0)

The following exist as modules in `src/` but are **not wired into the extension**
for v0.1.0 and therefore do not ship in this release:

- **tmux control mode** (`-CC` protocol, session/window/pane management)
- **Remote file editor** (Monaco editing over SFTP)
- **Agent awareness** (Claude Code / Codex / OpenCode detection, conversation
  view, reply-in-place, slash command palette, agent hooks)
- **Command palette** and **utility panels** (usage, jobs, env, logs, bootstrap)
- **Git repository browsing** via `pocketshell repos`

These are the v0.2+ roadmap.

### Other limitations

- **No auto-update.**
- **Single SSH connection** at a time.
- **English only.**
- **Single theme** (PocketShell Dark).

## System Requirements

- **Operating System:** Linux x64 (verified). Windows 10+ and macOS 12+ are
  targeted but **unverified** for this release.
- **Node.js:** 24.x (build time only).
- **Remote host:** an SSH server. A remote `tmux` is **not** required for v0.1.0
  (tmux integration is deferred).

## Installation

> The artifacts below are produced by the release workflow. Until the first green
> release run completes, treat download links as placeholders.

### Linux (verified)

1. Download `pocketshell-v0.1.0-linux-x64.tar.gz` from the
   [release assets](https://github.com/alexeygrigorev/pocketshell-desktop/releases/tag/v0.1.0).
2. Extract: `tar xzf pocketshell-v0.1.0-linux-x64.tar.gz`
3. Run: `./pocketshell`

### Windows (targeted, unverified)

1. Download `pocketshell-v0.1.0-win32-x64.zip` from the
   [release assets](https://github.com/alexeygrigorev/pocketshell-desktop/releases/tag/v0.1.0).
2. Unzip and run `pocketshell.exe`.

### macOS (targeted, unverified)

1. Download `pocketshell-v0.1.0-darwin-arm64.tar.gz` from the
   [release assets](https://github.com/alexeygrigorev/pocketshell-desktop/releases/tag/v0.1.0).
2. Extract and run.

## Contributing

PocketShell Desktop uses a three-actor development process: Orchestrator,
Implementer, and Reviewer. See:

- [Development process](../process.md)
- [Agent roles & project state](../agents.md)
- [Project plan](plan.md)

## Full Changelog

See [CHANGELOG.md](../CHANGELOG.md).
