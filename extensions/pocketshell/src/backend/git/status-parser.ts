/**
 * Git output parsers for PocketShell Desktop.
 *
 * Pure functions that parse git command output into structured types.
 * No side effects — easy to test with fixture data.
 */

import type {
  GitStatus,
  GitFileStatus,
  GitCommit,
  GitCommitFileChange,
  GitBranch,
  GitWorktree,
  GitBlameLine,
} from './types';

// ---------------------------------------------------------------------------
// Status parser — git status --porcelain=v2 --branch
// ---------------------------------------------------------------------------

/**
 * Parse `git status --porcelain=v2 --branch` output into a GitStatus.
 *
 * Porcelain v2 format reference:
 *   # branch.oid <hash>
 *   # branch.head <branch>
 *   # branch.upstream <upstream>
 *   # branch.ab +N -M
 *   1 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <orig> <path>
 *   ? <path>
 *   ! <path>
 */
export function parseStatus(output: string): GitStatus {
  const lines = output.split('\n');

  let branch = '';
  let ahead = 0;
  let behind = 0;
  const staged: GitFileStatus[] = [];
  const unstaged: GitFileStatus[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const abPart = line.slice('# branch.ab '.length);
      const tokens = abPart.split(/\s+/);
      for (const token of tokens) {
        if (token.startsWith('+')) {
          ahead = parseInt(token.slice(1), 10) || 0;
        } else if (token.startsWith('-')) {
          behind = parseInt(token.slice(1), 10) || 0;
        }
      }
    } else if (line.startsWith('1 ')) {
      // Ordinary changed entry
      parseOrdinaryEntry(line, staged, unstaged);
    } else if (line.startsWith('2 ')) {
      // Renamed/copied entry
      parseRenamedEntry(line, staged, unstaged);
    } else if (line.startsWith('? ')) {
      // Untracked
      untracked.push(line.slice(2));
    }
    // Skip '!' (ignored) and comment lines we don't use
  }

  const isClean =
    staged.length === 0 &&
    unstaged.length === 0 &&
    untracked.length === 0 &&
    ahead === 0 &&
    behind === 0;

  return { branch, ahead, behind, staged, unstaged, untracked, isClean };
}

/**
 * Parse a porcelain v2 ordinary entry line:
 * `1 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
 *
 * xy is two chars: index status (staged) and worktree status (unstaged).
 */
function parseOrdinaryEntry(
  line: string,
  staged: GitFileStatus[],
  unstaged: GitFileStatus[],
): void {
  const parts = line.split(/\s+/);
  if (parts.length < 9) return;

  const xy = parts[1]; // e.g. "M " or " M" or "MM" or "A " etc.
  const path = parts.slice(8).join(' '); // path may contain spaces

  const indexStatus = xy[0]; // staged
  const wtStatus = xy[1]; // unstaged

  // Staged (index) status
  const stagedFile = fileStatusFromCode(indexStatus, path);
  if (stagedFile) {
    staged.push(stagedFile);
  }

  // Unstaged (worktree) status
  const unstagedFile = fileStatusFromCode(wtStatus, path);
  if (unstagedFile) {
    unstaged.push(unstagedFile);
  }
}

/**
 * Parse a porcelain v2 renamed/copied entry line:
 * `2 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <orig> <path>`
 */
function parseRenamedEntry(
  line: string,
  staged: GitFileStatus[],
  unstaged: GitFileStatus[],
): void {
  const parts = line.split(/\s+/);
  if (parts.length < 10) return;

  const xy = parts[1];
  // parts[8] is X<score>, e.g. R100
  const oldPath = parts[9];
  const newPath = parts.slice(10).join(' ');

  const indexStatus = xy[0];
  const wtStatus = xy[1];

  const stagedFile = fileStatusFromCode(indexStatus, newPath, oldPath);
  if (stagedFile) {
    staged.push(stagedFile);
  }

  const unstagedFile = fileStatusFromCode(wtStatus, newPath, oldPath);
  if (unstagedFile) {
    unstaged.push(unstagedFile);
  }
}

/**
 * Convert a single-char status code to a GitFileStatus, or null if no change.
 */
function fileStatusFromCode(
  code: string,
  path: string,
  oldPath?: string,
): GitFileStatus | null {
  switch (code) {
    case 'A':
      return { path, status: 'added' };
    case 'M':
      return { path, status: 'modified' };
    case 'D':
      return { path, status: 'deleted' };
    case 'R':
      return { path, status: 'renamed', oldPath };
    case 'C':
      return { path, status: 'copied', oldPath };
    default:
      return null; // '.', ' ', '?' — no change in this slot
  }
}

