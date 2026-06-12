#!/usr/bin/env bash
set -euo pipefail

# PocketShell Desktop build script
# Builds the VS Code fork with PocketShell branding

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VSCODE_DIR="$ROOT_DIR/vendor/vscode"

echo "=== PocketShell Desktop Build ==="

# Ensure VS Code source is present
if [ ! -d "$VSCODE_DIR" ]; then
  echo "ERROR: VS Code source not found at $VSCODE_DIR"
  echo "Run: git clone --depth 1 https://github.com/microsoft/vscode.git vendor/vscode"
  exit 1
fi

# Apply branding if our product.json exists
if [ -f "$ROOT_DIR/product.json" ]; then
  echo "Applying PocketShell branding..."
  cp "$ROOT_DIR/product.json" "$VSCODE_DIR/product.json"
fi

# Build VS Code
echo "Building VS Code..."
cd "$VSCODE_DIR"

# Install VS Code dependencies
npm ci

# Run the VS Code build
npm run compile

echo "=== Build complete ==="
