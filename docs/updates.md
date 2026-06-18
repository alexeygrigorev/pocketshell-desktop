# In-App Extension-Delta Updater

> Issue: [#96](https://github.com/alexeygrigorev/pocketshell-desktop/issues/96)

PocketShell Desktop ships ~300MB release archives, but roughly 290MB of each
archive — the VS Code core + Electron runtime, built at a pinned
`VSCODE_REF` — is byte-identical across releases. Only the PocketShell
extension layer changes. The in-app updater ships just that layer (a few MB),
verifies it, swaps it in atomically, and reloads the window. This doc is the
complete map: what runs where, the manifest contract, and the edges a new
contributor needs to know.

## 1. Overview / motivation

Re-downloading 300MB on every minor release is wasteful; the delta is the
extension alone. The updater (#96):

- fetches a tiny per-platform **manifest** from the latest GitHub release,
- compares its `version` / `baseVersion` against the running app,
- downloads the **delta zip** (~MB) and verifies its **sha256**,
- **atomically swaps** it over the live extension dir (with rollback), and
- reloads the window so the new code loads.

Backend logic is pure (no `vscode` import) and lives in
`extensions/pocketshell/src/backend/updates/`. A canonical, unit-tested copy
lives in `src/updates/` and is byte-identical to the mirror that runs inside
the extension host. The extension-host glue is
`extensions/pocketshell/src/feature/updates/update-controller.ts`.

## 2. Architecture

```
 ┌─ activate() (extension.ts) ────────────────────────────────────────────┐
 │  new UpdateController(ctx, settings)                                    │
 │  register() → pocketshell.update.{check,apply}                          │
 │  if (POCKETSHELL_E2E !== '1') void checkAndNotify()   ← fire & forget  │
 └────────────────────────────────────────────────────────────────────────┘
        │
        ▼
 UpdateController.checkAndNotify / runCheck
   readRuntimeBaseVersion(ctx)  ← <extensionPath>/base-version.json   ('dev' if absent)
   readRuntimeAppVersion(ctx)   ← ctx.extension.packageJSON.version
        │
        ▼
 updater.checkForUpdate(manifestUrl, {currentVersion, currentBaseVersion})
   fetch(manifestUrl) → JSON → manifest.parseManifest  (manifest.ts)
   manifest.compareUpdate(manifest, opts)              (manifest.ts)
        │                          │
        │  status:                 │  → VersionCompareResult.kind:
        │  available ──────────────┘     up-to-date | available | base-mismatch
        │                                                     | below-min-app
        ▼                                                     | check-failed
 (notify) "X available. Update now?"  → applyAndReload(manifest)
        │
        ▼
 updater.applyUpdate(manifest, targetDir)               (updater.ts)
   downloader.downloadToFile(downloadUrl, tmp)          (downloader.ts)
        │   streams to <tmp>.part-… + incremental sha256, then renames
        ▼
   verifier.safeStrEqual(downloadedSha, manifest.sha256)(verifier.ts)
        │   mismatch → throw (tmp cleaned up in finally)
        ▼
   installer.installExtensionUpdate(tmpZip, targetDir)  (installer.ts)
        │   1. accessSync(W_OK)  → else UpdatePermissionError
        │   2. extractZipBuffer → <targetDir>.new       (pure-node unzip, zip-slip safe)
        │   3. rename targetDir → targetDir.old ; .new → targetDir  (atomic swap)
        │   4. on failure: rmrf .new ; if target missing, restore .old  (rollback)
        ▼
 vscode.commands.executeCommand('workbench.action.reloadWindow')
```

Key modules:

| Step | Module | Entry function |
|---|---|---|
| Manifest fetch + compare | `manifest.ts` | `parseManifest`, `compareUpdate`, `isNewer` |
| Streaming download | `downloader.ts` | `downloadToFile` |
| sha256 verify | `verifier.ts` | `safeStrEqual`, `sha256OfFile` |
| Atomic install (swap + rollback, unzip) | `installer.ts` | `installExtensionUpdate`, `extractZipBuffer` |
| Orchestration | `updater.ts` | `checkForUpdate`, `applyUpdate` |
| Host glue (UX, gating, commands) | `update-controller.ts` | `UpdateController`, `readRuntimeBaseVersion` |

`checkForUpdate` is read-only and **never throws** (returns
`{ status: 'check-failed' }`); `applyUpdate` is the one that mutates.

## 3. The manifest contract

```ts
// manifest.ts
interface UpdateManifest {
  version: string;        // extension version offered, e.g. "0.1.4"
  downloadUrl: string;    // HTTPS URL to the flat delta zip
  sha256: string;         // lowercase hex, 64 chars — verified before install
  baseVersion: string;    // VS Code base this delta was built against
  minAppVersion?: string; // optional floor on the running app version
  releaseNotes?: string;
}
```

`parseManifest` rejects anything missing `version`/`downloadUrl`/`sha256`/
`baseVersion`, or whose `sha256` isn't `/^[0-9a-fA-F]{64}$/`.

### Per-platform manifests

There is **no single `latest.json`**. release.yml publishes one manifest per
matrix platform — `latest-<platform>.json` — because the extension vendors a
platform-specific native: ssh2's `sshcrypto.node`. The delta zip is therefore
platform-keyed. The runtime builds the URL in
`update-controller.ts#manifestUrlForCurrentPlatform`:

```ts
const RELEASE_BASE =
  'https://github.com/alexeygrigorev/pocketshell-desktop/releases/latest/download';
function manifestUrlForCurrentPlatform(): string {
  return `${RELEASE_BASE}/latest-${process.platform}-${process.arch}.json`;
}
```

The platform key is `${process.platform}-${process.arch}`, which on the three
release targets yields exactly release.yml's matrix `platform` values:
`linux-x64`, `win32-x64`, `darwin-arm64`. No mapping table is required.

`compareUpdate` checks in this order: **base-mismatch → below-min-app →
up-to-date/available** (deterministic and caller-actionable).

## 4. base-version.json mechanism

At build time, release.yml writes
`vendor/vscode/extensions/pocketshell/base-version.json`:

```json
{"baseVersion":"037f7fbe03f7"}
```

where `BASE_VERSION="${VSCODE_REF:0:12}"` — the first 12 chars of the pinned
VS Code sha (top of release.yml: `VSCODE_REF`, currently
`037f7fbe03f78896c841adfd57aea4e0c85ccbc7`). The **same** value is stamped
into the manifest's `baseVersion` field, so the comparison is byte-for-byte.

At runtime, `readRuntimeBaseVersion(ctx)` reads
`<extensionPath>/base-version.json`. The backend compares it with strict
**`===`** equality against the manifest's `baseVersion`:

- **match** → the core is unchanged → the delta can apply.
- **mismatch** → the VS Code/Electron core changed → `base-mismatch` → the UX
  offers a **full download** instead (no delta possible).
- **file absent** (dev builds, CI Playwright runs, builds predating the
  contract) → sentinel `'dev'` (the `DEV_BASE_VERSION` constant). Any real
  manifest will mismatch `'dev'`, so this is always safe.

The dedicated "Write base-version.json" step is deliberately separated from
the delta-packaging step (and runs **before** the production `gulp` build) so
that the full archive — which fresh installs come from — is also stamped.
Without that ordering, a fresh install would read `baseVersion: 'dev'` and be
unable to delta-update.

## 5. Auto vs manual flow

Wired in `activate()` (`extension.ts`):

```ts
const updateController = new UpdateController(context, settings);
context.subscriptions.push(...updateController.register());
context.subscriptions.push(...registerSettingsTestBridge(settings));
if (process.env.POCKETSHELL_E2E !== '1') {
  void updateController.checkAndNotify().catch(() => { /* never propagate */ });
}
```

**Activate-time auto check** — `checkAndNotify()` — is fire-and-forget and
gated by three conditions, all of which must allow it:

1. `settings.autoUpdateCheckOnStartup !== false` (user can disable).
2. `process.env.POCKETSHELL_E2E !== '1'` (in `activate()`, not the controller)
   — keeps E2E offline and modal-free.
3. `readRuntimeBaseVersion(ctx) !== 'dev'` — dev builds (no `base-version.json`)
   skip silently so they don't pop a "full update available" modal off a
   `'dev'`-vs-real-base mismatch.

The auto path uses `silentWhenCurrent: true` — `up-to-date` and `check-failed`
produce no UI. The default on an available update is **notify-and-confirm**:
an information message with `Update` / `Later` buttons; choosing `Update`
runs `applyAndReload`.

**Manual commands** (registered by `UpdateController.register()`, always on,
ignoring the setting):

- `pocketshell.update.check` — check, inform even when up-to-date.
- `pocketshell.update.apply` — check; if available, apply + reload; otherwise
  reuse the messaging path so `base-mismatch` / `below-min-app` still surface
  their Download prompt.

`applyAndReload` runs `applyUpdate`, then
`workbench.action.reloadWindow`. Errors become a modal: an
`UpdatePermissionError` yields a "manual update needed" message; anything
else is surfaced verbatim.

## 6. Security model

- **sha256 verification of the download before install.**
  `downloader.downloadToFile` streams bytes to a temp file while hashing
  incrementally; `applyUpdate` compares the computed digest to
  `manifest.sha256` via `verifier.safeStrEqual` (constant-time-ish compare,
  lowercase-normalized). Mismatch throws and the temp is cleaned up.
- **Atomic in-place swap with rollback.** `installer.installExtensionUpdate`
  extracts into `<targetDir>.new`, then `rename targetDir → targetDir.old` and
  `<targetDir>.new → targetDir`. If either rename fails, the backup is
  restored (only when the live target is missing), so a failed update never
  leaves the running extension half-written or absent. Stale `.new` / `.old`
  from a prior failed run are cleaned at the start.
- **Pure-node unzip with zip-slip protection.** `extractZipBuffer` rejects
  Windows-drive absolutes, posix absolutes, and `..` traversal; stored
  (uncompressed) entries are additionally CRC-32-checked (deflate entries are
  validated by zlib itself).
- **Writable-folder pre-check.** `fs.accessSync(targetDir, W_OK)`; failure
  throws `UpdatePermissionError` → caller falls back to a manual-update prompt.

### Current limitation (future work)

There is **no code-signing or authenticity guarantee**. The sha256 only proves
the bytes match the manifest; a compromised GitHub release could publish a
matching manifest + malicious zip and the updater would happily install it
(the download URL is HTTPS, but that only protects transport). Adding a
signature over the manifest (e.g. a detached signature verified against a
pinned public key shipped with the app) is the planned hardening.

## 7. release.yml's role

Per platform, in `build` job (matrix: `linux-x64`, `win32-x64`,
`darwin-arm64`):

1. **Write base-version.json** — `printf '{"baseVersion":"%s"}\n' "$BASE_VERSION"`
   into the built extension dir (`BASE_VERSION="${VSCODE_REF:0:12}"`).
2. **Bump built extension version to tag** — rewrite the built copy's
   `package.json#version` to `${GITHUB_REF_NAME#v}` (e.g. `v0.1.4` → `0.1.4`),
   so the updater's `currentVersion` matches the manifest and
   `isNewer("0.1.4", "0.1.3")` eventually goes false. (Uses a node one-liner,
   not `npm version`, to avoid mutating `package-lock` / firing lifecycle
   hooks.)
3. **Package delta zip + manifest** — flat-zip the extension dir's *contents*
   (`cd "$EXT_DIR" && zip -r -X "$ZIP_PATH" .`), assert the layout is flat
   (no `pocketshell/` prefix — the installer extracts with no parent-strip),
   `sha256sum` the zip, and write `latest-<platform>.json` with deterministic
   `printf` JSON. Asset filenames use the full tag (e.g.
   `pocketshell-extension-v0.1.4-linux-x64.zip`).
4. **Upload delta artifacts** (`upload-artifact@v4`).
5. **Production build** (`gulp vscode-<platform>`) then runs **after** the
   stamps, so the full archive also contains `base-version.json` and the
   bumped `package.json` — fresh installs can delta-update later.

The `release` job downloads all artifacts, flattens
(`*.zip`, `*.tar.gz`, `latest-*.json`), and attaches them to the GitHub
release via `softprops/action-gh-release@v2`.

## 8. Known limitations / follow-ups

- **No code-signing** — see §6. A pinned-public-key signature over the
  manifest is the main outstanding hardening.
- **`minAppVersion` gating is omitted in practice.** `compareUpdate` produces
  `below-min-app`, but release.yml does not currently emit a `minAppVersion`
  field in the manifest, so the check never triggers.
- **Auto-install on launch** is not a feature; only the *check* is automatic
  (and defaults to notify-and-confirm). The `autoUpdateCheckOnStartup` setting
  exists and gates the check, but there is no settings-view toggle wiring it
  to the UI yet — only the setting itself.
- **Version bump happens in-workflow on the built copy.** release.yml rewrites
  the built extension's `package.json`; the repo's `package.json` is bumped
  separately at release-cut (so a built archive's version reflects the tag,
  not necessarily the committed repo version).
- **Backup directory** is `<targetDir>.old` (configurable via
  `installExtensionUpdate`'s `opts.backupSuffix`); it is not garbage-collected
  across runs beyond the pre-clean at install start.

### Where to change things

| You want to… | Touch |
|---|---|
| Change what counts as a valid manifest / compare order | `manifest.ts` |
| Change download mechanics (retry, proxy, progress) | `downloader.ts` |
| Change verify / signing | `verifier.ts` + `applyUpdate` |
| Change swap/rollback/extract | `installer.ts` |
| Change UX, gating, or add a command | `update-controller.ts` + `extension.ts` |
| Change the stamped base / manifest fields | `.github/workflows/release.yml` |
| Change which platforms get manifests | release.yml matrix + `manifestUrlForCurrentPlatform` |
