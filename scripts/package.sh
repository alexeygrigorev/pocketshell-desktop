#!/usr/bin/env bash
#
# PocketShell Desktop Packaging Script
# Packages the VS Code fork build into platform installers using electron-builder.
#
# Usage:
#   ./scripts/package.sh [OPTIONS]
#
# Options:
#   --target <target>   Build target (win32-x64, win32-arm64, darwin-x64,
#                       darwin-arm64, linux-x64, linux-arm64). Default: auto-detect.
#   --skip-build        Skip the build step (use existing build output).
#   --publish           Publish to GitHub Release (requires GITHUB_TOKEN).
#   -h, --help          Show this help message.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/build"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
step()  { echo -e "${BLUE}[STEP]${NC} $*"; }

usage() {
    sed -n '2,/^$/p' "$0" | sed 's/^# //' | sed 's/^#//'
    exit 0
}

# --- Defaults ---
TARGET=""
SKIP_BUILD=false
PUBLISH=false

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --target)
            TARGET="$2"
            shift 2
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --publish)
            PUBLISH=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            error "Unknown option: $1. Use --help for usage."
            ;;
    esac
done

cd "$PROJECT_ROOT"

# --- Read version from product.json or package.json ---
if [[ -f "package.json" ]]; then
    VERSION=$(node -e "console.log(require('./package.json').version)")
else
    VERSION="0.0.0"
fi
info "PocketShell Desktop v${VERSION}"

# --- Check prerequisites ---
info "Checking prerequisites..."

if ! command -v node &>/dev/null; then
    error "Node.js is not installed. Install Node.js v24+."
fi
NODE_VERSION=$(node -v)
info "Node.js ${NODE_VERSION} OK"

if ! command -v npm &>/dev/null; then
    error "npm is not installed."
fi
NPM_VERSION=$(npm -v)
info "npm v${NPM_VERSION} OK"

# --- Detect platform ---
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

if [[ -z "$TARGET" ]]; then
    TARGET="${PLATFORM}-${ARCH}"
fi
info "Packaging target: ${TARGET}"

# --- Run build if needed ---
if [[ "$SKIP_BUILD" == false ]]; then
    step "Running build..."
    bash "$SCRIPT_DIR/build.sh"
else
    step "Skipping build (--skip-build)"
fi

# --- Verify build output exists ---
VSCODE_DIR="$PROJECT_ROOT/vendor/vscode"
BUILD_FOUND=false

for candidate in \
    "$VSCODE_DIR/.build/electron" \
    "$VSCODE_DIR/.build/linux" \
    "$VSCODE_DIR/.build/darwin" \
    "$VSCODE_DIR/.build/win32" \
    "$VSCODE_DIR/out"; do
    if [[ -d "$candidate" ]]; then
        BUILD_FOUND=true
        info "Build output found: $candidate"
        break
    fi
done

if [[ "$BUILD_FOUND" == false ]]; then
    error "No build output found. Run 'bash scripts/build.sh' first."
fi

# --- Install electron-builder if not present ---
step "Ensuring electron-builder is available..."

if ! npx electron-builder --version &>/dev/null; then
    info "Installing electron-builder..."
    npm install --save-dev electron-builder
fi

EB_VERSION=$(npx electron-builder --version 2>/dev/null || echo "unknown")
info "electron-builder ${EB_VERSION}"

# --- Determine electron-builder target ---
# Map our target strings to electron-builder format
TARGET_OS="${TARGET%%-*}"
TARGET_ARCH="${TARGET##*-}"

case "$TARGET_OS" in
    win32)  EB_TARGET="nsis" ;;
    darwin) EB_TARGET="dmg" ;;
    linux)  EB_TARGET="AppImage" ;;
    *)      error "Cannot map target OS '$TARGET_OS' to electron-builder target." ;;
esac

step "Packaging ${TARGET} as ${EB_TARGET}..."

# --- Build electron-builder command ---
EB_ARGS=(
    --config "$BUILD_DIR/electron-builder.yml"
)

# Set platform target explicitly
case "$TARGET_OS" in
    win32)  EB_ARGS+=(--win) ;;
    darwin) EB_ARGS+=(--mac) ;;
    linux)  EB_ARGS+=(--linux) ;;
esac

if [[ "$PUBLISH" == true ]]; then
    EB_ARGS+=(--publish always)
else
    EB_ARGS+=(--publish never)
fi

# Pass architecture
if [[ "$TARGET_ARCH" == "arm64" ]]; then
    EB_ARGS+=(--arm64)
elif [[ "$TARGET_ARCH" == "x64" ]]; then
    EB_ARGS+=(--x64)
fi

# --- Run electron-builder ---
DIST_DIR="$PROJECT_ROOT/dist"
mkdir -p "$DIST_DIR"

info "Running electron-builder..."
npx electron-builder "${EB_ARGS[@]}"

# --- Report results ---
step "Packaging complete!"
info "Output directory: $DIST_DIR"

ARTIFACT_COUNT=0
for f in "$DIST_DIR"/*; do
    if [[ -f "$f" ]]; then
        FILENAME="$(basename "$f")"
        SIZE=""
        if [[ "$(uname)" == "Darwin" ]]; then
            SIZE=$(stat -f%z "$f" | awk '{printf "%.1f MB", $1/1048576}')
        else
            SIZE=$(stat -c%s "$f" | awk '{printf "%.1f MB", $1/1048576}')
        fi
        echo "  ${FILENAME}  (${SIZE})"
        ARTIFACT_COUNT=$((ARTIFACT_COUNT + 1))
    fi
done

if [[ "$ARTIFACT_COUNT" -eq 0 ]]; then
    warn "No artifacts found in $DIST_DIR"
else
    info "${ARTIFACT_COUNT} artifact(s) produced"
fi
