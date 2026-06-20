/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure state + HTML render for the Git History webview panel. Feature parity
 * with the PocketShell Android GitHistoryScreen (app §6): a tabbed Overview /
 * Commits surface. The Issues tab is a DEFERRED follow-up — the model is shaped
 * so a third tab can be added without a rewrite.
 *
 * - Overview tab aggregates repo status (current branch, upstream, ahead/behind,
 *   dirty/clean, changed-files count, last-commit summary), the branch list
 *   (with upstream tracking), and the worktree list.
 * - Commits tab is a structured commit timeline (short-hash, author, date,
 *   subject) — NOT raw text.
 *
 * The data is shaped from EXISTING GitClient methods (status/branches/log/
 * worktree); this module only aggregates/renders. Kept free of vscode imports
 * so it is unit-testable in isolation.
 */

import type {
  GitStatus,
  GitCommit,
  GitBranch,
  GitWorktree,
} from '../../git/types';

/** Panel tab — mirrors the app's Overview / Commits tabs. */
export type GitHistoryPanelTab = 'overview' | 'commits';

/** Normalized GitHub origin descriptor for the "Open on GitHub" action. */
export interface GitHubOrigin {
  /** Canonical web URL to the repository (e.g. https://github.com/owner/repo). */
  url: string;
  /** `owner/repo` slug. */
  slug: string;
}

/**
 * Repo status summary for the Overview tab, aggregated from GitClient.status()
 * + the last commit. We re-derive the display strings here rather than in the
 * extension host so the shape is unit-testable.
 */
export interface GitRepoStatusSummary {
  /** Current branch name (may be empty in a fresh repo). */
  branch: string;
  /** Upstream tracking ref, if any. */
  upstream?: string;
  /** Commits ahead of upstream. */
  ahead: number;
  /** Commits behind upstream. */
  behind: number;
  /** True when the working tree has no staged/unstaged/untracked changes. */
  isClean: boolean;
  /** Total changed files (staged + unstaged + untracked). */
  changedFiles: number;
  /** Last commit summary, if any commits exist. */
  lastCommit?: GitCommitSummary;
}

