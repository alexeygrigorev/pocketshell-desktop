# PocketShell Desktop — Testing

Four tiers, bottom-up. The guiding rule, inherited
from the Android project: **only deterministic Docker targets, never real
hosts or real provider credentials.**

---

## 1. Test tiers

| Tier | Runner | Target | Covers | When |
|---|---|---|---|---|
| **Unit** | vitest (node) | none (pure logic) | parsers, ssh-config, known_hosts, reconnect FSM logic, port-scanner parser, shell-quote | every push |
| **Integration** | vitest + `testcontainers` | ephemeral Docker port per test | SshService, SftpService, forwarder round-trips, helper-client | every push (requires Docker) |
| **E2E** | Playwright + Electron | fixed compose port (3205) | full UI flows: host pick → tree → terminal → files → conversation → usage | on PR + pre-release |
| **Manual smoke** | `scripts/smoke.sh` | compose fleet | brings everything up, runs unit+integration+E2E, tears down, prints summary | pre-release gate |

### Unit

Pure TypeScript, no network, no Docker. Fast (<2s). Covers anything that
transforms bytes → data:

- `SshConfigParser`: sample `~/.ssh/config` → `HostEntry[]` (Host,
  HostName, Port, User, IdentityFile, ProxyJump, ForwardAgent,
  LocalForward, RemoteForward, wildcards, `Include`).
- `KnownHosts`: matcher accepts/rejects; TOFU path returns "unknown".
- `parsers.ts`: `sessions list` table, `resumable` table, `usage --json`
  NDJSON — pinned to fixture strings copied
  from the source repo so shapes stay byte-identical.
- `AutoForwarder` port-resolution (mirror vs allocate), `PortScanner`
  output parsing (`ss`/`netstat` shapes).
- Reconnect FSM: given a fake clock + a scripted transport, assert the
  backoff sequence and the `reconnectNow` wake.

### Integration

`testcontainers` builds the Dockerfiles at test time and maps container 22
to an **ephemeral** host port, so tests are isolated and parallel-safe.
Each suite starts its own container. Docker is a required integration-test
prerequisite; collection fails loudly when the daemon is unavailable, so a
machine that ran no integration tests cannot report a misleading green suite.

Examples:

- `SshServiceIntegration`: connect with the committed `test_key` (ed25519)
  → `exec('whoami')` → assert `testuser`, exit 0. Then a non-zero-exit
  case (`exec('false')`) asserts exit 1 with no throw. Then a tail and a
  shell round-trip.
- `SftpIntegration`: `list /home/testuser`, write a file, read it back,
  mkdir/rename/delete, upload a 10MB file with progress.
- `ForwarderIntegration`: start `python -m http.server 8000` in the
  container via exec, auto-forward, `curl http://localhost:<local>` → 200;
  `-R` round-trip; `-D` SOCKS round-trip. The `flaky-helper` image proves
  reconnect.
  **Throughput**: every image from `:ssh` up also runs
  `tests-docker/traffic-server.py` on **8021** (started by the entrypoint,
  as `testuser` so `ss -tlnp` can attribute it). It answers
  `<up> <down> [chunk] [gap_ms]\n` by draining exactly `up` bytes and
  writing exactly `down`, optionally paced. Without it every listener in
  the fixture was idle, so the panel's In/Out columns could only read
  "0 B" and a bug in the byte counters or the rate maths was invisible.
  The suite asserts exact totals (65 557 out / 262 144 in) and a paced
  1 MiB download whose sampled `rateIn` must land near 512 KiB/s.
  **Rebuild the images after changing it** —
  `scripts/build-docker.sh`; the tests use the prebuilt tags.
- `Reconnect.integration`: against the `flaky` image, watch a REAL
  transport drop arrive as close-reason `lost` on a deterministic schedule,
  confirm the dead id is a hard unknown-id error, then re-dial the same
  sshd and round-trip `whoami`. Main's half of reconnect; the renderer FSM
  that decides WHEN to redial is unit-tested under fake timers
  (`connectionAutoReconnect.test.ts`).
