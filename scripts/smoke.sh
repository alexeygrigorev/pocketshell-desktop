#!/usr/bin/env bash
# Full Docker-backed test gate for PocketShell Desktop.
#
# Mirrors the Android project's pre-release confidence gate, scaled to the
# desktop stack: build images -> unit tests -> integration tests -> (Phase 1+)
# E2E -> tear down. Prints a summary at the end.
#
# Usage: scripts/smoke.sh [--skip-e2e]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

SKIP_E2E=0
for arg in "$@"; do
  case "$arg" in
    --skip-e2e) SKIP_E2E=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

fail=0
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m  ok\033[0m  %s\n' "$1"; }
err()  { printf '\033[1;31m fail\033[0m  %s\n' "$1"; fail=1; }

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found — skipping Docker-backed steps." >&2
fi

step "Build Docker images"
if bash scripts/build-docker.sh; then ok "images built"; else err "image build failed"; fi

step "Start compose services"
docker compose -f tests-docker/docker-compose.yml up -d --wait ssh tmux || err "compose up failed"

step "Sanity-check ssh container"
if ssh -i tests-docker/test_key -p 3202 \
     -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
     testuser@127.0.0.1 'whoami' 2>/dev/null | grep -q testuser; then
  ok "ssh container reachable as testuser"
else
  err "ssh container not reachable"
fi

step "Unit tests"
if npm run test:unit; then ok "unit tests"; else err "unit tests"; fi

step "Integration tests"
if npm run test:integration; then ok "integration tests"; else err "integration tests"; fi

if [ "$SKIP_E2E" -eq 0 ]; then
  step "E2E tests (requires app build)"
  if npm run test:e2e; then ok "e2e tests"; else err "e2e tests"; fi
else
  ok "e2e skipped (--skip-e2e)"
fi

step "Tear down compose"
docker compose -f tests-docker/docker-compose.yml down --volumes --remove-orphans >/dev/null 2>&1 || true

echo ""
if [ "$fail" -eq 0 ]; then
  printf '\033[1;32m==> SMOKE GATE PASSED\033[0m\n'
  exit 0
else
  printf '\033[1;31m==> SMOKE GATE FAILED (see steps above)\033[0m\n'
  exit 1
fi
