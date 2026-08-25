# PocketShell Desktop — Implementation Plan

Phased delivery. Each phase ends with: **unit tests green**, **integration
tests green against Docker**, and a **demo that works against the
`helper` container**. Phases are sequential; within a phase, work top-down
by dependency.

See [FEATURES.md](./FEATURES.md) for feature IDs and acceptance criteria,
[ARCHITECTURE.md](./ARCHITECTURE.md) for structure, and
[TESTING.md](./TESTING.md) for the test strategy.

---

## Phase 0 — Foundation + SSH core (P0)

**Delivers:** F1 (boot), F2 (SSH service), F3 (config/known_hosts),
F4 (IPC), F5 (Docker fixtures).

1. Scaffold the project (see `docs/ARCHITECTURE.md §2` for layout):
   - `package.json` with Electron, Vue 3, Vite (`electron-vite`), ssh2,
     ssh2-sftp-client, xterm.js, Monaco, Pinia, vue-router, electron-store,
     keytar; dev deps: typescript, vitest, `@playwright/test`,
     `testcontainers`, eslint, prettier.
   - `electron-builder.yml`, `vite.config.ts`, two `tsconfig.*.json`.
   - Main process opens a 1280×800 sandboxed window; preload exposes an
     empty typed `window.api`; renderer shows a "hello" Vue page.
2. `SshConfigParser` + `KnownHosts` (pure TS, fully unit-testable).
3. `SshService` + `ConnectionRegistry` + `ipc.ts` (connect/exec/tail/shell/close).
4. Docker fixtures: `Dockerfile.ssh`, `docker-compose.yml`, `test_key`.
5. Tests:
   - Unit: config parser, known_hosts matcher.
   - Integration (testcontainers → `ssh` image): connect ed25519,
     `whoami`→`testuser`, tail a file, shell round-trip.

**Exit criteria:** `npm run dev` boots; `npm test` (unit+integration)
passes against the `ssh` container; `window.api` has no Node reachable.

---

## Phase 1 — Host picker + session tree + attach terminal (P1)

**Delivers:** F6 (host picker), F7 (bootstrap), F8 (session tree),
F9 (terminal). **This is the headline flow from the request.**

1. `PocketshellClient` + `bootstrap.ts` + `parsers.ts` (sessions-list,
   resumable-table, usage, agent-log). All parsers pure + unit-tested
   against fixture strings copied from the source repo.
2. `HostPickerView` + `HostList`: reads `~/.ssh/config`, lists hosts,
   manual-add fallback, connect button.
3. `SessionTree`: `pocketshell sessions list --by activity` → tree; refresh;
   `pocketshell sessions create`.
4. `TerminalView` (xterm.js): SSH shell channel running `tmux attach -t
   '<name>'`; resize via `setWindow`; multi-terminal coexistence; clean
   detach on close.
5. `HostWorkspaceView` shell: tree rail + tabbed area (terminal tabs).
6. Docker: `Dockerfile.tmux`, `Dockerfile.helper` (real `pocketshell` via
   `uv tool install` + stub agents + fixtures).
7. Tests:
   - Unit: parsers, shell-quote.
   - Integration (→ `tmux`): create session, attach, `echo hi`, assert.
   - E2E (Playwright → `helper`): pick host → see sessions → click →
     type command → see output.

**Exit criteria:** the full core flow works against Docker end-to-end:
select host → session tree → click → terminal view → interact.

---

## Phase 2 — Files (P1)

**Delivers:** F10.

1. `SftpService` (list/read/write/mkdir/rename/delete/upload/download with
   progress).
2. `FilesView` + `FileTree` (lazy expand) + `FileEditor` (Monaco) +
   `ImagePreview`; drag-drop upload/download; confirm on overwrite/delete.
3. Tests:
   - Integration (→ `ssh`): round-trip a file, mkdir/rename/delete,
     upload 10MB.
   - E2E (→ `helper`): browse `~`, edit a file, verify via second
     `ssh exec cat`.

**Exit criteria:** full file CRUD + transfer against Docker.

---

## Phase 3 — Port forwarding (P2)

**Delivers:** F11, F12.

1. `Forwarder` (-L/-R/-D), `AutoForwarder`, `AutoForwarderSupervisor`,
   `PortScanner`.
2. `PortPanelView` + `ForwardTable` (type/local/remote/status/bytes/speed;
   add/remove/toggle/remap).
3. Persisted per-host forward config (electron-store).
4. Reconnect FSM: `flaky-helper` container kills ssh after Ns.
5. Tests:
   - Integration (→ `helper`): auto-forward a `python -m http.server`,
     `curl localhost:<port>`; `-R` and `-D` round-trips; `flaky-helper`
     reconnect.
   - E2E: forward a port and open it in a browser.

**Exit criteria:** all three forward types work and survive reconnect.

---

## Phase 4 — Agent awareness (P3 — all three selected)

**Delivers:** F14 (agent launcher), F15 (usage), F16 (env editor).
F13 and the resumable half of F14 were built and then **CUT** — see
docs/WORKSPACE.md §9 and FEATURES.md.

1. ~~`ConversationView`~~ — cut.
2. ~~Resumable picker~~ — cut. Agent launcher ships as the folder
   workspace's `+` menu: `projects:startSession` in the workspace's folder,
   then `pocketshell agent <kind>` into the new session.
3. `UsageView`: `pocketshell usage --json` → provider cards; foreground
   refresh.
4. Env panel: `pocketshell env list/get/set` for folders with
   `.env`/`.envrc`.
5. Tests:
   - Integration (→ `helper`): `usage --json` parses; `env list/get`.
   - E2E: usage cards populate, agent launch opens a terminal with the
     stubbed agent.

**Exit criteria:** the surviving agent features demonstrable against seeded
fixtures.

---

## Phase 5 — Hardening + packaging (P3)

**Delivers:** F17, F18, F19.

1. Reconnect reliability (sleep/wake, network changes).
2. Window-state persistence, recent hosts, keyboard nav, theme.
3. electron-builder: win (nsis), mac (dmg), linux (AppImage+deb).
4. CI (GitHub Actions): unit + integration on push; E2E on PR; release
   on tag.
5. Accessibility pass on the tree.

**Exit criteria:** installable app on all three platforms; CI green;
E2E runs headlessly in CI against the Docker fleet.

---

## Per-phase workflow

1. Write/extend the relevant `src/main/*` module + its unit tests first.
2. Add the IPC handler + preload surface.
3. Add the renderer view/component + Pinia store.
4. Add integration test against the matching Docker image.
5. Add/extend the E2E scenario.
6. Update `docs/` and `README.md` commands.
7. Run `scripts/smoke.sh` (compose up → unit + integration + E2E → down)
   as the phase gate.

## Out of scope (deferred)

- Voice input (Whisper), QR import — mobile-only.
- Full `tmux -CC` per-pane renderer — Phase 6+ opt-in.
- Real agent execution in automated tests — deterministic stubs only.
