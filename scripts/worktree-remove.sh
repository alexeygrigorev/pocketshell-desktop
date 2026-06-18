#!/usr/bin/env bash
# Remove a worktree created by worktree-create.sh and delete its branch.
#
# Usage: bash scripts/worktree-remove.sh <branch-name> [-f]
#   <branch-name>   the worktree at .worktrees/<branch-name>
#   -f              force-remove even if the worktree has uncommitted changes
#                   (the changes are discarded). Without -f, git refuses a dirty
#                   worktree — commit/branch first if you want to keep them.

set -euo pipefail

BRANCH="${1:-}"
FORCE=""
case "${2:-}" in
  -f|--force) FORCE="--force" ;;
  "") ;;
  *) echo "unknown option: ${2}" >&2; exit 1 ;;
esac

if [ -z "$BRANCH" ]; then
  echo "usage: bash scripts/worktree-remove.sh <branch-name> [-f]" >&2
  exit 1
fi

COMMON="$(git rev-parse --git-common-dir)"
MAIN="$(cd "$(dirname "$COMMON")" && pwd)"
WT_DIR="$MAIN/.worktrees/$BRANCH"

if [ ! -e "$WT_DIR" ]; then
  echo "no such worktree: $WT_DIR" >&2
  exit 1
fi

git worktree remove $FORCE "$WT_DIR"

# Delete the branch. -d refuses unmerged commits (safety); fall back to a clear
# message rather than silently nuking work.
if git branch -d "$BRANCH" 2>/dev/null; then
  echo "deleted branch '$BRANCH'"
else
  echo "branch '$BRANCH' not deleted (unmerged or already gone). Drop manually with:" >&2
  echo "  git branch -D '$BRANCH'" >&2
fi

echo "removed worktree: $WT_DIR"