// ---------------------------------------------------------------------------
// Log parser — git log --format=...
// ---------------------------------------------------------------------------

/**
 * Parse `git log` output with a specific format.
 *
 * Expected format string:
 *   --format=ENDCOMMIT%x00%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b%x00
 * followed by optional `--numstat` lines:
 *   <insertions>\t<deletions>\t<path>
 *
 * Each commit is delimited by "ENDCOMMIT\0", fields separated by \0.
 */
export function parseLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  const trimmed = output.trim();
  if (!trimmed) return commits;

  // Split by the commit delimiter
  const entries = trimmed.split('ENDCOMMIT\x00');

  for (const entry of entries) {
    const fields = entry.split('\x00');
    if (fields.length < 7) continue;

    const hash = fields[0];
    const shortHash = fields[1];
    const author = fields[2];
    const authorEmail = fields[3];
    const date = fields[4];
    const subject = fields[5];
    const body = fields[6];
    const numstat = fields.slice(7).join('\x00');

    if (!hash) continue;

    commits.push({
      hash,
      shortHash,
      author,
      authorEmail,
      date,
      subject,
      body: body || undefined,
      files: parseNumstat(numstat),
    });
  }

  return commits;
}

function parseNumstat(output: string): GitCommitFileChange[] {
  const files: GitCommitFileChange[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      continue;
    }
    const match = trimmed.match(/^([0-9-]+)\t([0-9-]+)\t(.+)$/);
    if (!match) {
      continue;
    }
    const binary = match[1] === '-' || match[2] === '-';
    const rename = parseRenamePath(match[3]);
    files.push({
      path: rename.path,
      oldPath: rename.oldPath,
      insertions: binary ? undefined : parseInt(match[1], 10),
      deletions: binary ? undefined : parseInt(match[2], 10),
      binary,
    });
  }
  return files;
}

function parseRenamePath(path: string): { path: string; oldPath?: string } {
  const braceRename = path.match(/^(.*)\{(.+) => (.+)\}(.*)$/);
  if (braceRename) {
    return {
      oldPath: `${braceRename[1]}${braceRename[2]}${braceRename[4]}`,
      path: `${braceRename[1]}${braceRename[3]}${braceRename[4]}`,
    };
  }
  const simpleRename = path.match(/^(.+) => (.+)$/);
  if (simpleRename) {
    return {
      oldPath: simpleRename[1],
      path: simpleRename[2],
    };
  }
  return { path };
}

// ---------------------------------------------------------------------------
// Branch parser — git branch -a (with optional -vv for tracking)
// ---------------------------------------------------------------------------

/**
 * Parse `git branch -a` or `git branch -vv` output.
 *
 * Format:
 *   * main                 7a3b2c1 [origin/main] commit msg
 *     feature              a1b2c3d commit msg
 *   remotes/origin/main    7a3b2c1 commit msg
 */
export function parseBranches(output: string): GitBranch[] {
  const branches: GitBranch[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    const isCurrent = line.startsWith('*');
    const trimmed = line.replace(/^\*?\s+/, ''); // Remove leading "* " or "  "

    if (!trimmed) continue;

    let isRemote = false;
    let name = trimmed;
    let tracking: string | undefined;

    // Check if remote branch
    if (name.startsWith('remotes/')) {
      isRemote = true;
      name = name;
    }

    // Extract branch name and tracking info from `git branch -vv` output
    // Format: "branch_name  hash [tracking] subject"
    // Or for plain `git branch -a`: "branch_name" or "remotes/origin/name"
    const match = name.match(/^(\S+)\s+(\S+)\s+\[([^\]]+)\]/);
    if (match) {
      name = match[1];
      tracking = match[3];
    } else {
      // Plain format: just the branch name (maybe followed by hash and subject)
      // Take only the first token as the name
      const firstToken = name.match(/^(\S+)/);
      if (firstToken) {
        name = firstToken[1];
      }
    }

    // For remotes, strip the "remotes/" prefix for display but keep the full
    // reference as the name since that's how git refers to them.
    branches.push({
      name,
      isCurrent,
      isRemote,
      tracking,
    });
  }

  return branches;
}

