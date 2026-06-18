#!/usr/bin/env bash
# Build the Docker test images in layer order.
#
# The tmux image does `FROM pocketshell-test:ssh`, so the ssh tag must exist
# first. Compose `up --build` would otherwise try to build tmux before ssh is
# tagged. Build ssh, then tmux, explicitly.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_DIR="$DIR/tests-docker"

echo "==> Building pocketshell-test:ssh"
docker build -t pocketshell-test:ssh -f "$DOCKER_DIR/Dockerfile.ssh" "$DOCKER_DIR"

echo "==> Building pocketshell-test:tmux"
docker build -t pocketshell-test:tmux -f "$DOCKER_DIR/Dockerfile.tmux" "$DOCKER_DIR"

echo "==> Done. Images:"
docker images --filter=reference='pocketshell-test:*' --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}'
