# PocketShell Desktop

Desktop fork of [PocketShell](https://github.com/alexeygrigorev/pocketshell) —
a terminal-first, agent-aware SSH client. Cross-platform (Windows first).

## Key docs

- [docs/plan.md](docs/plan.md) — v0.1.0 plan, architecture, phases
- [process.md](process.md) — orchestrator/implementer/reviewer process
- [agents.md](agents.md) — agent role definitions

## Tech stack

VS Code fork (TypeScript) + ssh2 + tmux -CC + Monaco + Playwright E2E.

## Working model

Same three-actor process as PocketShell Android: orchestrator + implementer +
reviewer. See [process.md](process.md) for the full playbook.

## v0.1.0 goal

Works on Windows end-to-end with all critical features from the mobile app.
All major scenarios E2E tested against a Docker SSH fixture.
