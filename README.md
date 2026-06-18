# PocketShell Desktop

A desktop (Electron) port of [PocketShell](https://github.com/alexeygrigorev/pocketshell)
— a tmux-native, agent-aware SSH client. Where the Android app is a
voice-first phone cockpit, the desktop app is a keyboard-first workspace:
read your hosts from `~/.ssh/config`, browse the tmux session tree, click
into a terminal, edit files over SFTP, forward ports, and follow your AI
coding agents' conversations — all talking to the server-side `pocketshell`
helper on each dev box.

> **Status:** under active development. Phases 0–5 in
> [docs/PLAN.md](./docs/PLAN.md).

## What it does

- **Host picker** reads `~/.ssh/config` (with manual-add fallback) and
  honours `~/.ssh/known_hosts`.
- **Session tree** from `pocketshell sessions list`; click to attach a
  tmux session in a real terminal (`xterm.js`).
- **Files** — full SFTP: browse, edit (Monaco), upload/download,
  create/rename/delete.
- **Port forwarding** — local (`-L`), remote (`-R`), and dynamic SOCKS
  (`-D`), with auto-forward that mirrors remote listeners.
- **Agent awareness** — conversation view (`pocketshell agent-log`),
  resumable conversation picker, agent launcher, and a usage/quota
  dashboard (`pocketshell usage`).

## Docs

- [docs/ANALYSIS.md](./docs/ANALYSIS.md) — source-app analysis + the
  v0.4.8 helper contract.
- [docs/FEATURES.md](./docs/FEATURES.md) — feature backlog (P0–P3).
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — process model, module
  layout, terminal model, security.
- [docs/PLAN.md](./docs/PLAN.md) — phased implementation plan.
- [docs/TESTING.md](./docs/TESTING.md) — Docker E2E test strategy.

## Tech stack

Electron · Vue 3 + TypeScript · Vite (`electron-vite`) · `ssh2` ·
`xterm.js` · `ssh2-sftp-client` · Monaco · Pinia · electron-builder.
Tests: vitest · `testcontainers` · Playwright.

## Development

Prerequisites: Node 20+, npm, Docker (for integration/E2E tests).

```bash
npm install
npm run dev                 # launch the app with HMR

npm run test:unit           # pure-logic tests (no Docker)
npm run test:integration    # needs Docker (testcontainers)
npm run test:e2e            # needs Docker (compose + Playwright)
scripts/smoke.sh            # full Docker-backed gate
```

### Docker test fixtures

```bash
docker compose -f tests-docker/docker-compose.yml up -d --build helper

# sanity check the helper container
ssh -i tests-docker/test_key -p 3205 -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null testuser@127.0.0.1 \
  'pocketshell sessions list && pocketshell usage --json'

docker compose -f tests-docker/docker-compose.yml down --volumes --remove-orphans
```

The committed `tests-docker/test_key` is a fixture used only by Docker
tests.

## Build

```bash
npm run build               # build main + preload + renderer
npm run dist                # electron-builder → installers (win/mac/linux)
```

## Design principles (inherited from PocketShell)

- **No backwards-compatibility** — hard cuts only (D22). Greenfield codebase.
- **Zero provider credentials on the client** (D19) — usage/quota comes
  from the server-side helper; the desktop holds no API keys.
- **Long-running state lives on the remote** (tmux), the client reconnects.
- **Deterministic Docker tests** — never real hosts or real keys.

## License

MIT.
