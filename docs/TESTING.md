# PocketShell Desktop — Testing

Four tiers, bottom-up. Every phase in [PLAN.md](./PLAN.md) must pass its
unit + integration tests before its E2E demo. The guiding rule, inherited
from the Android project: **only deterministic Docker targets, never real
hosts or real provider credentials.**

---

## 1. Test tiers

| Tier | Runner | Target | Covers | When |
|---|---|---|---|---|
| **Unit** | vitest (node) | none (pure logic) | parsers, ssh-config, known_hosts, reconnect FSM logic, port-scanner parser, shell-quote | every push |
| **Integration** | vitest + `testcontainers` | ephemeral Docker port per test | SshService, SftpService, forwarder round-trips, helper-client | every push (auto-skip if Docker absent) |
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
Each suite starts its own container. **Auto-skips** when Docker is not
available (same `assumeTrue(dockerAvailable)` pattern as the Android JVM
suite) so CI without Docker still runs unit tests.

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
- `HelperIntegration`: against the `helper` image, `pocketshell sessions
  list`, `usage --json` parse cleanly; `sessions
  create` then `sessions list` shows it.

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

## 2. Docker fixtures (`tests-docker/`)

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
  `quse` (deterministic, no API keys) and seeded agent logs under
  `~/.claude/projects/`, `~/.codex/sessions/`, `~/.local/share/opencode/`.
- **`Dockerfile.flaky`** — `helper` + a `ForceCommand` watcher that kills
  the ssh child after `FLAKY_DISCONNECT_AFTER_SEC` (default 8) to exercise
  reconnect.

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

Copied from the source repo's `tests/docker/agent-fixtures/` so output
shapes match the parsers exactly:

- `claude-session.jsonl`, `codex-session.jsonl`, `opencode-rows.jsonl`
  (seeded under canonical paths by the helper image entrypoint).
- `pocketshell-usage.ndjson`, `pocketshell-sessions-list.txt`,
  `pocketshell-jobs-list.txt`.

### The `test_key`

Committed ed25519 keypair under `tests-docker/`. Used **only** by Docker
tests. Public half installed as `authorized_keys` in every image; private
half loaded by the integration tests via `SshKey.Path`.

---

## 3. Determinism rules

- Only Docker targets; never real hosts or real keys.
- Agent CLIs are stubs with canned output — no real provider credentials,
  no network calls (matches the Android `agents` fixture philosophy).
- Fixtures are byte-identical to real helper output so parser tests pin to
  the actual contract.
- E2E seeds a disposable host entry in the app's settings (not the user's
  real `~/.ssh/config`) and cleans it up after.

---

## 4. Commands

```bash
# Unit (no Docker)
npm run test:unit

# Integration (needs Docker)
npm run test:integration

# E2E (needs Docker; builds the app once)
npm run test:e2e

# Full Docker-backed smoke gate
scripts/smoke.sh

# Bring fixtures up / down by hand
docker compose -f tests-docker/docker-compose.yml up -d --build helper
docker compose -f tests-docker/docker-compose.yml down --volumes --remove-orphans

# Manual sanity check against the helper container
ssh -i tests-docker/test_key -p 3205 -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null testuser@127.0.0.1 \
  'pocketshell sessions list && pocketshell usage --json'
```

---

## 5. CI matrix (target)

GitHub Actions:

1. **on push:** `test:unit` (no Docker) + lint + typecheck.
2. **on PR:** build Docker fixtures, `test:integration`, build app,
   `test:e2e`. Upload Playwright traces + Docker logs on failure.
3. **on tag:** build installers (win/mac/linux) + upload as release
   artifacts.

Docker layer caching keeps the helper image rebuild cheap across runs.
