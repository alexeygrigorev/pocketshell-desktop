#!/usr/bin/env bash
# Create an isolated git worktree under .worktrees/ for an implementer agent,
# with the heavy gitignored directories symlinked from the main checkout.
#
# WHY: this repo's dominant cost is gitignored working-tree state — node_modules
# (~170M) and vendor/vscode (~5G) are NOT tracked, so a plain `git worktree add`
# yields a worktree with NO deps and NO VS Code source. Re-installing per worktree
# is multi-GB and minutes of waste. Symlinks give each worktree its own isolated
# SOURCE tree (so parallel agents editing files never collide) while reusing the
# shared build deps from the main checkout. This is what makes worktree isolation
# viable in this repo (the thing that previously "didn't work here").
#
# Usage: bash scripts/worktree-create.sh <branch-name> [--full]
#   <branch-name>   new branch name; the worktree lives at .worktrees/<branch-name>
#   --full          ALSO symlink vendor/vscode, out, .build, .dev-data (needed for
#                   gulp builds, in-host E2E, or launching the app). WITHOUT --full
#                   only node_modules is linked — sufficient for source edits +
#                   Vitest unit tests.
#
# CONCURRENCY RULE: multiple --full worktrees must NOT run gulp / in-host E2E /
# app launches at the same time — they write into the shared (symlinked)
# vendor/vscode/out. Unit-test-only worktrees (the default) are safe to parallelize.

set -euo pipefail

BRANCH="${1:-}"
FULL=0
for arg in "${@:2}"; do
  case "$arg" in
    --full) FULL=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ -z "$BRANCH" ]; then
  echo "usage: bash scripts/worktree-create.sh <branch-name> [--full]" >&2
  exit 1
fi

# Resolve the MAIN checkout root regardless of which worktree we're invoked from
# (--git-common-dir points at the shared .git; its parent is the main worktree).
COMMON="$(git rev-parse --git-common-dir)"
MAIN="$(cd "$(dirname "$COMMON")" && pwd)"
WT_DIR="$MAIN/.worktrees/$BRANCH"

if [ -e "$WT_DIR" ]; then
  echo "worktree already exists: $WT_DIR" >&2
  exit 1
fi

mkdir -p "$MAIN/.worktrees"

# Create the worktree on a new branch from the current HEAD (or check out an
# existing branch of the same name — handy when resuming).
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git worktree add "$WT_DIR" "$BRANCH" >/dev/null
else
  git worktree add -b "$BRANCH" "$WT_DIR" >/dev/null
fi

# Always link root node_modules — needed by vitest / tsc / @types for any task.
ln -sfn "$MAIN/node_modules" "$WT_DIR/node_modules"

# Link a gitignored dir from main into the worktree if it exists in main.
link_if_present() {
  local rel="$1"
  if [ -e "$MAIN/$rel" ]; then
    mkdir -p "$WT_DIR/$(dirname "$rel")"
    ln -sfn "$MAIN/$rel" "$WT_DIR/$rel"
  fi
}

if [ "$FULL" = "1" ]; then
  link_if_present "vendor/vscode"
  link_if_present "out"
  link_if_present ".build"
  link_if_present ".dev-data"
fi

# Report mode accurately. (The earlier `${FULL:+...}` form was wrong: "0" is a
# non-empty string, so it always printed "full" even without --full.)
if [ "$FULL" = "1" ]; then
  MODE="full — vendor/out linked"
else
  MODE="node_modules only — unit tests OK"
fi
echo "created worktree: $WT_DIR (branch '$BRANCH', $MODE)"
echo "  cd \"$WT_DIR\""
