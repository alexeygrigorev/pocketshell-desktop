#!/usr/bin/env bash
#
# dev.sh — Launch PocketShell in development mode.
#
# Compiles the extension if needed, then launches the app.
# The VS Code base must already be built (run build-base.sh first).
#
# Usage:
#   bash scripts/dev.sh              # launch
#   bash scripts/dev.sh --verbose    # forward args to code.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VSCODE_DIR="$PROJECT_ROOT/vendor/vscode"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }

# --- Sanity checks ---
if [[ ! -d "$VSCODE_DIR" ]]; then
	echo "ERROR: VS Code source not found at $VSCODE_DIR"
	echo "Run: bash scripts/build-base.sh"
	exit 1
fi

if [[ ! -d "$VSCODE_DIR/node_modules" ]]; then
	echo "ERROR: VS Code dependencies not installed."
	echo "Run: bash scripts/build-base.sh"
	exit 1
fi

# --- Sync extension source into vendor/vscode ---
SOURCE_DIR="$PROJECT_ROOT/extensions/pocketshell"
EXTENSION_DIR="$VSCODE_DIR/extensions/pocketshell"

if [[ ! -d "$SOURCE_DIR" ]]; then
	echo "ERROR: Extension source not found at $SOURCE_DIR"
	exit 1
fi

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

cd "$VSCODE_DIR"

# --- Compile extension if out/ is missing ---
if [[ ! -d "extensions/pocketshell/out" ]]; then
	info "Compiling PocketShell extension..."
	npm run gulp compile-extension:pocketshell 2>/dev/null || {
		warn "Gulp task failed, falling back to direct tsc..."
		npx tsc -p extensions/pocketshell/tsconfig.json
	}
else
	info "Extension already compiled."
fi

# --- Launch ---
info "Launching PocketShell..."
exec ./scripts/code.sh "$@"
