#!/bin/sh
# Chaos entrypoint for the pocketshell-test:flaky image.
#
# The base entrypoint execs sshd and everything lives forever. This one starts
# a killer alongside it: every PS_FLAKY_INTERVAL_SEC seconds it kills the
# PER-CONNECTION sshd handlers — the processes OpenSSH re-titles
# `sshd: testuser@pts/0` — and only those. The listener names itself
# differently (`sshd: /usr/sbin/sshd [listener] ...`) and must survive: the
# point is a transport drop a client has to recover from, not a host that went
# away, so the next dial has to succeed.
#
# PS_FLAKY_INTERVAL_SEC is read once at startup; a test starts the container
# with a short interval (tests/integration/Reconnect.integration.test.ts uses
# 5) instead of baking one into the image.
set -e

INTERVAL="${PS_FLAKY_INTERVAL_SEC:-45}"

while :; do
  sleep "$INTERVAL"
  pkill -f 'sshd: testuser' 2>/dev/null || true
done &

# The killer is a background job of THIS shell; exec replaces the shell image,
# which orphans the loop to init — it keeps running, and sshd becomes PID 1
# exactly as in the base image.
exec /usr/sbin/sshd -D -e
