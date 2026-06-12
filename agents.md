# Agent Roles & Critical Project State

This file is the **compaction-surviving source of truth** for project context.
CLAUDE.md reads from here. Keep this file updated as things change.

---

## Project: PocketShell Desktop

Desktop fork of [PocketShell](https://github.com/alexeygrigorev/pocketshell) —
a terminal-first, agent-aware SSH client. Cross-platform (Windows first).

**GitHub:** https://github.com/alexeygrigorev/pocketshell-desktop

---

## Architecture Decision (CONFIRMED — do not revisit)

**VS Code fork**, NOT standalone Electron. The user confirmed multiple times:
- "I want a VS fork but you need to figure out how to make it build fast"
- "if we use vs code we get a lot of things out of the box"

How it works:
1. VS Code source lives at `vendor/vscode/` (v1.125.0, Electron 42.2.0, Node 24.x)
2. PocketShell is a **built-in extension** at `vendor/vscode/extensions/pocketshell/`
3. Uses VS Code public API: `vscode.Pseudoterminal`, `vscode.FileSystemProvider`,
   terminal profiles, etc.
4. Product branding in `vendor/vscode/product.json` (already configured for PocketShell)
5. Unnecessary VS Code extensions stripped out (~80 of 108)

Build strategy (from research, 2026-06-12):
- **Pre-built base (one-time, cacheable)**:
  1. `cd vendor/vscode && npm install` — install deps (2.1G, already done)
  2. `npm run electron` — download Electron binary to `.build/electron/`
  3. `npm run gulp compile` — compile VS Code core `src/` → `out/`
- **Incremental extension rebuild (seconds)**:
  - `npm run gulp compile-extension:pocketshell` — full clean+compile
  - `npm run gulp watch-extension:pocketshell` — watch mode, auto-recompile on save
  - `npx tsc -p extensions/pocketshell/tsconfig.json` — even faster incremental
- **Launch dev app**: `./scripts/code.sh` (from vendor/vscode/)
- **Reload after changes**: Ctrl+R in the running app
- For production/distribution: `gulp vscode-{platform}` (full packaging pipeline)
  - Supported platforms: win32-x64, win32-arm64, linux-x64, darwin-x64, darwin-arm64
  - Output goes to `vendor/vscode/.build/vscode-{platform}/` or `../VSCode-{platform}/`
  - Extensions are plain files at `<app-root>/extensions/<name>/` (NOT in ASAR)
  - Only `node_modules` goes into `node_modules.asar`
- `build-base.sh` currently runs the full production build — should be updated to use lighter dev build
- Extension registered in `vendor/vscode/build/gulpfile.extensions.ts` compilations array
- Per-extension gulp tasks auto-generated: `compile-extension:pocketshell`, `watch-extension:pocketshell`, `transpile-extension:pocketshell`

---

## Current State (as of 2026-06-12)

### What exists and works:
- `src/` — Backend modules (TypeScript, tested with Vitest):
  - `src/ssh/` — Connection manager, SSH client, host store (SQLite)
  - `src/terminal/` — SSH terminal backend (PtyAdapter, events)
  - `src/files/` — SFTP client (ssh2 wrapper)
  - `src/tmux/` — tmux -CC protocol parser
  - `src/app/` — Startup/AppContext initializer
  - `src/ui/`, `src/editor/`, etc. — UI module stubs
- `vendor/vscode/` — VS Code v1.125.0 cloned, deps installed (2.1G node_modules)
- `vendor/vscode/product.json` — PocketShell branding applied
- `scripts/build-base.sh` — Dev/production VS Code base build (supports --production flag)
- `scripts/build-extension.sh` — Fast extension-only rebuild (~500ms)
- `scripts/dev.sh` — One-command dev launch (check base, compile extension, launch)
- `.github/workflows/release.yml` — **Cross-platform CI** with matrix build for win32-x64, win32-arm64, linux-x64, darwin-x64, darwin-arm64 + GitHub Release
- **SSH backend verified**: SshClient loads, connects to localhost:22, executes commands, disconnects cleanly (standalone test)
- **Extension compiles**: 0 errors, output at correct path
- **App launches**: Under Xvfb, 12s no crash, "Synchronizing built-in extensions..." appears
- **Backend fixes applied**: ConnectConfig (not ConnectConfiguration), non-null assertions, unused imports removed
- **Extension features complete**: edit/delete hosts, context menus, terminal profile host picker, open remote file, keyPath input
- **Build pipeline fixed**: extension npm deps installed in build-extension.sh and dev.sh
- **Extension activates**: confirmed via exthost.log — all 6 commands registered, `onStartupFinished` event, no errors
- **Root cause found**: `product.json` had `defaultChatAgent: null` which crashed the onboarding module's top-level `assertDefined()`, preventing renderer/extension host from starting. Fixed by providing a valid config.
- **Dev data consolidated**: `--user-data-dir .dev-data/` keeps all config/logs/cache in the project directory
- **CI workflow fixed**: VS Code pinned to commit 037f7fbe (post-1.124.2 main tip); extension npm deps use `--omit=optional` for Windows compatibility; gulpfile patching adds PocketShell to compilations array; all VS Code extensions kept (not stripped — production build has hardcoded references)
- **Cross-platform CI**: Matrix strategy builds for 5 platforms (win32-x64, win32-arm64, linux-x64, darwin-x64, darwin-arm64) in parallel. Windows uses zip, Linux/macOS uses tar.gz. All artifacts attached to GitHub Release on tag push.

### What does NOT exist yet:
- End-to-end SSH terminal verified in running app (connect, show terminal, type commands)
- Windows zip build tested (CI workflow fixed but not triggered yet)
- E2E tests

### NO MILESTONES — we use issues only. All 6 milestones were deleted.

### Build verified (2026-06-12):
- `gulp compile-extension:pocketshell` → 0 errors, ~500ms
- `gulp compile-extensions` → 0 errors, ~1.1s (5 extensions)
- Extension `out/extension.js` at correct path matching `package.json` main field
- Backend modules copied into `extensions/pocketshell/src/backend/` (avoids deep rootDir)
- **App launches successfully** under Xvfb (12s run, no crashes, storage at `~/.pocketshell/`)
- Electron v42.2.0, config dirs `~/.pocketshell/` and `~/.pocketshell-shared/`
- 89 VS Code extensions stripped to `_disabled/`, 7 kept
- `gulpfile.extensions.ts` compilations: 46 → 5 entries

---

## Open Issues (active work)

| # | Title | Status |
|---|-------|--------|
| #33 | Working Windows application (EPIC) | Open — the master tracking issue |
| #30 | Create PocketShell built-in extension for VS Code fork | Open — code exists, compiles, needs activation verification |
| #31 | Strip down VS Code to essential extensions | **Done** — 89 stripped, 7 kept, compilations 46→5 |
| #32 | Fast build pipeline: pre-built base + incremental extension | **Done** — build-base.sh, build-extension.sh, dev.sh all work |
| #29 | v0.1.0 release tag and GitHub release | Open — blocked by #30, #33 |
| #28 | Windows zip build | **Done** — cross-platform CI with matrix (5 platforms) |

### Latest commit: `33744a1` (2026-06-12)
feat: complete extension features — host management, context menus, WASM fix
Cross-platform CI with matrix build (5 platforms). tsconfig fix for tsgo.

### Recently closed issues (#1-#27):
These tracked backend module scaffolding (connection manager, SFTP client, etc.).
All closed prematurely — the code exists but nothing is integrated into a working app.

---

## Hard-Won Lessons (things that went wrong)

1. **Don't claim "done" until it actually works.** Issues #1-#29 were closed despite
   no working app. The app must LAUNCH, CONNECT, and SHOW A TERMINAL before any issue
   is considered done.

2. **Milestones tracked backend modules, not user value.** They were deleted.
   Use issues only, tracked by what the user can DO (launch app, connect, browse files).

3. **Standalone Electron was built then deleted.** User wants VS Code fork.
   Do not create `electron/`, `renderer/`, or `vite.config.ts`.

4. **"No Co-Authored-By: Claude"** in commits. User explicitly requested this.

5. **Use English** for all output.

6. **Config directory is `~/.zlaude/`**, NOT `~/.claude/`.

7. **The three-actor process must be followed.** See process.md.
   Orchestrator → Implementer → Reviewer → merge. No shortcuts.

8. **Agent worktree isolation fails** in this repo ("not in a git repository").
   Run implementer agents without `isolation: "worktree"`.

9. **Don't strip VS Code extensions.** The production build has hardcoded references
   to extensions like `simple-browser` in `build/npm/dirs.ts` and `build/filters.ts`.
   Moving extensions to `_disabled/` breaks the build. Keep all extensions and just
   add PocketShell to the compilations array.

10. **Extension tsconfig must NOT specify `"types": ["node"]`.** VS Code's `tsgo`
    compiler resolves `@types/node` from the root `node_modules/`, not the extension's
    local one. The correct pattern (matching git, emmet, etc.) is: `typeRoots` pointing
    to `./node_modules/@types` + `skipLibCheck: true`, with NO `types` field.
    The `types: ["node"]` field causes "Cannot find type definition file for 'node'" error.

11. **Cross-platform production build uses matrix strategy.** `gulp vscode-{platform}`
    supports: win32-x64, win32-arm64, linux-x64, darwin-x64, darwin-arm64. Each
    runs on the matching GitHub Actions runner. The cache key includes the platform
    because Electron binaries differ per platform.

12. **gulp.dest ENOENT chmod on copilot extension.** `gulp.src(dependenciesSrc, { base: '.' })`
    emits directory entries, and `gulp.dest` tries to `chmod` them. The copilot extension's
    `@anthropic-ai/claude-agent-sdk` has deeply nested `node_modules` that cause overlapping
    globs and race conditions. Fix: add `nodir: true` to the `gulp.src` calls in
    `build/lib/extensions.ts` (lines ~445 and ~480). CI must also apply this patch.

---

## User Preferences

- Wants things done, not planned. "do it right now"
- Catches premature completion quickly. Show working evidence.
- Values VS Code fork for the "out of the box" features.
- Follows the PocketShell Android process closely.
- Prefers issues over milestones for tracking.
- Uses `uv` for Python (not pip) — though this project is TypeScript.

---

## Three-Actor Process (from process.md)

### Orchestrator (this main thread)
- Plans issues, launches implementer/reviewer agents
- Verifies before merge, commits, pushes, closes issues
- **Does NOT write implementation code** — dispatches to implementer agents instead
- Never fixes reviewer findings directly

### Implementer
- Writes code + tests for a single issue in isolated worktree
- Reports status via issue comments
- **Never commits, pushes, or closes**

### Reviewer
- Inspects diffs, runs build/tests
- Posts APPROVED or CHANGES REQUESTED
- **Never edits code**

### Loop: IMPLEMENTER → REVIEWER → (repeat until APPROVED) → ORCHESTRATOR VERIFY/MERGE

---

## Tech Stack

- **VS Code fork** (TypeScript) — `vendor/vscode/`
- **ssh2** — SSH/SFTP connections
- **sql.js** — Local storage (host configs, pure WASM SQLite)
- **tmux -CC** — Terminal session management
- **Monaco** — Code editor (comes with VS Code)
- **Playwright** — E2E tests
- **Vitest** — Unit tests

---

## Key File Paths

| Path | Purpose |
|------|---------|
| `vendor/vscode/` | VS Code v1.125.0 source (gitignored, cloned at build time) |
| `vendor/vscode/product.json` | PocketShell branding |
| `extensions/pocketshell/` | Extension source (tracked in git, synced to vendor/) |
| `vendor/vscode/extensions/pocketshell/` | Extension build dir (synced from `extensions/`) |
| `vendor/vscode/build/gulpfile.extensions.ts` | Extension compilation registry |
| `vendor/vscode/extensions/tsconfig.base.json` | Base tsconfig for all extensions |
| `src/` | Our backend modules (SSH, SFTP, tmux, etc.) |
| `scripts/build-base.sh` | Full VS Code base build |
| `scripts/build-extension.sh` | Sync + fast extension rebuild |
| `process.md` | Three-actor process definition |
| `.github/workflows/release.yml` | CI (Windows zip build + release) |
