#!/usr/bin/env bash
#
# build-extension.sh — Fast rebuild of just the PocketShell extension.
#
# Only recompiles vendor/vscode/extensions/pocketshell/ — takes seconds.
# The VS Code base must already be built (run build-base.sh first).
#
# Usage:
#   bash scripts/build-extension.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VSCODE_DIR="$PROJECT_ROOT/vendor/vscode"

GREEN='\033[0;32m'
NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $*"; }

SOURCE_DIR="$PROJECT_ROOT/extensions/pocketshell"
EXTENSION_DIR="$VSCODE_DIR/extensions/pocketshell"

if [[ ! -d "$SOURCE_DIR" ]]; then
	echo "ERROR: Extension source not found at $SOURCE_DIR"
	exit 1
fi

if [[ ! -d "$VSCODE_DIR/node_modules" ]]; then
	echo "ERROR: VS Code dependencies not installed. Run build-base.sh first."
	exit 1
fi

# --- Sync extension source into vendor/vscode ---
info "Syncing extension source to $EXTENSION_DIR..."
mkdir -p "$EXTENSION_DIR"
rsync -a --delete \
	--exclude='node_modules/' \
	--exclude='out/' \
	--exclude='package-lock.json' \
	--exclude='tsconfig.tsbuildinfo' \
	"$SOURCE_DIR/" "$EXTENSION_DIR/"

# --- Install extension npm dependencies ---
if [[ ! -d "$EXTENSION_DIR/node_modules" || -z "$(ls -A "$EXTENSION_DIR/node_modules" 2>/dev/null)" ]]; then
	info "Installing extension npm dependencies..."
	cd "$EXTENSION_DIR"
	npm install --production || {
		echo "ERROR: npm install failed for extension dependencies"
		exit 1
	}
else
	info "Extension node_modules already present, skipping npm install."
fi

info "Compiling PocketShell extension..."
cd "$VSCODE_DIR"

# Use the VS Code build system's extension compilation
npm run gulp compile-extension:pocketshell 2>/dev/null || {
	# Fallback: direct tsc if gulp task not available
	info "Falling back to direct tsc..."
	npx tsc -p extensions/pocketshell/tsconfig.json
}

info "Extension compiled to $EXTENSION_DIR/out/"
