#!/usr/bin/env bash
# Run the in-host E2E suite.
#
# Steps:
#   1. Rebuild the PocketShell extension (so the in-host run exercises current
#      source, not a stale packaged copy) and sync it into the fork's runtime
#      extension dir (vendor/vscode/.build/extensions/pocketshell).
#   2. Compile the in-host test TypeScript -> out/e2e-inhost.
#   3. Launch the forked binary under xvfb-run (the fork opens a renderer even
#      for extension tests).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VSCODE_DIR="$PROJECT_ROOT/vendor/vscode"
SRC_EXT="$VSCODE_DIR/extensions/pocketshell"
RUNTIME_EXT="$VSCODE_DIR/.build/extensions/pocketshell"

# 1. Rebuild + sync the extension (skippable via POCKETSHELL_E2E_SKIP_EXT_BUILD=1).
if [[ "${POCKETSHELL_E2E_SKIP_EXT_BUILD:-0}" != "1" ]]; then
	echo "[test-e2e-inhost] Rebuilding PocketShell extension..."
	bash "$SCRIPT_DIR/build-extension.sh" >/dev/null

	# build-extension.sh compiles into vendor/vscode/extensions/pocketshell/out,
	# but the fork binary loads extensions from .build/extensions/. Sync the
	# fresh out/ + package.json so the runtime tree matches the source.
	echo "[test-e2e-inhost] Syncing fresh build into runtime ext dir..."
	rsync -a --delete "$SRC_EXT/out/" "$RUNTIME_EXT/out/"
	cp "$SRC_EXT/package.json" "$RUNTIME_EXT/package.json"
fi

# 2. Compile the in-host test TypeScript -> out/e2e-inhost (flat; rootDir = .).
npm run build:e2e

# 3. Run under a virtual framebuffer (the fork needs a display).
xvfb-run -a -s "-screen 0 1600x1200x24" node out/e2e-inhost/run-tests.js "$@"
