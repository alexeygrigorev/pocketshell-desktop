# PocketShell Desktop

A terminal-first, agent-aware desktop SSH client for the developer workstation
you already use — a desktop companion to
[PocketShell Android](https://github.com/alexeygrigorev/pocketshell).

## Vision

PocketShell Desktop brings the PocketShell experience to the desktop: a
terminal-focused IDE that connects to remote environments via SSH, integrates
with tmux, surfaces AI agent conversations, and lets you view, edit, and
comment on code — all through the `pocketshell` server-side utility.

Unlike VS Code's Remote SSH (which ships a full VS Code server to the remote),
PocketShell Desktop stays thin: the heavy lifting happens on the dev box through
the same `pocketshell` helper, tmux sessions, and agent infrastructure that the
Android app already uses.

## Status

Pre-development. Planning and issue tracking in progress.

## Key Features (Planned)

- **SSH connection management** — save hosts, keys, connect to remote dev boxes
- **Integrated terminal** — xterm.js with tmux -CC control mode
- **Code viewer and editor** — Monaco editor for remote file viewing/editing
- **Project tree** — file explorer for remote project directories
- **Agent awareness** — detect Claude Code, Codex, OpenCode; conversation view
- **PocketShell utility integration** — usage, env, jobs, repos, hooks, logs
- **Orchestrator/Implementer/Reviewer process** — built-in agent workflow
- **Dark, dense dev-tool UI** — same design language as the Android app

## Architecture (Planned)

```text
Desktop app (Electron + React)   SSH           Dev box
┌─────────────────────┐          ─────────>    ┌──────────────────┐
│ Terminal (xterm.js) │    ssh2 / SSH exec     │ tmux server      │
│ Code (Monaco)       │  ──────────────────>   │ pocketshell CLI  │
│ File tree           │  SFTP / exec           │ agent logs       │
│ Conversation view   │  tail JSONL/SQLite     │ code / projects  │
└─────────────────────┘                        └──────────────────┘
```

## Tech Stack (Planned)

| Layer | Choice | Why |
|---|---|---|
| Runtime | Electron | Cross-platform desktop, xterm.js, Monaco out of the box |
| UI | React + TypeScript | Large ecosystem, familiar |
| Terminal | xterm.js | Industry standard, battle-tested |
| Code editor | Monaco Editor | VS Code's editor core |
| SSH | ssh2 (Node.js) | Actively maintained, full SSH/SFTP support |
| Storage | SQLite (better-sqlite3) | Local host/config storage |

## Repository Layout (Planned)

```
pocketshell-desktop/
  src/
    main/              # Electron main process
    renderer/          # React UI
      components/      # UI components
        terminal/      # xterm.js wrapper
        editor/        # Monaco wrapper
        file-tree/     # Remote file explorer
        conversation/  # Agent conversation view
        hosts/         # SSH host management
    shared/            # Shared utilities
      ssh/             # SSH connection management
      tmux/            # tmux -CC protocol parser
      agents/          # Agent detection/parsers
      pocketshell/     # Server-side helper client
  docs/                # Planning and architecture docs
  .claude/             # Agent configurations
```

## Related

- [PocketShell Android](https://github.com/alexeygrigorev/pocketshell) — the mobile app
- [pocketshell PyPI](https://pypi.org/project/pocketshell/) — the server-side helper

## License

Private / TBD
