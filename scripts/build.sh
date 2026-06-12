#!/usr/bin/env bash
#
# PocketShell Desktop Build Script
# Builds the VS Code fork for the current platform.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VSCODE_DIR="$PROJECT_ROOT/vendor/vscode"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Check prerequisites ---
info "Checking prerequisites..."

# Node.js version check (need v24.15.0+)
REQUIRED_NODE_MAJOR=24
REQUIRED_NODE_MINOR=15

if ! command -v node &>/dev/null; then
    error "Node.js is not installed. Install Node.js v${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.0 or newer."
fi

NODE_VERSION=$(node -v | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)

if [[ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]] || \
   [[ "$NODE_MAJOR" -eq "$REQUIRED_NODE_MAJOR" && "$NODE_MINOR" -lt "$REQUIRED_NODE_MINOR" ]]; then
    error "Node.js v${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.0+ required, found v${NODE_VERSION}. Use nvm: nvm install ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.0"
fi
info "Node.js v${NODE_VERSION} OK"

# npm check
if ! command -v npm &>/dev/null; then
    error "npm is not installed."
fi
NPM_VERSION=$(npm -v)
info "npm v${NPM_VERSION} OK"

# --- Determine platform ---
detect_platform() {
    local os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    local arch="$(uname -m)"

    case "$os" in
        linux)  PLATFORM="linux" ;;
        darwin) PLATFORM="darwin" ;;
        mingw*|msys*|cygwin*|windows_nt) PLATFORM="win32" ;;
        *)      error "Unsupported OS: $os" ;;
    esac

    case "$arch" in
        x86_64|amd64)  ARCH="x64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *)              error "Unsupported architecture: $arch" ;;
    esac
}

detect_platform
info "Platform: ${PLATFORM}-${ARCH}"

# --- Check for VS Code source ---
if [[ ! -d "$VSCODE_DIR" ]]; then
    info "VS Code source not found. Cloning (shallow)..."
    mkdir -p "$(dirname "$VSCODE_DIR")"
    git clone --depth=1 https://github.com/microsoft/vscode.git "$VSCODE_DIR"
fi

# --- Apply branding ---
if [[ -f "$PROJECT_ROOT/product.json" ]]; then
    info "Applying PocketShell branding from product.json..."
    cp "$PROJECT_ROOT/product.json" "$VSCODE_DIR/product.json"
fi

# --- Install dependencies ---
if [[ ! -d "$VSCODE_DIR/node_modules" ]]; then
    info "Installing dependencies..."
    (cd "$VSCODE_DIR" && npm install)
else
    info "Dependencies already installed (node_modules exists)."
fi

# --- Build ---
BUILD_TARGET="vscode-${PLATFORM}-${ARCH}"
info "Starting production build: ${BUILD_TARGET}"

cd "$VSCODE_DIR"
npm run gulp "$BUILD_TARGET"

# --- Report output location ---
OUTPUT_DIR="$VSCODE_DIR/.build/electron"
if [[ -d "$OUTPUT_DIR" ]]; then
    info "Build output: $OUTPUT_DIR"
    ls -la "$OUTPUT_DIR"
else
    # Also check common output paths
    for candidate in \
        "$VSCODE_DIR/.build/linux" \
        "$VSCODE_DIR/.build/darwin" \
        "$VSCODE_DIR/.build/win32" \
        "$VSCODE_DIR/out"; do
        if [[ -d "$candidate" ]]; then
            info "Build output found: $candidate"
            ls -la "$candidate"
        fi
    done
fi

info "Build complete."
