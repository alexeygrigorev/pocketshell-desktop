# Release Checklist — v0.1.0

Operational checklist for cutting the v0.1.0 release. It matches the current
`release.yml` flow (issue #35), which is split into **`prepare-base`** →
**`build`** → **`release`**. See [release-notes-v0.1.0.md](release-notes-v0.1.0.md)
for what ships and [CHANGELOG.md](../CHANGELOG.md) for the full record.

> **Reality check.** As of this writing the connect→terminal flow is verified on
> Linux, and CI is green for lint/unit/E2E. The cross-platform release build has
> **not** yet produced a green run. Use this checklist for the first real tag
> push; expect to debug at least one platform.

## 0. Pre-flight

- [ ] `main` is green on CI (lint, unit, E2E).
- [ ] The connect→terminal flow still works locally on Linux (launch via
      `scripts/dev.sh`, connect to a host, open a terminal).
- [ ] `VSCODE_REF` in `.github/workflows/release.yml` points at the intended
      VS Code commit.
- [ ] `product.json` has correct PocketShell branding and `quality: stable`.
- [ ] `package.json` version is `0.1.0`.
- [ ] `CHANGELOG.md` `[0.1.0]` section is finalized (date, summary, limitations).

## 1. Warm the base cache (optional but recommended)

The `prepare-base` job is the slow, cacheable step: it clones VS Code, runs
`npm install`, `gulp compile`, and downloads Electron, then caches the result
under `vscode-{VSCODE_REF}-{platform}-base-v2`.

- [ ] Trigger `release.yml` via **`workflow_dispatch`** (Actions tab → "Build" →
      "Run workflow"). This runs `prepare-base` and `build` but **not** `release`
      (release only fires on a `v*` tag).
- [ ] Confirm the three `prepare-base` jobs (linux-x64, win32-x64, darwin-arm64)
      succeed and write the `*-base-v2` caches.
- [ ] Confirm the `build` jobs restore the base (`fail-on-cache-miss: true`) and
      produce artifacts.

Warming the cache ahead of the tagged release avoids the cold-compile path
during the real run. If you skip this, the tagged run will do the cold compile
itself — it just takes longer.

### Cache caveats

- **Force a base rebuild** (corrupted base, dependency bump, or just to be safe):
  bump the cache key suffix in `release.yml` from `base-v2` to `base-v3` for both
  the `prepare-base` write and the `build` read. The old caches age out on their
  own.
- **Eventual-consistency spurious miss.** GitHub's cache backend is eventually
  consistent. A cache written by `prepare-base` is rarely invisible to `build`
  in the *same* run, producing a spurious `fail-on-cache-miss` failure. This
  heals on re-run: simply re-run the failed `build` job and the cache will be
  found.

## 2. Cut the tag

Pushing a `v*` tag triggers the full `release.yml`: `prepare-base` → `build` →
`release` (the `release` job runs only on a tag ref).

1. [ ] Tag: `git tag -a v0.1.0 -m "PocketShell Desktop v0.1.0"`
2. [ ] Push the tag: `git push origin v0.1.0`
3. [ ] Confirm the **Build** workflow triggered on the tag (Actions tab).

## 3. Watch the build

- [ ] `prepare-base` jobs hit the `*-base-v2` cache (cache-hit) for all three
      platforms. If any miss, the job cold-compiles — let it finish (this is the
      slow path, up to ~150 min budgeted).
- [ ] `build` jobs restore the base, apply branding, compile the extension, and
      run `gulp vscode-{platform}` for linux-x64, win32-x64, darwin-arm64.
- [ ] Each `build` job uploads an artifact
      (`pocketshell-linux-x64`, `pocketshell-windows-x64`, `pocketshell-darwin-arm64`).
- [ ] If a `build` job fails with `fail-on-cache-miss` right after `prepare-base`
      wrote the cache, **re-run the failed job** (eventual-consistency; see above)
      before debugging further.

## 4. Verify the release

- [ ] The `release` job runs and creates a GitHub Release for tag `v0.1.0`.
- [ ] Three platform artifacts are attached:
      - `pocketshell-v0.1.0-linux-x64.tar.gz`
      - `pocketshell-v0.1.0-win32-x64.zip`
      - `pocketshell-v0.1.0-darwin-arm64.tar.gz`
- [ ] Edit the GitHub Release body and paste the contents of
      [release-notes-v0.1.0.md](release-notes-v0.1.0.md).
- [ ] Mark the release as "latest".
- [ ] Confirm each asset's download link works.

## 5. Smoke-test the Linux artifact (verified platform)

- [ ] Download `pocketshell-v0.1.0-linux-x64.tar.gz`.
- [ ] Extract and launch `pocketshell`.
- [ ] Add a host, connect over SSH.
- [ ] Open a terminal; confirm prompt, echo, and command output.
- [ ] Disconnect and quit cleanly.

## 6. Smoke-test Windows + macOS (targeted, not yet verified)

These are stretch goals for the first release. If a platform's artifact is
broken, that is expected on the first run — record it as a follow-up rather than
blocking the Linux-verified release.

- [ ] Windows: unzip, launch `pocketshell.exe`, connect, open a terminal.
- [ ] macOS: extract, launch, connect, open a terminal.

## 7. Post-release

- [ ] Close issue #29 (v0.1.0 release).
- [ ] Open follow-ups for any platform that did not build or run cleanly
      (e.g. Windows build #28).
- [ ] Update [agents.md](../agents.md) "Current State" with the release result.
