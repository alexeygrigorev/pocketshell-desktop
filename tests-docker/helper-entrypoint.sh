#!/bin/sh
# Entrypoint for the pocketshell-test:helper image.
#
# Starts sshd in the foreground (the container's main process) and, just
# before that, seeds two live detached tmux sessions as testuser so
# `pocketshell sessions list` returns a non-empty tree for tests. tmux
# sessions survive because they are detached and owned by the testuser
# server process group.
set -e

# Seed live tmux sessions owned by testuser (idempotent: skip if present).
su testuser -c '
  if ! tmux has-session -t main 2>/dev/null; then
    tmux new-session -d -s main -c "$HOME"
    tmux new-session -d -s build -c "$HOME"
  fi
'

# The standalone local instance supplies an overlay after the server exists.
# The normal helper fixture leaves this unset, so its deterministic defaults
# and tests are unchanged.
if [ -n "${POCKETSHELL_TMUX_OVERLAY:-}" ]; then
  su -m testuser -c "tmux source-file '$POCKETSHELL_TMUX_OVERLAY'"
fi

# Start the deterministic traffic responder (inherited from the :ssh layer).
# This image replaces that layer's CMD, so without this line the helper — the
# image the E2E screenshots come from — would keep showing "0 B" for every
# forward. See tests-docker/traffic-server.py.
TRAFFIC_PORT="${PS_TRAFFIC_PORT:-8021}"
su testuser -c "setsid /usr/local/bin/ps-traffic-server $TRAFFIC_PORT \
  </dev/null >/tmp/traffic-server.log 2>&1 &"

# Run sshd in the foreground so the container stays up and logs to stderr.
exec /usr/sbin/sshd -D -e
