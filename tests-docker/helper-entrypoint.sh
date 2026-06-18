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

# Run sshd in the foreground so the container stays up and logs to stderr.
exec /usr/sbin/sshd -D -e
