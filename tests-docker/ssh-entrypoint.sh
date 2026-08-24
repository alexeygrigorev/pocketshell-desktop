#!/bin/sh
# Entrypoint for the pocketshell-test:ssh image (inherited by :tmux).
#
# Starts the deterministic traffic responder as `testuser`, then sshd in the
# foreground as the container's main process.
#
# Why the traffic port exists: every other listener in the fixture is idle, so
# the port panel's In/Out columns could only ever read "0 B" and the byte
# counters were never exercised. See tests-docker/traffic-server.py.
#
# It runs as `testuser`, not root, on purpose: the port scanner logs in as
# testuser, and `ss -tlnp` / `readlink /proc/<pid>/cwd` only attribute
# processes the caller owns. As root it would show up nameless, exactly like
# sshd does.
set -e

TRAFFIC_PORT="${PS_TRAFFIC_PORT:-8021}"
su testuser -c "setsid /usr/local/bin/ps-traffic-server $TRAFFIC_PORT \
  </dev/null >/tmp/traffic-server.log 2>&1 &"

exec /usr/sbin/sshd -D -e
