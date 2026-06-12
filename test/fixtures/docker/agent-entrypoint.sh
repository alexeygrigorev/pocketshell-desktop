#!/bin/sh
set -eu

# ── seed fixture data into testuser home ──────────────────────────
FIXDIR="/opt/pocketshell-agent-fixtures"
HOME="/home/testuser"

# Claude session logs
mkdir -p "$HOME/.claude/projects/-workspace-pocketshell"
cp "$FIXDIR/claude-session.jsonl" "$HOME/.claude/projects/-workspace-pocketshell/pocketshell-claude.jsonl"

# Codex session logs
mkdir -p "$HOME/.codex/sessions/2026/05/22"
cp "$FIXDIR/codex-session.jsonl" "$HOME/.codex/sessions/2026/05/22/pocketshell-codex.jsonl"

# OpenCode session logs
mkdir -p "$HOME/.local/share/opencode"
cp "$FIXDIR/opencode-rows.jsonl" "$HOME/.local/share/opencode/pocketshell-rows.jsonl"

# PocketShell state dirs
mkdir -p "$HOME/.local/state/pocketshell/logs"
printf '{"ts":"2026-01-01T00:00:00Z","kind":"agent","msg":"fixture log entry"}\n' \
  > "$HOME/.local/state/pocketshell/logs/agent-20260101.jsonl"

# Sample project directories
mkdir -p "$HOME/git/pocketshell"
mkdir -p "$HOME/git/test-project"

# Fix ownership
chown -R testuser:testuser "$HOME"

# ── start sshd ────────────────────────────────────────────────────
echo "Starting sshd..."
/usr/sbin/sshd -D -e &
SSHD_PID=$!

# Wait until healthy (local SSH loopback works)
echo "Waiting for SSH to be ready..."
for i in $(seq 1 30); do
  if ssh -o BatchMode=yes -o ConnectTimeout=1 -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null -i /root/test_key testuser@localhost true 2>/dev/null; then
    echo "SSH ready after ${i}s"
    break
  fi
  sleep 1
done

echo "=== PocketShell test fixture ready ==="
echo "SSH: testuser@localhost:22 (key auth via /root/test_key)"

wait $SSHD_PID
