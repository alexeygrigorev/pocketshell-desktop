# PocketShell Desktop — v0.1.0 Plan

## Goal

Ship a **cross-platform desktop application** (Windows first) that brings the
PocketShell Android experience to the desktop: a terminal-first IDE that
connects to remote dev boxes via SSH, integrates with tmux, surfaces AI agent
conversations, and uses the `pocketshell` server-side helper.

## Architecture Decision: VS Code Fork

**Decision: Fork VS Code** (like Cursor, Windsurf).

### Why fork, not plugin or from-scratch Electron?

| Option | Pros | Cons |
|---|---|---|
| **VS Code fork** ✅ | Full control over UI; editor+terminal+extensions "free"; cross-platform; familiar UX; can embed tmux control mode natively; can auto-connect on startup without user setup | Large codebase to maintain; upstream sync effort |
| VS Code extension | No fork maintenance; small codebase | Limited control over chrome/navigation; can't auto-connect on startup seamlessly; can't replace remote SSH internals; extension API constraints |
| From-scratch Electron | Full control; small codebase | Reimplementing Monaco, xterm, file tree, settings, keybindings, extension host = months of work; not VS Code compatible |

### What we keep from VS Code

- Monaco editor (code viewing/editing)
- Integrated terminal (xterm.js)
- File explorer (adapted for remote via SFTP)
- Extension host (VS Code extensions still work)
- Settings system
- Key bindings
- Command palette
- Cross-platform build (Windows/macOS/Linux)

### What we replace/add

- **Remote connection**: Replace VS Code Remote SSH with PocketShell's approach
  (direct SSH via ssh2, tmux -CC control mode, no VS Code server on remote)
- **Auto-connect**: On startup, auto-connect to last-used host
- **tmux integration**: Native tmux -CC session/window/pane management in
  sidebar; pane-per-tab model instead of VS Code's terminal instances
- **Agent awareness**: Claude Code / Codex / OpenCode detection and
  conversation view as a first-class panel
- **PocketShell utility**: Integrated usage, env, jobs, repos, hooks, logs
  panels driven by the server-side `pocketshell` helper
- **Dense dark UI**: PocketShell design language (always-dark, dense rows,
  status dots, minimal chrome)
- **Project tree**: Remote project tree via SFTP (no VS Code server needed)

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Base | VS Code fork (MIT) | Editor, terminal, extensions, cross-platform for free |
| Language | TypeScript | VS Code's language |
| SSH | ssh2 (Node.js) | Full SSH/SFTP support, actively maintained |
| tmux | Custom `-CC` protocol parser | Port from Android's `core-tmux` Kotlin → TypeScript |
| Agent parsers | Port from Android's `core-agents` | Claude JSONL, Codex JSONL, OpenCode SQLite parsers |
| Storage | SQLite (better-sqlite3) | Local host/key/config storage |
| Testing | Playwright (E2E) + Vitest (unit) | Playwright drives the Electron app; Vitest for pure logic |
| CI | GitHub Actions | Build + test on Windows/macOS/Linux |

## Remote Architecture

```text
Desktop app (VS Code fork)         SSH (ssh2)           Dev box
┌─────────────────────────┐        ──────────>         ┌──────────────────┐
│ Editor (Monaco)         │   SFTP read/write          │ filesystem       │
│ Terminal (xterm.js)     │   tmux -CC control mode    │ tmux server      │
│ File explorer           │   exec (pocketshell *)     │ pocketshell CLI  │
│ Agent conversation      │   tail JSONL/SQLite        │ agent logs       │
│ Usage / Jobs / Env      │   exec (pocketshell *)     │                  │
└─────────────────────────┘                             └──────────────────┘
```

**No VS Code server on the remote.** The desktop app talks SSH directly.
File operations go through SFTP. Commands go through SSH exec.
tmux integration uses the -CC control mode protocol.

## E2E Testing Strategy

Mirrors the Android app's Docker+emulator approach:

- **Docker fixture**: Same deterministic SSH server as Android tests
  (`tests/docker/` from the PocketShell repo), running on `localhost:2222`
  with `pocketshell` helper, `claude`/`codex` stubs, `tmux`, `gh` shim
- **Playwright**: Drives the Electron app through real user scenarios
  (connect to localhost:2222, browse files, open terminal, detect agent, etc.)
