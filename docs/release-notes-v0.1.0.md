# PocketShell Desktop v0.1.0

A terminal-first, agent-aware SSH client. PocketShell Desktop gives you a powerful remote development environment with built-in awareness of AI coding agents running on your servers.

Built as a VS Code fork with native SSH (ssh2), tmux control mode, Monaco Editor, and first-class integration with the PocketShell CLI.

## What's New

This is the inaugural release of PocketShell Desktop. It delivers the complete v0.1.0 feature set: SSH connection management, an integrated terminal with tmux support, remote file browsing and editing, AI agent detection and conversation interaction, and PocketShell CLI integration -- all tested end-to-end against a Docker SSH fixture.

## Features

### SSH Connection Management
- Persistent host storage with CRUD operations
- SSH key management (Ed25519, RSA)
- SSH config file import
- Connection pooling and automatic reconnect
- Auto-connect to last-used host on startup

### Integrated Terminal
- SSH-backed terminal via PTY channels
- xterm.js rendering with full ANSI support
- Terminal resize forwarding

### tmux Control Mode
- Full tmux `-CC` protocol implementation
- Session, window, and pane management
- Session creation, window splitting, pane navigation
- Detach and re-attach support

### Remote File Browser
- SFTP-based remote filesystem browsing
- File watching for change notifications
- Recursive directory traversal

### Remote File Editor
- View and edit remote files in Monaco Editor
- Save changes back to the remote host over SFTP
- Automatic language detection

### Git Integration
- Browse git repositories via `pocketshell repos`
- Status, log, branch, and blame views

### Agent Awareness
- Automatic detection of Claude Code, Codex, and OpenCode agents in tmux panes
- Conversation view for reading agent message history
- Reply-in-place to send messages directly to running agents
- Slash command palette with fuzzy matching
- Agent hook management for custom behavior

### PocketShell CLI Integration
- Usage panel showing token and cost data via `pocketshell usage`
- Jobs management via `pocketshell jobs`
- Environment variable viewer via `pocketshell env`
- Log streaming via `pocketshell logs`
- Bootstrap helper for CLI detection, installation, and upgrade

### UI
- Dense dark theme optimized for terminal workflows
- Connection status indicators in the status bar
- Settings panel with schema-driven sections
- PocketShell branding throughout

## Technical Details

### Architecture

PocketShell Desktop is built on the VS Code editor framework. It does not bundle VS Code source -- instead, it clones VS Code at build time and applies PocketShell branding via `product.json`. The application communicates with remote hosts over SSH using the `ssh2` Node.js library. There is no VS Code Server component on the remote side.

| Layer | Technology |
|-------|-----------|
| Editor framework | VS Code (forked at build time) |
| SSH transport | ssh2 (Node.js) |
| Terminal emulation | xterm.js |
| tmux integration | Custom `-CC` protocol parser |
| File operations | SFTP over ssh2 |
| Code editor | Monaco Editor |
| Unit testing | Vitest |
| E2E testing | Playwright |
| CI/CD | GitHub Actions |

### Test Coverage

| Category | Files | Test Cases |
|----------|-------|------------|
| Unit tests (Vitest) | 73 | 865 |
| E2E tests (Playwright) | 8 | 89 |
| **Total** | **81** | **954** |

E2E tests run against a Docker SSH fixture with pre-configured agent stubs, tmux, and test data.

### Source Statistics

- 107 TypeScript source files across 17 modules
- 37 exported classes
- MIT licensed
- Extensions served from OpenVSX (not Microsoft Marketplace)

## Known Limitations

The following features are not included in v0.1.0 and are planned for future releases:

- **Auto-update** -- no automatic application update mechanism
- **Port forwarding UI** -- SSH port forwarding is not exposed in the UI
- **SCP support** -- file transfers use SFTP only
- **Multi-host sessions** -- single SSH connection at a time
- **Plugin system** -- no third-party extension support beyond OpenVSX
- **Mobile companion** -- no integration with PocketShell Android
- **Configurable themes** -- only the built-in PocketShell Dark theme
- **Localization** -- English only

## System Requirements

- **Operating System:** Windows 10 or later (primary), macOS 12+, Linux (x64)
- **Node.js:** 24.15.0 or later (build time only)
- **Remote host:** SSH server with tmux 3.2+ for full feature set
- **Optional:** PocketShell CLI on the remote host for integration features

## Installation

### Windows

1. Download `pocketshell-0.1.0-win32-x64-setup.exe` from the [release assets](https://github.com/alexeygrigorev/pocketshell-desktop/releases/tag/v0.1.0)
2. Run the installer
3. Launch PocketShell from the Start Menu

### macOS

1. Download `pocketshell-0.1.0-darwin-arm64.dmg` (Apple Silicon) or `pocketshell-0.1.0-darwin-x64.dmg` (Intel) from the [release assets](https://github.com/alexeygrigorev/pocketshell-desktop/releases/tag/v0.1.0)
2. Open the DMG and drag PocketShell to Applications
3. Launch PocketShell from Applications or Spotlight

### Linux

1. Download `pocketshell-0.1.0-linux-x64.tar.gz` from the [release assets](https://github.com/alexeygrigorev/pocketshell-desktop/releases/tag/v0.1.0)
2. Extract: `tar xzf pocketshell-0.1.0-linux-x64.tar.gz`
3. Run: `./pocketshell`

## Contributing

PocketShell Desktop uses a three-actor development process: Orchestrator, Implementer, and Reviewer. See the following documents for details:

- [Development process](../process.md)
- [Agent role definitions](../agents.md)
- [Project plan](plan.md)

## Full Changelog

See [CHANGELOG.md](../CHANGELOG.md) for the complete changelog organized by development phase.
