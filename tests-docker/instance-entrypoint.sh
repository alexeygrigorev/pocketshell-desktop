#!/bin/sh
# Entrypoint for the standalone local PocketShell instance.
#
# `/home/testuser` is a named Compose volume, so these directories are seeded
# on first boot and survive a stop/start. `reset` removes the volume and lets
# this script create a clean instance again.
set -eu

mkdir -p /home/testuser/git /home/testuser/tmp
chown testuser:testuser /home/testuser/git /home/testuser/tmp

exec /usr/local/bin/pocketshell-helper-entrypoint
