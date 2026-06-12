# Docker SSH Fixture for E2E Testing

Deterministic SSH server with tmux, agent stubs, and fixture data for
PocketShell Desktop end-to-end tests.

## Quick Start

```bash
# Build and start
docker compose up -d --build

# Wait for healthy
bash lib/wait-for-healthy.sh pocketshell-desktop-agents-1 60

# Verify
ssh -i test_key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -p 2222 testuser@localhost tmux list-sessions
```

## What's Inside

| Component | Purpose |
|-----------|---------|
| `openssh-server` | SSH access (key-only auth) |
| `tmux` | Session management (tested via `-CC` control mode) |
| `pocketshell` stub | Simulates all `pocketshell` subcommands |
| `claude`/`codex`/`opencode` stubs | Agent binary detection |
| Fixture data in `/opt/pocketshell-agent-fixtures/` | Pre-seeded session logs, jobs, usage stats |

## Ports

- **2222** → container port 22 (SSH)

## Auth

- User: `testuser`
- Key: `test_key` (Ed25519, unencrypted, **never use in production**)

## Teardown

```bash
docker compose down -v
```
