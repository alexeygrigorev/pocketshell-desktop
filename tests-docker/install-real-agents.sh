#!/bin/sh
# Install the optional provider CLIs into the standalone instance's named
# agent-tools volume. The caller must run this as testuser so npm's files and
# cache remain usable after a container is recreated.
set -eu

agent_tools_dir="${POCKETSHELL_AGENT_TOOLS_DIR:-/home/testuser/.agent-tools}"
codex_version="${POCKETSHELL_CODEX_VERSION:-latest}"
claude_code_version="${POCKETSHELL_CLAUDE_CODE_VERSION:-latest}"
force_install=false

case "${1:---ensure}" in
  --ensure) ;;
  --force) force_install=true ;;
  *)
    echo "usage: pocketshell-install-real-agents [--ensure|--force]" >&2
    exit 2
    ;;
esac

if [ "$(id -u)" -eq 0 ]; then
  echo 'pocketshell-install-real-agents must run as testuser' >&2
  exit 2
fi

mkdir -p "$agent_tools_dir"
marker="$agent_tools_dir/.pocketshell-agent-spec"
spec="codex=${codex_version};claude-code=${claude_code_version}"

if [ "$force_install" = false ] \
  && [ -x "$agent_tools_dir/bin/codex" ] \
  && [ -x "$agent_tools_dir/bin/claude" ] \
  && [ -f "$marker" ] \
  && [ "$(cat "$marker")" = "$spec" ]; then
  exit 0
fi

echo "Installing Codex ${codex_version} and Claude Code ${claude_code_version} into ${agent_tools_dir}" >&2
npm install --global --prefix "$agent_tools_dir" --no-fund --no-audit \
  "@openai/codex@${codex_version}" \
  "@anthropic-ai/claude-code@${claude_code_version}"

if [ ! -x "$agent_tools_dir/bin/codex" ] || [ ! -x "$agent_tools_dir/bin/claude" ]; then
  echo "npm finished without both agent executables in ${agent_tools_dir}/bin" >&2
  exit 1
fi

printf '%s\n' "$spec" > "$marker"