- `HelperIntegration`: against the `helper` image, `pocketshell sessions
  list`, `usage --json` parse cleanly; `sessions
  create` then `sessions list` shows it. The env-editor round trip
  (FEATURES.md F16) rides here too: `env set` (a `{"KEY":"value"}` JSON
  object on the command's STDIN — never argv) writes a value containing
  quotes, dollars and `=`; `env list` shows the key `hasValue`;
  `env get` reads the exact value back; an explicit `--file .envrc` write
  lands where it was aimed.

### E2E

Playwright launches the **packaged** Electron app (built once per run)
against a fixed compose service on `127.0.0.1:3205`. Scenarios:

1. **Core terminal flow (Phase 1):** host picker lists the seeded
   `pocketshell-test` host → click → bootstrap completes → session tree
   shows seeded sessions → click one → terminal renders → type `echo hi`
   → assert visible output.
2. **Files (Phase 2):** open Files tab → browse `~` → open a seeded file
   → edit → save → reopen / second-channel `cat` shows the change.
3. **Forwards (Phase 3):** open Port panel → add a forward → curl it.
4. **Agents (Phase 4):** open a seeded session → Conversation tab renders
   messages → Usage tab shows cards.

Headless in CI; screenshots + traces on failure.

---

## 2. Local Docker instance

The standalone `instance` service is a disposable remote-like machine for
manual PocketShell demos and for testing host-scoped settings. It is separate
from the ephemeral fleet below, so it can stay running while unit or
testcontainer tests execute.

### Prerequisites

- Docker Desktop with **Linux containers** and Docker Compose v2.
- An OpenSSH client (`ssh` and `sftp`). Windows 10/11 normally includes it;
  check with `Get-Command ssh,sftp` in PowerShell.
- Node 20+ if you are running the Electron app from this checkout.
- Bash, Git Bash, or WSL for the `.sh` commands. PowerShell users can use the
  checked-in `.ps1` wrapper instead.

### Build and start

From the repository root, the Bash/Git Bash/WSL workflow is:

```bash
bash scripts/test-instance.sh build
bash scripts/test-instance.sh start
bash scripts/test-instance.sh status
```

The equivalent PowerShell command works even when local script execution is
restricted:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-instance.ps1 start
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-instance.ps1 status
```

`start` builds `pocketshell-test:instance` from
`tests-docker/Dockerfile.instance`, starts Compose service `instance`, and
waits for its in-container SSH healthcheck. The default host port is **3222**
so it does not collide with the test fleet's 3202–3206 ports. Override it for
one run with `POCKETSHELL_SSH_PORT=3322` (PowerShell:
`$env:POCKETSHELL_SSH_PORT = '3322'`).

The image includes OpenSSH + SFTP, `testuser`, tmux, git, Python 3, `curl`,
`ss`/`netstat`, the pinned `pocketshell` and `tmuxctl` helpers, deterministic
agent command stubs, and the byte-moving port-forward test responder. The
entrypoint creates `~/git` and `~/tmp`, then starts the `main` and `build`
tmux sessions. No provider credentials or network access are needed by the
stubs.

### Stop, reset, and inspect

```bash
bash scripts/test-instance.sh stop    # stop; preserve the remote home
bash scripts/test-instance.sh shell   # open /bin/sh as testuser
bash scripts/test-instance.sh logs    # follow sshd/fixture logs
bash scripts/test-instance.sh reset   # delete the home volume and start clean
```

The PowerShell wrapper accepts the same actions (`stop`, `shell`, `logs`, and
`reset`). The Compose volume `pocketshell-test-instance-home` preserves files
and helper state across `stop`/`start`; the entrypoint recreates the seed tmux
sessions after a container restart. `reset` is deliberately destructive and
removes that named volume before creating a clean instance. Use reset after
changing the image or when a test needs a pristine remote filesystem.

The raw Compose equivalent is:

```bash
docker compose --project-name pocketshell-local \
  --file tests-docker/docker-compose.instance.yml \
  up -d --build --wait instance
```

### Add the SSH alias

Add this block to `~/.ssh/config` (create the file if necessary):

```sshconfig
Host pocketshell-local
  HostName 127.0.0.1
  Port 3222
  User testuser
  IdentityFile C:/Users/<your-user>/git/pocketshell-electron/tests-docker/test_key
  IdentitiesOnly yes
```

Use a forward-slash absolute path on Windows. Git Bash/WSL can instead use
`/c/Users/<your-user>/git/pocketshell-electron/tests-docker/test_key`. The
committed `test_key` is intentionally only a local fixture; never use it for
AWS, Hetzner, or another real host. PocketShell will apply its normal TOFU
decision to the container's host key.

Verify the alias before opening the app:

```bash
ssh pocketshell-local 'whoami; command -v pocketshell; command -v tmuxctl; tmux list-sessions'
sftp pocketshell-local
```

Both commands should authenticate as `testuser`; the first should show the
`main` and `build` sessions. For a one-off command without editing SSH config,
use `-i tests-docker/test_key -p 3222 testuser@127.0.0.1`.

On Windows, if OpenSSH reports that the private key is too accessible, tighten
the fixture file's ACL from PowerShell:

```powershell
$key = (Resolve-Path .\tests-docker\test_key).Path
icacls $key /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

The repository normalizes the key to LF line endings. If the key was copied
outside Git, keep it as an OpenSSH private-key file and do not let an editor
convert it to a different format.

With the app built (`npm run build`) or running in dev mode (`npm run dev`),
select `pocketshell-local` in the host picker. Configure root folders there
when testing instance-specific settings; the alias is a separate host identity
from any Hetzner or AWS entry. The app reaches the same SSH/SFTP/tmux/helper
surface as a remote machine.

---

## 3. Docker fixtures (`tests-docker/`)

Mirror of the Android project's `tests/docker/`, adapted for the desktop
test runner.

### Images

- **`Dockerfile.ssh`** — Alpine + openssh-server/client, `ssh-keygen -A`,
  non-root `testuser` (password-locked, pubkey-only), sshd on 22
  foreground (`-D -e`), committed ed25519 `test_key` → `authorized_keys`,
  `sshd_config` with `AllowTcpForwarding yes`. Byte-for-byte port of the
  original base.
- **`Dockerfile.tmux`** — `FROM pocketshell-test:ssh` + `apk add tmux`.
- **`Dockerfile.helper`** — Alpine + tmux + git + python3 + uv, then
  `uv tool install pocketshell` (the **real** helper, so the test exercises
  the actual `pocketshell sessions list` / `usage` code
  paths). Plus `/bin/sh` stub binaries for `claude`/`codex`/`opencode`/
  `quse` (deterministic, no API keys).
- **`Dockerfile.flaky`** — `FROM pocketshell-test:ssh` + a chaos
  entrypoint (`flaky-entrypoint.sh`): every
  `PS_FLAKY_INTERVAL_SEC` (default 45) it kills the PER-CONNECTION sshd
  handlers — the processes OpenSSH re-titles `sshd: testuser@pts/0` — and
  only those. The listener survives, so a connected client sees a real
  transport drop while the next dial still succeeds. Consumed by
  `Reconnect.integration.test.ts` (interval tuned to 5s per run).

### Compose (`docker-compose.yml`)

| Service | Image | Host port → container | Purpose |
|---|---|---|---|
| `ssh` | `pocketshell-test:ssh` | `3202:22` | base SSH integration |
| `tmux` | `pocketshell-test:tmux` | `3204:22` | tmux attach integration + Phase 1 E2E |
| `helper` | `pocketshell-test:helper` | `3205:22` | **primary E2E target** — real helper + stub agents |
| `flaky` | `pocketshell-test:flaky` | `3206:22` | reconnect tests |

Shared healthcheck: in-container
`ssh -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /root/test_key testuser@localhost true`
(interval 2s, retries 10, start_period 5s).

### Fixtures (`tests-docker/fixtures/`)

The checked-in fixture files are small, credential-free inputs for the helper
stubs: `pocketshell-sessions-list.txt` and
`pocketshell-usage.ndjson`. The real helper is still installed and exercised;
the fixture files only make the provider stub deterministic.

### The `test_key`

Committed ed25519 keypair under `tests-docker/`. Used **only** by Docker
tests. Public half installed as `authorized_keys` in every image; private
half loaded by the integration tests via `SshKey.Path`.

---

## 4. Determinism rules

- Only Docker targets; never real hosts or real keys.
- Agent CLIs are stubs with canned output — no real provider credentials,
  no network calls (matches the Android `agents` fixture philosophy).
- Fixtures are byte-identical to real helper output so parser tests pin to
  the actual contract.
- E2E seeds a disposable host entry in the app's settings (not the user's
  real `~/.ssh/config`) and cleans it up after.

---

## 5. Commands

```bash
# Unit (no Docker)
npm run test:unit

# Integration (needs Docker)
npm run test:integration

# E2E (needs Docker; builds the app once)
npm run test:e2e

# Full Docker-backed smoke gate
scripts/smoke.sh

# Build the ephemeral fleet in dependency order, then bring up the E2E target
bash scripts/build-docker.sh
docker compose --project-name pocketshell-tests \
  -f tests-docker/docker-compose.yml up -d --wait helper
docker compose --project-name pocketshell-tests \
  -f tests-docker/docker-compose.yml down --volumes --remove-orphans

# Manual sanity check against the helper container
ssh -i tests-docker/test_key -p 3205 -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null testuser@127.0.0.1 \
  'pocketshell sessions list && pocketshell usage --json'
```

---

## 6. CI matrix (target)

GitHub Actions:

1. **on push:** `test:unit` (no Docker) + lint + typecheck.
2. **on PR:** build Docker fixtures, `test:integration`, build app,
   `test:e2e`. Upload Playwright traces + Docker logs on failure.
3. **on tag:** build installers (win/mac/linux) + upload as release
   artifacts.

Docker layer caching keeps the helper image rebuild cheap across runs.