- **CI matrix**: Windows + macOS + Linux on GitHub Actions
- **Test fixtures**: Deterministic agent JSONL logs, fake `pocketshell` output,
  pre-seeded tmux sessions in the Docker container

### Test categories

1. **Unit tests** (Vitest): SSH connection logic, tmux protocol parser, agent
   parsers, settings management
2. **Integration tests**: SSH+SFTP against Docker fixture, tmux -CC against
   Docker tmux, pocketshell commands against Docker
3. **E2E tests** (Playwright): Full user flows — connect, browse, edit, terminal,
   agent detection, conversation view, settings

## v0.1.0 Scope

### In scope

All critical scenarios from the PocketShell Android feature inventory:

- **Connection**: Host management, SSH connect/reconnect, bootstrap helper,
  auto-connect on startup
- **Terminal**: Live terminal, tmux -CC pane/window/session management,
  key bindings, snippets
- **File Management**: Remote file browser, file viewer/editor, git repo browsing
- **Agent**: Auto-detection, conversation view, reply-in-place, search
- **PocketShell Utility**: Usage panel, session list, jobs, agent logs, hooks
- **Navigation**: Breadcrumb, dashboard, tab switching, settings
- **E2E tests**: All above scenarios tested against Docker fixture

### Out of scope for v0.1.0

- Voice input (desktop has a real keyboard)
- QR import/export (desktop can use SSH config import)
- Port forwarding UI (use command line)
- Mobile-specific features (biometric, touch gestures, haptic)
- Mosh support
- In-app assistant (the app IS the assistant workspace)

## Phases

### Phase 0: Project Scaffolding
- Fork VS Code, set up build system
- Create project structure, CI pipeline
- Docker test fixture (reuse from PocketShell Android)
- Playwright E2E harness

### Phase 1: Connection & Terminal
- SSH connection management (ssh2)
- Host CRUD (save/edit/delete hosts)
- Auto-connect on startup
- Integrated terminal (xterm.js → SSH PTY)
- tmux -CC control mode client
- Session/window/pane management

### Phase 2: Remote File Access
- SFTP file browser (file explorer panel)
- File viewer (Monaco, read-only first)
- File editor (Monaco, write back via SFTP)
- Git repo browsing via `pocketshell repos`

### Phase 3: Agent Awareness
- Agent detection (Claude/Codex/OpenCode)
- Conversation view panel
- Reply-in-place to agent
- Agent slash-command palette
- Hook install/status

### Phase 4: PocketShell Integration
- Usage panel (`pocketshell usage`)
- Jobs management (`pocketshell jobs`)
- Env management (`pocketshell env`)
- Logs viewer (`pocketshell logs`)
- Bootstrap helper (detect/install/upgrade)

### Phase 5: Polish & Release
- Dense dark UI theme
- Settings screen
- E2E test coverage for all scenarios
- Windows installer
- v0.1.0 tag and release

## Repository Layout

```
pocketshell-desktop/
  src/
    vs/                   # VS Code source (from fork)
    pocketshell/          # Our additions
      connection/         # SSH host management, auto-connect
      terminal/           # tmux -CC integration, pane management
      files/              # Remote file browser via SFTP
      agents/             # Agent detection, conversation view
      pocketshell/        # Server-side helper client
      usage/              # Usage/quota panel
      jobs/               # Jobs management
      env/                # .env/.envrc management
      settings/           # PocketShell-specific settings
  test/
    unit/                 # Vitest unit tests
    integration/          # SSH/tmux/pocketshell integration tests
    e2e/                  # Playwright E2E tests
    fixtures/             # Docker compose, seed data
  docs/                   # Plan, architecture, process
  scripts/                # Build, test, release scripts
  .claude/                # Agent configurations
```

## Release Criteria for v0.1.0

- [ ] App launches on Windows and auto-connects to configured host
- [ ] Terminal works: can type, see output, use tmux sessions/windows/panes
- [ ] File browser works: can navigate remote filesystem, view/edit files
- [ ] Agent detection works: Claude Code detected in tmux pane
- [ ] Conversation view works: can read and reply to agent conversation
- [ ] PocketShell utility integration: usage, jobs, env commands work
- [ ] All critical E2E scenarios pass against Docker fixture
- [ ] CI green on Windows + macOS + Linux
- [ ] Windows installer produced
