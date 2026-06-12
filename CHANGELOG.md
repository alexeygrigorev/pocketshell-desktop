# Changelog

All notable changes to PocketShell Desktop are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-06-12

### Phase 1: Connection & Terminal

#### SSH Connection Management
- **Classes:** `SshClient`, `ConnectionManager`, `ConnectionPool`, `HostStore`, `KeyStore`
- **Description:** Full SSH lifecycle management using the `ssh2` library. Host CRUD with persistent storage (`HostStore`), Ed25519/RSA key management (`KeyStore`), connection pooling, automatic reconnect on failure, and SSH config file parsing for importing existing host definitions.
- **Tests:** 4 test files (`host-store`, `key-store`, `ssh-client`, `ssh-config-parser`)

#### Auto-Connect
- **Classes:** `AutoConnectService`
- **Description:** Connects to the configured default host on application startup. Reads the last-used host from `SettingsStore` and initiates the SSH session automatically.
- **Tests:** 2 test files (`auto-connect`, `settings`)

#### Integrated Terminal
- **Classes:** `TerminalManager`, `SshTerminalBackend`, `PtyAdapter`
- **Description:** Terminal emulation backed by an SSH PTY channel. Input keystrokes are forwarded over SSH; output is rendered through xterm.js. Supports resize events, terminal themes, and copy/paste.
- **Tests:** 3 test files (`ssh-terminal-backend`, `ssh-terminal-integration`, `terminal-manager`)

#### tmux Control Mode Client
- **Classes:** `TmuxClient`, `TmuxEventStream`, `TmuxSessionManager`
- **Description:** Full tmux `-CC` control mode protocol implementation. Parses the tmux wire protocol (notifications, layout changes, output), maintains session/window/pane state, and provides a snapshot builder for rendering the tmux session tree. Supports session creation, window splitting, pane navigation, and detach.
- **Tests:** 7 test files (`client`, `parser`, `state`, `stream`, `snapshot-builder`, `tmux-session-integration`, `tmux-session-manager`)

#### Command Registry
- **Classes:** `CommandRegistry`, `CommandChipRegistry`
- **Description:** Central command registration system. Binds commands to keybindings, provides discoverable command chips for the UI, and generates keybinding entries for the editor.
- **Tests:** 4 test files (`chips`, `command-registry`, `keybinding-generator`, `snippets`)

### Phase 2: Remote File Access

#### SFTP File Browser
- **Classes:** `FileBrowser`, `SftpClient`, `RemoteFileWatcher`
- **Description:** Browse the remote filesystem over SFTP. Directory listing with file type/size/permissions, file watching for change notifications, and recursive directory traversal. SFTP connections are pooled and reused.
- **Tests:** 4 test files (`file-browser`, `file-watcher`, `sftp-client`, `sftp-integration`)

#### Remote File Editor
- **Classes:** `DocumentManager`, `RemoteDocument`, `RemoteSaveManager`
- **Description:** View and edit remote files in Monaco Editor. Documents are loaded over SFTP, tracked for dirty state, and saved back to the remote host. Language detection based on file extension and content heuristics.
- **Tests:** 4 test files (`document-manager`, `language-detection`, `remote-document`, `save-manager`)

#### Git Repository Browser
- **Classes:** `GitClient`, `PocketShellRepos`
- **Description:** Execute git commands over SSH to browse repository status, log, branches, and blame. Integrates with the `pocketshell repos` command for discovering git repositories on the remote host. Parsers for git status, log, branch, and blame output.
- **Tests:** 7 test files (`blame-parser`, `branch-parser`, `git-client`, `git-integration`, `log-parser`, `pocketshell-repos`, `status-parser`)

### Phase 3: Agent Awareness

#### Agent Detection
- **Classes:** `AgentDetector`, `PocketshellAgentDetector`
- **Description:** Detects running AI coding agents (Claude Code, Codex, OpenCode) in tmux panes by inspecting process lists and pane titles. Fires events when agents start and stop.
- **Tests:** 2 test files (`agent-detector`, `pocketshell-detector`)

