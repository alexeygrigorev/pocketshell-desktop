#!/usr/bin/env bash
# Manage the standalone local PocketShell Docker instance.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/tests-docker/docker-compose.instance.yml"
COMPOSE=(docker compose --project-name pocketshell-local --file "$COMPOSE_FILE")

usage() {
  cat <<'EOF'
Usage: bash scripts/test-instance.sh <build|start|stop|reset|status|logs|shell>

  build   Build pocketshell-test:instance.
  start   Build if needed, start the instance, and wait for SSH health.
  stop    Stop the instance but keep its /home/testuser volume.
  reset   Remove the instance and its named home volume, then start clean.
  status  Show container and health status.
  logs    Follow the instance logs (Ctrl-C to stop following).
  shell   Open a shell as testuser inside the instance.
EOF
}

action="${1:-start}"
if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi

case "$action" in
  build)
    "${COMPOSE[@]}" build instance
    ;;
  start)
    "${COMPOSE[@]}" up -d --build --wait instance
    ;;
  stop)
    "${COMPOSE[@]}" stop instance
    ;;
  reset)
    "${COMPOSE[@]}" down --volumes --remove-orphans
    "${COMPOSE[@]}" up -d --build --wait instance
    ;;
  status)
    "${COMPOSE[@]}" ps
    ;;
  logs)
    "${COMPOSE[@]}" logs --follow instance
    ;;
  shell)
    "${COMPOSE[@]}" exec --user testuser instance sh -l
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
