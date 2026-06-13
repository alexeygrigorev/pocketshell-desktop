# Getting Started (Contributors)

This guide walks a new contributor through cloning, building, running, and testing
PocketShell Desktop end-to-end. Every command below is verified against the actual
scripts and `package.json` — copy-paste them as-is.

> **Read first:** [../README.md](../README.md) for the project overview, and
> [../agents.md](../agents.md) for current project state. This project follows a
> mandatory [three-actor process](../process.md) (orchestrator → implementer →
> reviewer); see that doc before opening a PR.

---

## 1. Prerequisites

- **Node.js v24.15.0+** — VS Code 1.125 requires Node 24. The build script enforces
  this. Use [nvm](https://github.com/nvm-sh/nvm): `nvm install 24.15.0`.
- **Git** — used to clone the VS Code source into `vendor/vscode/` at build time.
- **Linux build deps** (for native modules like libsecret):

  ```bash
  sudo apt-get install -y libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev
  ```

- **Docker** — only needed to run the E2E SSH fixture (section 6).
- **Xvfb** — only on a headless Linux box, to launch the Electron GUI:
  `sudo apt-get install -y xvfb`.

> **Disk space:** the VS Code source + `node_modules` + Electron binary is roughly
> **2 GB+** under `vendor/vscode/`. Make sure you have ample free space — a
> truncated Electron download silently segfaults on launch (see lesson #13 in
> agents.md).

---

## 2. Clone the repo and install deps

```bash
git clone https://github.com/alexeygrigorev/pocketshell-desktop.git
cd pocketshell-desktop
npm install
```

`npm install` installs the root dev dependencies: Vitest, Playwright, TypeScript,
ssh2, and type definitions. The heavy VS Code dependency tree is installed in the
next step (inside `vendor/vscode/`).

Note: the VS Code source at `vendor/vscode/` is **gitignored** — it does not come
with the clone. `scripts/build-base.sh` will create it.

---

## 3. Build the VS Code base (one-time, heavy)

```bash
bash scripts/build-base.sh
```

This is the slow, one-time step. It:

1. Clones/downloads VS Code v1.125.0 source into `vendor/vscode/` (if absent — the
   script expects it present; see note below).
2. Copies `product.json` (PocketShell branding) into `vendor/vscode/product.json`.
3. Runs `npm install` inside `vendor/vscode/` if `node_modules/` is missing.
4. Downloads the Electron binary into `vendor/vscode/.build/electron/`.
5. Compiles the VS Code core: `npm run gulp compile` (dev mode — skips bundling
   and packaging for speed).

> **Note on the VS Code source:** `scripts/build-base.sh` operates on
> `vendor/vscode/` but expects the source to be cloned there first. The CI workflow
> (`.github/workflows/release.yml`) clones it via `git clone` pinned to a specific
> VS Code commit. Locally, clone it yourself before running `build-base.sh`:
>
> ```bash
> mkdir -p vendor
> git clone https://github.com/microsoft/vscode.git vendor/vscode
> ```
>
> See [agents.md](../agents.md) for the exact pinned commit.

For a **production build** (bundling + packaging for distribution) of the current
platform instead of a dev build:

```bash
bash scripts/build-base.sh --production
# or pin platform/arch:
bash scripts/build-base.sh --production --platform linux --arch x64
```

---

## 4. Build the PocketShell extension (fast)

```bash
bash scripts/build-extension.sh
```

This recompiles **only** the PocketShell extension — it takes seconds, not minutes.
It:

1. rsyncs `extensions/pocketshell/` → `vendor/vscode/extensions/pocketshell/`
   (excluding `node_modules/`, `out/`, lockfiles).
2. Installs the extension's npm dependencies (`npm install --production`) if missing.
3. Runs `npm run gulp compile-extension:pocketshell` (with a `tsc` fallback).

You only need `scripts/build-base.sh` once; use `build-extension.sh` for every
iteration afterwards.

---

## 5. Run the dev app

```bash
bash scripts/dev.sh
```

`dev.sh` is the one-command dev launcher. It re-syncs the extension, recompiles it
if `out/` is missing, then launches the Electron app via
`vendor/vscode/scripts/code.sh` with `--user-data-dir .dev-data/` so all config,
logs, and storage are isolated under the project's `.dev-data/` directory (not your
home folder).

**On a headless Linux box**, run it under Xvfb:

```bash
xvfb-run -a bash scripts/dev.sh
```

### Iterating after changes

1. Edit source under `extensions/pocketshell/` (and/or `src/` backend modules that
   get copied into the extension).
