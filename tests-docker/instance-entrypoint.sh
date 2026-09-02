#!/bin/sh
# Entrypoint for the standalone local PocketShell instance.
#
# `/home/testuser` is a named Compose volume, so these directories are seeded
# on first boot and survive a stop/start. `reset` removes the volume and lets
# this script create a clean instance again.
set -eu

mkdir -p /home/testuser/git /home/testuser/tmp
chown testuser:testuser /home/testuser/git /home/testuser/tmp

agent_tools_dir="${POCKETSHELL_AGENT_TOOLS_DIR:-/home/testuser/.agent-tools}"
mkdir -p "$agent_tools_dir"
chown testuser:testuser "$agent_tools_dir"

case "${POCKETSHELL_REAL_AGENTS:-false}" in
  true|1|yes|TRUE|YES)
    # The packages and their bin links are in a named volume, while Codex and
    # Claude keep accounts under the separate named /home/testuser volume.
    su -m testuser -c '/usr/local/bin/pocketshell-install-real-agents --ensure'
    export PATH="$agent_tools_dir/bin:$PATH"
    ;;
esac

# Ask the shared helper entrypoint to overlay the local-test defaults after it
# has created the first tmux server and its seed sessions. This keeps the
# user's config intact while making wheel scrolling and a useful history limit
# reliable on every container start.
export POCKETSHELL_TMUX_OVERLAY=/opt/pocketshell-tmux.conf

exec /usr/local/bin/pocketshell-helper-entrypoint