// ---------------------------------------------------------------------------
// Worktree parser — git worktree list --porcelain
// ---------------------------------------------------------------------------

/**
 * Parse `git worktree list --porcelain` output into GitWorktree[].
 *
 * Porcelain format (records separated by blank lines):
 *   worktree /path/to/main
 *   HEAD <hash>
 *   branch refs/heads/<name>
 *
 *   worktree /path/to/linked           (may be absent if bare)
 *   HEAD <hash>
 *   detached
 *   locked <reason>
 *
 *   bare                                (bare repo entry — no worktree line)
 *
 * The first record is the main worktree (unless it is a bare repo, in which
 * case the first record is the `bare` entry). Flags `locked`/`prunable` may be
 * followed by an arbitrary reason string on the same line.
 */
export function parseWorktree(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  const trimmed = output.replace(/\s+$/, '');
  if (!trimmed) {
    return worktrees;
  }
  // Records are separated by one or more blank lines.
  const records = trimmed.split(/\n\s*\n/);

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const lines = record.split('\n');
    let path = '';
    let head: string | undefined;
    let branch: string | undefined;
    let isBare = false;
    let isLocked = false;
    let isPrunable = false;
    let reason: string | undefined;
    let sawWorktreeLine = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length);
        sawWorktreeLine = true;
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length);
      } else if (line === 'bare') {
        isBare = true;
        // A bare entry has no `worktree` line; its path (if any) comes from a
        // preceding `worktree` line — but per porcelain spec bare entries are
        // their own record. Leave path empty if no worktree line was seen.
      } else if (line === 'detached') {
        branch = undefined; // detached HEAD — no branch ref
      } else if (line === 'locked') {
        isLocked = true;
      } else if (line.startsWith('locked ')) {
        isLocked = true;
        reason = line.slice('locked '.length);
      } else if (line === 'prunable') {
        isPrunable = true;
      } else if (line.startsWith('prunable ')) {
        isPrunable = true;
        reason = line.slice('prunable '.length);
      }
    }

    // Skip malformed records without a path or a bare marker.
    if (!sawWorktreeLine && !isBare) {
      continue;
    }

    worktrees.push({
      path,
      head,
      branch,
      // First record is the main worktree (or the bare repo itself).
      isMain: index === 0,
      isBare,
      isLocked,
      isPrunable,
      reason,
    });
  }

  return worktrees;
}

// ---------------------------------------------------------------------------
// Blame parser — git blame --porcelain
// ---------------------------------------------------------------------------

/**
 * Parse `git blame --porcelain` output into blame lines.
 *
 * Porcelain blame format (simplified):
 *   <hash> <orig_line> <final_line> [<num_lines>]
 *   author <name>
 *   author-mail <email>
 *   author-time <timestamp>
 *   author-tz <tz>
 *   summary <subject>
 *   <tab><content>
 *
 * We parse enough to extract hash, author, date, line number, and content.
 */
export function parseBlame(output: string): GitBlameLine[] {
  const lines: GitBlameLine[] = [];

  // Current commit being accumulated
  let currentHash = '';
  let currentAuthor = '';
  let currentDate = '';
  let currentLineNum = 0;
  let currentContent = '';

  const rawLines = output.split('\n');

  for (const rawLine of rawLines) {
    // Header line: <hash> <orig_line> <final_line> [<num_lines>]
    const headerMatch = rawLine.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)/);
    if (headerMatch) {
      // Save previous entry if any
      if (currentHash && currentContent) {
        lines.push({
          line: currentLineNum,
          hash: currentHash,
          author: currentAuthor,
          date: currentDate,
          content: currentContent,
        });
      }

      currentHash = headerMatch[1];
      currentLineNum = parseInt(headerMatch[3], 10);
      currentContent = '';
      continue;
    }

    if (rawLine.startsWith('author ')) {
      currentAuthor = rawLine.slice('author '.length);
    } else if (rawLine.startsWith('author-time ')) {
      const ts = parseInt(rawLine.slice('author-time '.length), 10);
      currentDate = new Date(ts * 1000).toISOString();
    } else if (rawLine.startsWith('\t')) {
      // Content line
      currentContent = rawLine.slice(1);
    }
  }

  // Save last entry
  if (currentHash) {
    lines.push({
      line: currentLineNum,
      hash: currentHash,
      author: currentAuthor,
      date: currentDate,
      content: currentContent,
    });
  }

  return lines;
}