2. Rebuild the extension:

   ```bash
   bash scripts/build-extension.sh
   ```

3. In the running app, press **Ctrl+R** to reload the window. The extension host
   restarts and picks up your changes — no full app restart needed.

To forward extra args to the underlying `code.sh` launcher:

```bash
bash scripts/dev.sh --verbose
```

### What "works" looks like

Per [agents.md](../agents.md) (end-to-end verified 2026-06-13 on Linux): the app
launches (under Xvfb, no crash within ~12s), shows "Synchronizing built-in
extensions…", the PocketShell extension activates (all commands registered, no
errors in the exthost log), you can add a host, connect over SSH, and open a
terminal that runs remote commands and an interactive shell.

---

## 6. Run the Docker SSH fixture (for E2E tests)

E2E tests need a deterministic SSH server on `localhost:2222` with tmux, the
`pocketshell` helper, and agent (`claude`/`codex`/`opencode`) stubs. This is
provided by the Docker fixture in `test/fixtures/docker/`.

```bash
# Start the fixture (builds the image, maps container :22 → host :2222)
npm run test:docker:up

# Wait for it to be healthy, then verify SSH works:
ssh -i test/fixtures/docker/test_key \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -p 2222 testuser@localhost tmux list-sessions
```

Fixture details (see `test/fixtures/docker/README.md`):

- **User:** `testuser`
- **Key:** `test/fixtures/docker/test_key` (Ed25519, unencrypted — test-only, never
  reuse in production)
- **Port:** `2222` → container `22`

When you're done:

```bash
npm run test:docker:down    # stop and remove containers + volumes
```

---

## 7. Run the tests

### Unit tests (Vitest)

```bash
npm test            # run once
npm run test:watch  # watch mode
```

Unit tests live under `test/unit/` and cover backend modules: SSH connection logic,
SFTP client, tmux `-CC` parser, host store, etc. These do **not** need the Docker
fixture or a built app.

### E2E tests (Playwright)

Start the Docker fixture first (section 6), then:

```bash
npm run test:e2e            # headless
npm run test:e2e:headed     # with a visible window
```

E2E specs are in `test/e2e/` (`connection-lifecycle.spec.ts`, `terminal.spec.ts`,
`files.spec.ts`, `agent-detection.spec.ts`, etc.). They drive the Electron app
against the Docker fixture on `localhost:2222`. Note: per the Playwright config,
the Electron app launcher is still being wired up for some specs — see
`playwright.config.ts` and the spec files for current status.

---

## 8. Where things live (quick map)

| Path | What |
|------|------|
| `extensions/pocketshell/` | The built-in VS Code extension source (tracked in git) |
| `vendor/vscode/` | VS Code v1.125.0 source (**gitignored**, built/cloned locally) |
| `vendor/vscode/product.json` | PocketShell branding (applied from root `product.json`) |
| `src/` | Backend modules (ssh, sftp, tmux, host store) — copied into the extension at build time |
| `scripts/build-base.sh` | One-time heavy VS Code base build |
| `scripts/build-extension.sh` | Fast extension-only rebuild |
| `scripts/dev.sh` | One-command dev launcher |
| `test/unit/` | Vitest unit tests |
| `test/e2e/` | Playwright E2E tests |
| `test/fixtures/docker/` | Docker SSH fixture for E2E |
| `product.json` | PocketShell product branding (app name, data folders) |
| `agents.md` | **Source of truth** for project state and lessons |
| `docs/plan.md` | v0.1.0 architecture and scope |

---

## Troubleshooting

- **"VS Code source not found at vendor/vscode/"** — you skipped step 3. Clone VS
  Code into `vendor/vscode/` first, then run `scripts/build-base.sh`.
- **App launches then instantly segfaults (`execve() = -1 EFAULT`)** — the Electron
  binary was truncated during download (disk was near-full). Re-run the Electron
  download inside `vendor/vscode/` (`node build/lib/electron.ts`, which checksum-
  validates) and check the binary size. See lesson #13 in agents.md.
- **Extension doesn't activate / commands missing** — check the extension host log
  under `.dev-data/`. A common cause was `product.json` having `defaultChatAgent:
  null`, which crashed the onboarding module at startup (now fixed — see agents.md).
- **Can't connect to the Docker fixture** — make sure it's healthy
  (`npm run test:docker:up` then verify SSH as in section 6) and that port 2222
  isn't already in use.

---

Next: read [agents.md](../agents.md) for the open issues and what's actually
verified vs. planned, and [process.md](../process.md) before contributing a change.
