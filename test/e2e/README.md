# E2E Tests

Playwright end-to-end tests for PocketShell Desktop. Tests run against the
Docker SSH fixture, which provides a deterministic SSH server with tmux, agent
stubs, and fixture data.

## Prerequisites

- Node.js >= 18
- Docker and Docker Compose
- Playwright browsers installed (`npx playwright install`)

## Running Tests

### One-command run (starts fixture, runs tests, stops fixture)

The smoke tests automatically start/stop the Docker fixture if it is not already
running. Simply run:

```bash
npm run test:e2e
```

### With the Docker fixture already running

```bash
# Start the fixture manually
npm run test:docker:up

# Wait for it to be healthy (optional — tests also wait)
bash test/fixtures/docker/lib/wait-for-healthy.sh pocketshell-desktop-agents-1 60

# Run tests
npm run test:e2e

# Stop the fixture when done
npm run test:docker:down
```

### Headed mode

```bash
npm run test:e2e:headed
```

## Test Structure

```
test/e2e/
  smoke.spec.ts          # Docker fixture smoke tests
  helpers/
    docker-fixture.ts    # Start/stop Docker container
    app-launcher.ts      # Electron app launcher (stub)
    ssh-helpers.ts       # SSH exec and waitForSSH utilities
```

## Docker Fixture

The fixture lives in `test/fixtures/docker/` and provides:

| Component | Purpose |
|-----------|---------|
| `openssh-server` | SSH access on port 2222 |
| `tmux` | Session management |
| `pocketshell` stub | Simulates all `pocketshell` subcommands |
| `claude`/`codex`/`opencode` stubs | Agent binary detection |
| Fixture data | Pre-seeded session logs, jobs, usage stats |

**Auth:** user `testuser`, key `test/fixtures/docker/test_key` (Ed25519, unencrypted).