#### Conversation View
- **Classes:** `SessionReader`, conversation parsers (Claude, Codex, OpenCode)
- **Description:** Reads agent conversation logs from the remote host. Parses JSONL and structured log formats for each supported agent. Displays human/assistant message pairs in a conversation panel.
- **Tests:** 4 test files (`claude-parser`, `codex-parser`, `opencode-parser`, `session-reader`)

#### Agent Reply
- **Classes:** `AgentMessenger`, `ReplyQueue`
- **Description:** Send replies to agent conversations from the conversation panel. Messages are queued and delivered over the SSH channel to the agent's stdin.
- **Tests:** 2 test files (`agent-messenger`, `reply-queue`)

#### Slash Command Palette
- **Classes:** `SlashCommandPalette`, `FuzzyMatcher`
- **Description:** Agent-aware command palette for slash commands. Includes built-in agent commands, config commands, and session commands. Fuzzy matching for command discovery.
- **Tests:** 3 test files (`builtin-commands`, `command-palette`, `fuzzy-matcher`)

#### Agent Hooks
- **Classes:** `HookManager`
- **Description:** Install, manage, and report status of agent hook scripts on the remote host. Hooks allow custom behavior when agents start, stop, or produce output.
- **Tests:** 1 test file (`hook-manager`)

### Phase 4: PocketShell Integration

#### Usage Panel
- **Classes:** `UsageClient`
- **Description:** Integrates with `pocketshell usage` to display token and cost usage for AI agent sessions. Parses NDJSON usage output.
- **Tests:** 2 test files (`usage-client`, `usage-parser`)

#### Jobs Management
- **Classes:** `JobsClient`
- **Description:** Integrates with `pocketshell jobs` to list, monitor, and manage background agent jobs on the remote host.
- **Tests:** 2 test files (`jobs-client`, `jobs-parser`)

#### Environment Management
- **Classes:** `EnvClient`
- **Description:** Integrates with `pocketshell env` to view and manage environment variables for agent sessions.
- **Tests:** 1 test file (`env-client`)

#### Logs Viewer
- **Classes:** `LogsClient`
- **Description:** Integrates with `pocketshell logs` to stream and display agent session logs.
- **Tests:** 2 test files (`logs-client`, `log-parser`)

#### Bootstrap Helper
- **Classes:** `BootstrapManager`, `VersionChecker`
- **Description:** Detects whether the `pocketshell` CLI is installed on the remote host, checks version compatibility, and assists with installation or upgrade.
- **Tests:** 2 test files (`bootstrap-manager`, `version-checker`)

### Phase 5: Polish & Release

#### UI Theme
- **Classes:** `ThemeManager`
- **Description:** Dense dark theme optimized for terminal-first workflows. Custom color palette, status bar indicators (connection status dots), and PocketShell branding elements.
- **Tests:** 3 test files (`branding`, `status-dots`, `theme-manager`)

#### Settings Panel
- **Classes:** `SettingsPanel`, `SettingsSection`
- **Description:** Settings UI with schema-driven sections for SSH hosts, terminal preferences, tmux configuration, and agent integration options. Settings are serialized to the application data directory.
- **Tests:** 4 test files (`settings-panel`, `settings-schema`, `settings-section`, `settings-serializer`)

#### E2E Test Suite
- **Description:** Playwright E2E tests running against a Docker SSH fixture with pre-configured agent stubs. Covers all critical user scenarios: connection lifecycle, auto-connect, terminal interaction, file browsing, agent detection, utility commands, and bootstrap.
- **Tests:** 8 spec files (`smoke`, `connection-lifecycle`, `auto-connect`, `terminal`, `files`, `agent-detection`, `utility`, `bootstrap`)

#### CI/CD Pipeline
- **Description:** GitHub Actions CI runs on every push to `main` and every PR. Jobs: lint, build (Windows/macOS/Linux matrix), unit tests, E2E tests against Docker fixture. Release workflow triggers on `v*` tags, builds platform-specific installers, and creates a GitHub Release.

### Test Summary

| Category | Files | Test Cases |
|----------|-------|------------|
| Unit tests (Vitest) | 73 | 865 |
| E2E tests (Playwright) | 8 | 89 |
| **Total** | **81** | **954** |

[0.1.0]: https://github.com/alexeygrigorev/pocketshell-desktop/releases/tag/v0.1.0
