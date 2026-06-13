# Changelog

All notable changes to PocketShell Desktop are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Scope note.** The modules described below were built and unit-tested in
> `src/`. For v0.1.0, only the **connect + terminal + basic SFTP** foundation is
> wired into the extension and verified end-to-end (on Linux). The agent-aware,
> tmux, remote-file-editor, command-palette, and utility-panel modules exist in
> source but are **deferred** to later releases. Each section is tagged
> accordingly.

## [Unreleased]

### Deferred (built, not yet wired into the extension)

The following subsystems are implemented and unit-tested in `src/`, but are not
part of the v0.1.0 release. They are the v0.2+ roadmap:

- tmux control mode (`-CC` protocol) — `TmuxClient`, `TmuxEventStream`,
  `TmuxSessionManager`.
- Remote file editor (Monaco over SFTP) — `DocumentManager`, `RemoteDocument`,
  `RemoteSaveManager`.
- Agent awareness — `AgentDetector`, conversation parsers, `AgentMessenger`,
  `ReplyQueue`, slash command palette, `HookManager`.
- Git repository browsing via `pocketshell repos`.
- Command palette and utility panels (usage, jobs, env, logs, bootstrap).

### Pending

- Windows and macOS release builds verified by a green `release.yml` run (#28).
- A committed integration test capturing the connect→terminal flow (#30).
- First green cross-platform production build (#35).

## [0.1.0] - 2026-06-13

### Summary

**Connect + terminal foundation.** v0.1.0 is the first release of PocketShell
Desktop, a VS Code fork that turns the editor into a terminal-first SSH client.

What ships and is **verified end-to-end on Linux**:

- SSH connection management — host CRUD, connect by password/key, run remote
  commands, clean disconnect.
- Integrated terminal — a VS Code terminal backed by an SSH PTY channel, with
  resize forwarding.
- Basic SFTP — remote filesystem access.

What is **redesigned but not yet proven**:

- The release build pipeline (#35) is split into `prepare-base` (builds & caches
  the VS Code fork base) → `build` (compiles the extension + production
  packaging) → `release` (GitHub Release on tag). Reviewed and committed; not
  yet verified by a green release run. Windows and macOS builds are unverified.

### Added — VS Code fork setup

- Cloned VS Code at a pinned commit (`037f7fbe…`) as the editor base.
- PocketShell added as a built-in extension registered in
  `gulpfile.extensions.ts`.
- Product branding applied via `product.json` (name, application name, quality,
  data dirs `~/.pocketshell/` and `~/.pocketshell-shared/`).
- Fast extension-only build (`scripts/build-extension.sh`, ~500ms) and one-command
  dev launch (`scripts/dev.sh`).

### Added — SSH connect + terminal + SFTP (verified on Linux)

- `src/ssh/` — `SshClient`, `ConnectionManager`, `ConnectionPool`, `HostStore`
  (SQLite via `sql.js`), `KeyStore`. SSH lifecycle over `ssh2`: host CRUD,
  Ed25519/RSA key management, connection pooling, auto-reconnect, SSH config
  import.
- `src/terminal/` — `TerminalManager`, `SshTerminalBackend`, `PtyAdapter`.
  Terminal backed by an SSH PTY channel with resize forwarding.
- `src/files/` — `SftpClient`, `FileBrowser`, `RemoteFileWatcher`. Remote
  filesystem access over SFTP.
- Extension host activation verified: all commands register, `onStartupFinished`
  fires, no errors. Connect→terminal flow verified by a live test run inside the
  real extension host against a Docker SSH fixture (3/3 passing).

### Added — CI

- GitHub Actions CI on push to `main` and on PRs: lint, unit tests, and E2E
  tests against a Docker SSH fixture. **CI is green.**
- Cross-platform `release.yml` with a matrix across Linux, Windows, and macOS.
- Per-step `timeout-minutes` so a hang fails fast instead of running 6 hours.

### Changed — release build pipeline (#35)

- `release.yml` split into three jobs:
  1. **`prepare-base`** — clones VS Code, `npm install`, `gulp compile`, downloads
     Electron; caches the compiled base under
     `vscode-{REF}-{platform}-base-v2`.
  2. **`build`** — restores the base with `fail-on-cache-miss: true`, applies
     PocketShell branding, syncs and compiles the extension, runs
     `gulp vscode-{platform}`, and packages the output.
  3. **`release`** — attaches the platform artifacts to a GitHub Release on `v*`
     tag push.
- This fixes the prior 6-hour timeout, where the cold VS Code compile never
  finished and so the cache was never written (catch-22).

### Added — backend modules (built and unit-tested; deferred from the extension)

The modules below are implemented and covered by unit tests, but are **not wired
into the v0.1.0 extension**. They are recorded here for completeness and are the
v0.2+ roadmap.

#### Phase 1 — Connection & Terminal (extension-wired subset above; the rest below is deferred)

- tmux Control Mode Client — `TmuxClient`, `TmuxEventStream`, `TmuxSessionManager`.
  Full tmux `-CC` protocol: parses the wire protocol, maintains
  session/window/pane state, snapshot builder for rendering. (7 test files.)
- Command Registry — `CommandRegistry`, `CommandChipRegistry`. (4 test files.)

#### Phase 2 — Remote File Access (SFTP browsing is wired; the editor/git below are deferred)

- Remote File Editor — `DocumentManager`, `RemoteDocument`, `RemoteSaveManager`.
  Monaco editing over SFTP, dirty-state tracking, language detection. (4 test files.)
- Git Repository Browser — `GitClient`, `PocketShellRepos`. git status/log/branch/blame
  over SSH and `pocketshell repos` discovery. (7 test files.)

#### Phase 3 — Agent Awareness (all deferred)

- Agent Detection — `AgentDetector`, `PocketshellAgentDetector`. Detects Claude
  Code, Codex, OpenCode in tmux panes. (2 test files.)
- Conversation View — `SessionReader` + parsers for Claude/Codex/OpenCode logs. (4 test files.)
- Agent Reply — `AgentMessenger`, `ReplyQueue`. (2 test files.)
- Slash Command Palette — `SlashCommandPalette`, `FuzzyMatcher`. (3 test files.)
- Agent Hooks — `HookManager`. (1 test file.)

#### Phase 4 — PocketShell Integration (all deferred)

- Usage Panel — `UsageClient` (`pocketshell usage`). (2 test files.)
- Jobs Management — `JobsClient` (`pocketshell jobs`). (2 test files.)
- Environment Management — `EnvClient` (`pocketshell env`). (1 test file.)
- Logs Viewer — `LogsClient` (`pocketshell logs`). (2 test files.)
- Bootstrap Helper — `BootstrapManager`, `VersionChecker`. (2 test files.)

#### Phase 5 — Polish (partially deferred)

- UI Theme — `ThemeManager`. Dense dark theme, status-bar indicators. (3 test files.)
- Settings Panel — `SettingsPanel`, `SettingsSection`. (4 test files.)
- E2E Test Suite — Playwright specs against a Docker SSH fixture. (9 spec files.)

### Test summary

Counts below are derived from the repo at this release (`find test/unit -name
'*.test.ts'`, `find test/e2e -name '*.spec.ts'`). "Test Cases" = the number of
`it(...)` / `test(...)` / `test.skip(...)` declarations, comment lines excluded;
1 `it.each(...)` table-driven case in `jobs-parser.test.ts` counts as 1
declaration.

| Category | Files | Test Cases (declarations) |
|----------|-------|---------------------------|
| Unit tests (Vitest) | 67 | 876 |
| E2E tests (Playwright) | 9 | 81 (78 active + 3 `test.skip`) |
| **Total** | **76** | **957** |

### Known limitations

- Linux-only end-to-end verification; Windows/macOS builds unverified.
- Cross-platform build pipeline (#35) committed but not yet proven by a green
  release run.
- Agent-aware, tmux, remote-file-editor, command-palette, and utility-panel
  modules are deferred.
- No auto-update; single SSH connection at a time; English only; single theme.

[Unreleased]: https://github.com/alexeygrigorev/pocketshell-desktop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alexeygrigorev/pocketshell-desktop/releases/tag/v0.1.0
