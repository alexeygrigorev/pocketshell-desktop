#!/bin/sh
# wait-for-healthy.sh — poll Docker container until its HEALTHCHECK passes
set -eu

container="${1:?Usage: wait-for-healthy.sh <container> [timeout]}"
timeout="${2:-60}"

echo "Waiting for $container to become healthy (timeout=${timeout}s)..."

elapsed=0
while [ "$elapsed" -lt "$timeout" ]; do
  status=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "missing")
  case "$status" in
    healthy) echo "Healthy after ${elapsed}s"; exit 0 ;;
    unhealthy) echo "Unhealthy after ${elapsed}s" >&2; exit 1 ;;
  esac
  sleep 2
  elapsed=$((elapsed + 2))
done

echo "Timed out waiting for $container (${timeout}s)" >&2
exit 1
