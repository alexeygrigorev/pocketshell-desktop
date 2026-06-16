#!/usr/bin/env bash
#
# build-base.sh — Build the VS Code base for PocketShell.
#
# Two modes:
#   Dev (default):  installs deps, downloads Electron, compiles core.
#                    Fast — skips bundling, minifying, packaging.
#   Production:     full production build (bundling + packaging).
#
# Usage:
#   bash scripts/build-base.sh                          # dev build (fast)
#   bash scripts/build-base.sh --production             # full production build
#   bash scripts/build-base.sh --production --platform linux --arch x64
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VSCODE_DIR="$PROJECT_ROOT/vendor/vscode"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Parse args ---
PRODUCTION=false
PLATFORM=""
ARCH=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		--production) PRODUCTION=true; shift ;;
		--platform)   PLATFORM="$2"; shift 2 ;;
		--arch)       ARCH="$2"; shift 2 ;;
		*)            error "Unknown argument: $1" ;;
	esac
done

# --- Detect platform/arch (only needed for production builds) ---
if [[ "$PRODUCTION" == true ]]; then
	if [[ -z "$PLATFORM" ]]; then
		case "$(uname -s | tr '[:upper:]' '[:lower:]')" in
			linux)  PLATFORM="linux" ;;
			darwin) PLATFORM="darwin" ;;
			mingw*|msys*|cygwin*|windows_nt) PLATFORM="win32" ;;
			*)      error "Unsupported OS" ;;
		esac
	fi

	if [[ -z "$ARCH" ]]; then
		case "$(uname -m)" in
			x86_64|amd64)  ARCH="x64" ;;
			aarch64|arm64) ARCH="arm64" ;;
			*)              error "Unsupported arch" ;;
		esac
	fi

	# Map platform names for gulp task
	case "$PLATFORM" in
		linux)  GULP_PLATFORM="linux" ;;
		darwin) GULP_PLATFORM="darwin" ;;
		win32)  GULP_PLATFORM="win32" ;;
	esac
fi

if [[ "$PRODUCTION" == true ]]; then
	info "Production build: ${PLATFORM}-${ARCH}"
else
	info "Dev build (fast — skips bundling/minifying/packaging)"
fi

# --- Check for VS Code source ---
if [[ ! -d "$VSCODE_DIR" ]]; then
	error "VS Code source not found at $VSCODE_DIR. Clone it first."
fi

# --- Apply branding ---
if [[ -f "$PROJECT_ROOT/product.json" ]]; then
	info "Applying PocketShell branding..."
	cp "$PROJECT_ROOT/product.json" "$VSCODE_DIR/product.json"
fi

# --- Apply PocketShell build patches ---
info "Applying PocketShell VS Code build patches..."
node "$PROJECT_ROOT/scripts/patch-vscode-build.js"

# --- Sync PocketShell extension ---
info "Syncing PocketShell extension..."
mkdir -p "$VSCODE_DIR/extensions/pocketshell"
cp -r "$PROJECT_ROOT/extensions/pocketshell/." "$VSCODE_DIR/extensions/pocketshell/"
rm -rf "$VSCODE_DIR/extensions/pocketshell/node_modules"
rm -rf "$VSCODE_DIR/extensions/pocketshell/out"
rm -f "$VSCODE_DIR/extensions/pocketshell/tsconfig.tsbuildinfo"

# --- Install dependencies ---
if [[ ! -d "$VSCODE_DIR/node_modules" ]]; then
	info "Installing VS Code dependencies..."
	(cd "$VSCODE_DIR" && npm install)
else
	info "Dependencies already installed."
fi

if [[ ! -d "$VSCODE_DIR/extensions/pocketshell/node_modules" ]]; then
	info "Installing PocketShell extension dependencies..."
	(cd "$VSCODE_DIR/extensions/pocketshell" && npm install --omit=optional)
else
	info "PocketShell extension dependencies already installed."
fi

# --- Download Electron (needed for both dev and production) ---
if ! command -v node &>/dev/null; then
	error "Node.js is not installed."
fi

cd "$VSCODE_DIR"

# Ensure Electron binary is available
if [[ ! -d "$VSCODE_DIR/.build/electron" ]]; then
	info "Downloading Electron..."
	npm run electron
else
	info "Electron already downloaded."
fi

# --- Build ---
if [[ "$PRODUCTION" == true ]]; then
	BUILD_TARGET="vscode-${GULP_PLATFORM}-${ARCH}"
	info "Running gulp ${BUILD_TARGET}..."
	npm run gulp "$BUILD_TARGET"
	info "Production build complete. Output in $VSCODE_DIR/.build/"
else
	info "Compiling VS Code core..."
	npm run gulp compile
	info "Dev build complete. Launch with: bash scripts/dev.sh"
fi