/** Trimmed view of a commit for the Overview "last commit" line. */
export interface GitCommitSummary {
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

/** A branch row for the Overview branches list. */
export interface GitBranchRow {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  /** Upstream tracking branch, if any. */
  tracking?: string;
}

/** A worktree row for the Overview worktrees list. */
export interface GitWorktreeRow {
  path: string;
  /** Branch checked out, or '(detached)' / '(bare)' for those states. */
  label: string;
  isMain: boolean;
  isBare: boolean;
  isLocked: boolean;
  isPrunable: boolean;
  /** Short HEAD hash, if known. */
  headShort?: string;
}

/** A commit row for the Commits timeline. */
export interface GitCommitRow {
  /** Full hash (stable key). */
  hash: string;
  shortHash: string;
  author: string;
  /** ISO 8601 date string. */
  date: string;
  subject: string;
  /** Number of changed files in the commit. */
  fileCount: number;
}

export interface GitHistoryPanelModel {
  title: string;
  /** Subtitle: the remote repo path the panel is scoped to. */
  repoPath: string;
  /** Active tab. */
  tab: GitHistoryPanelTab;
  /** Repo status summary (Overview). Undefined when the repo is missing/empty. */
  status?: GitRepoStatusSummary;
  /** Branch rows (Overview). */
  branches: GitBranchRow[];
  /** Worktree rows (Overview). */
  worktrees: GitWorktreeRow[];
  /** Commit rows (Commits). */
  commits: GitCommitRow[];
  /** GitHub origin when origin is a GitHub remote (enables "Open on GitHub"). */
  github?: GitHubOrigin;
  /** Status banner, if any. */
  statusBanner?: { tone: 'info' | 'success' | 'warning' | 'error'; message: string };
  /** True when the repo could not be read (missing / not a git repo). */
  missing: boolean;
  emptyText: string;
}

export interface GitHistoryPanelStateInput {
  repoPath: string;
  tab?: GitHistoryPanelTab;
  status?: GitStatus;
  branches?: readonly GitBranch[];
  worktrees?: readonly GitWorktree[];
  commits?: readonly GitCommit[];
  /** Raw origin remote URL, if configured. */
  originUrl?: string;
  statusBanner?: { tone: 'info' | 'success' | 'warning' | 'error'; message: string };
  /** True when the repo is missing/not a git repo. */
  missing?: boolean;
}

export interface GitHistoryPanelHtmlOptions {
  cspSource?: string;
  nonce?: string;
}

/**
 * Build the panel model from raw git data. Pure function. The Overview tab's
 * status summary is aggregated from `status` + the first commit (the most
 * recent) when available.
 */
export function buildGitHistoryPanelModel(input: GitHistoryPanelStateInput): GitHistoryPanelModel {
  const tab = input.tab ?? 'overview';
  const commits = input.commits ?? [];
  const commitRows = commits.map(toCommitRow);
  const status = summarizeStatus(input.status, commitRows[0]);
  const github = detectGitHubOrigin(input.originUrl);

  return {
    title: 'Git History',
    repoPath: input.repoPath,
    tab,
    status,
    branches: (input.branches ?? []).map(toBranchRow),
    worktrees: (input.worktrees ?? []).map(toWorktreeRow),
    commits: commitRows,
    github,
    statusBanner: input.statusBanner,
    missing: input.missing === true,
    emptyText: computeEmptyText(tab, input.missing === true, commitRows.length),
  };
}

/**
 * Aggregate a GitStatus + the latest commit into the Overview summary. Returns
 * undefined when no status was supplied (e.g. repo missing).
 */
function summarizeStatus(status: GitStatus | undefined, lastCommit?: GitCommitRow): GitRepoStatusSummary | undefined {
  if (!status) {
    return undefined;
  }
  const changedFiles = status.staged.length + status.unstaged.length + status.untracked.length;
  const upstream = extractUpstream(status.branch, status);
  return {
    branch: status.branch,
    upstream,
    ahead: status.ahead,
    behind: status.behind,
    isClean: status.isClean,
    changedFiles,
    lastCommit: lastCommit
      ? {
        shortHash: lastCommit.shortHash,
        author: lastCommit.author,
        date: lastCommit.date,
        subject: lastCommit.subject,
      }
      : undefined,
  };
}

/**
 * The porcelain status does not carry the upstream ref directly; we surface it
 * from the branch list in the host instead. When unavailable, return undefined.
 * (Branch list rows carry `tracking`; here we only have the GitStatus, so this
 * stays conservative — the panel wires upstream from the branches list.)
 */
function extractUpstream(_branch: string, _status: GitStatus): string | undefined {
  return undefined;
}

function toBranchRow(branch: GitBranch): GitBranchRow {
  return {
    name: branch.name,
    isCurrent: branch.isCurrent,
    isRemote: branch.isRemote,
    tracking: branch.tracking,
  };
}

function toWorktreeRow(worktree: GitWorktree): GitWorktreeRow {
  let label: string;
  if (worktree.isBare) {
    label = '(bare)';
  } else if (worktree.branch) {
    // Normalize refs/heads/<name> -> <name> for display.
    label = worktree.branch.replace(/^refs\/heads\//, '');
  } else {
    label = '(detached)';
  }
  return {
    path: worktree.path,
    label,
    isMain: worktree.isMain,
    isBare: worktree.isBare,
    isLocked: worktree.isLocked,
    isPrunable: worktree.isPrunable,
    headShort: worktree.head ? worktree.head.slice(0, 7) : undefined,
  };
}

function toCommitRow(commit: GitCommit): GitCommitRow {
  return {
    hash: commit.hash,
    shortHash: commit.shortHash,
    author: commit.author,
    date: commit.date,
    subject: commit.subject,
    fileCount: commit.files.length,
  };
}

/**
 * Detect a GitHub origin from a raw remote URL. Accepts HTTPS, SSH, and git@
 * forms. Returns undefined for non-GitHub remotes.
 *
 *   git@github.com:owner/repo.git         -> { url: 'https://github.com/owner/repo', slug: 'owner/repo' }
 *   https://github.com/owner/repo(.git)   -> { url: 'https://github.com/owner/repo', slug: 'owner/repo' }
 *   ssh://git@github.com/owner/repo.git   -> { url: 'https://github.com/owner/repo', slug: 'owner/repo' }
 *   git://github.com/owner/repo.git       -> { url: 'https://github.com/owner/repo', slug: 'owner/repo' }
 */
export function detectGitHubOrigin(originUrl: string | undefined): GitHubOrigin | undefined {
  if (!originUrl) {
    return undefined;
  }
  const raw = originUrl.trim();
  if (!raw) {
    return undefined;
  }
  // Normalize an SCP-style `git@host:owner/repo.git` to a URL-ish form.
  const scpMatch = raw.match(/^git@github\.com:([^/]+)\/(.+)$/);
  if (scpMatch) {
    const slug = `${scpMatch[1]}/${stripGit(scpMatch[2])}`;
    return { url: `https://github.com/${slug}`, slug };
  }
  // URL forms: ssh://, https://, git://
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'github.com') {
    return undefined;
  }
  // path is like /owner/repo(.git)
  const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  const slug = `${parts[0]}/${stripGit(parts[1])}`;
  return { url: `https://github.com/${slug}`, slug };
}

function stripGit(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -4) : name;
}

function computeEmptyText(tab: GitHistoryPanelTab, missing: boolean, commitCount: number): string {
  if (missing) {
    return 'Not a Git repository.';
  }
  if (tab === 'commits' && commitCount === 0) {
    return 'No commits yet.';
  }
  return '';
}
