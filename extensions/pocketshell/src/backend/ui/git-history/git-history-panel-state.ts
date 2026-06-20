/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure state + HTML render for the Git History webview panel. Feature parity
 * with the PocketShell Android GitHistoryScreen (app §6): a tabbed Overview /
 * Commits / Issues surface.
 *
 * - Overview tab aggregates repo status (current branch, upstream, ahead/behind,
 *   dirty/clean, changed-files count, last-commit summary), the branch list
 *   (with upstream tracking), and the worktree list.
 * - Commits tab is a structured commit timeline (short-hash, author, date,
 *   subject) — NOT raw text.
 * - Issues tab (app §6 / #649) shows the repo's open GitHub issues via
 *   `gh issue list`, gated on `pocketshell github status`. Friendly hint when
 *   gh is missing/not-authed; hidden entirely for non-GitHub origins.
 *
 * The data is shaped from EXISTING GitClient methods (status/branches/log/
 * worktree) plus GitHubIssue rows + a gh-config descriptor for the Issues tab;
 * this module only aggregates/renders. Kept free of vscode imports so it is
 * unit-testable in isolation.
 */

import type {
  GitStatus,
  GitCommit,
  GitBranch,
  GitWorktree,
  GitHubIssue,
} from '../../git/types';

/** Panel tab — mirrors the app's Overview / Commits / Issues tabs. */
export type GitHistoryPanelTab = 'overview' | 'commits' | 'issues';

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

/** An issue row for the Issues tab (app §6 / #649). Mirrors GitHubIssue. */
export interface GitHubIssueRow {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'unknown';
  labels: string[];
  /** ISO 8601 timestamp from gh, or undefined. */
  updatedAt?: string;
  /**
   * Canonical `https://github.com/<owner>/<repo>/issues/<n>` URL for the
   * "Open issue on GitHub" action. Built by the host through
   * `detectGitHubOrigin`'s strict owner/repo gate (github-sourced), NEVER from
   * untrusted API input. Re-validated in the message handler before
   * `openExternal`. Optional so a row without a GitHub origin renders without
   * an open action.
   */
  url?: string;
}

/**
 * The Issues-tab gating state (app §6 / #645). Mirrors the app's
 * `(issues, ghHint)` pair: when gh is not configured we show a hint; when the
 * listing failed despite gh being configured we show a neutral unavailable
 * state; otherwise the list renders (possibly empty).
 */
export type GhGateState =
  /** gh is configured and the list loaded (may be empty for "no issues"). */
  | { kind: 'ready' }
  /** gh is missing/not-authed — show the configure-gh hint. */
  | { kind: 'hint'; hint: string }
  /** gh is configured but the listing failed — neutral "unavailable" state. */
  | { kind: 'unavailable' }
  /** The Issues tab isn't offered (non-GitHub origin, or repo missing). */
  | { kind: 'hidden' };

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
  /**
   * Issue rows (Issues tab). Undefined when the list wasn't fetched (tab hidden
   * or in a hint/unavailable state); an empty array is a real "no issues" state.
   */
  issues?: GitHubIssueRow[];
  /**
   * Issues-tab gating state. `hidden` when the origin isn't GitHub or the repo
   * is missing — the tab is then omitted from the nav.
   */
  issuesGate: GhGateState;
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
  /**
   * GitHub issues for the Issues tab (app §6 / #649). Omit when the tab is
   * hidden (non-GitHub origin) or in a hint/unavailable state; pass an empty
   * array for a real "no issues" state.
   */
  issues?: readonly GitHubIssue[];
  /**
   * Issues-tab gate. Defaults to `hidden` when omitted (so non-callers keep the
   * pre-Issues-tab behavior). Pass `ready` / `hint` / `unavailable` to populate.
   */
  issuesGate?: GhGateState;
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
  const missing = input.missing === true;

  // Issues tab: only meaningful for a GitHub origin that exists (not missing).
  // When the origin is non-GitHub or the repo is missing, the gate is `hidden`
  // and the tab is omitted from the nav. Otherwise honor the caller's gate
  // (ready/hint/unavailable) — the host fetches gh status + issues and decides.
  const issuesGate: GhGateState = (!github || missing)
    ? { kind: 'hidden' }
    : (input.issuesGate ?? { kind: 'hidden' });

  return {
    title: 'Git History',
    repoPath: input.repoPath,
    tab,
    status,
    branches: (input.branches ?? []).map(toBranchRow),
    worktrees: (input.worktrees ?? []).map(toWorktreeRow),
    commits: commitRows,
    // Issues rows are only populated when the gate is `ready`; otherwise the
    // tab shows a hint / unavailable / hidden state and rows are undefined.
    // The per-row "open issue" URL is built here from the trusted github.slug
    // (derived from originUrl via the strict detectGitHubOrigin gate) — NEVER
    // from untrusted API input.
    issues: issuesGate.kind === 'ready'
      ? (input.issues ?? []).map((issue) => toIssueRow(issue, github?.slug))
      : undefined,
    issuesGate,
    github,
    statusBanner: input.statusBanner,
    missing,
    emptyText: computeEmptyText(tab, missing, commitRows.length, (input.issues ?? []).length),
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
 * Map a GitHubIssue to a row. When [slug] (a trusted `owner/repo` from
 * `detectGitHubOrigin`) is provided, the per-row "open issue" URL is built as
 * `https://github.com/<slug>/issues/<n>` — github-sourced through the strict
 * origin gate, never from untrusted API input. The host re-validates this URL
 * before `openExternal`.
 */
function toIssueRow(issue: GitHubIssue, slug: string | undefined): GitHubIssueRow {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels,
    updatedAt: issue.updatedAt,
    url: slug ? `https://github.com/${slug}/issues/${issue.number}` : undefined,
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

/**
 * Strict allowlist validator for an "open issue on GitHub" URL before it is
 * handed to `vscode.env.openExternal` (security gate — see app §6 / #649 dispatch).
 *
 * Accepts ONLY `https://github.com/<owner>/<repo>/issues/<n>` (with an optional
 * trailing slash), where `<n>` is a positive integer. Rejects every other
 * scheme, host, path, query, fragment, or userinfo — so a crafted postMessage
 * (e.g. a `data:` URL, a `github.com.evil` host, a path that smuggles extra
 * segments, or a query/fragment that could redirect) cannot reach
 * `openExternal` as a non-`https://github.com/...` URL.
 *
 * The webview builds these URLs from the trusted `detectGitHubOrigin`
 * owner/repo gate + the issue number (github-sourced), but this re-validates
 * defensively at the trust boundary.
 */
export function isSafeGitHubIssueUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    return false;
  }
  if (url.username !== '' || url.password !== '') {
    return false;
  }
  if (url.search !== '' || url.hash !== '') {
    return false;
  }
  // Path must be exactly /<owner>/<repo>/issues/<n> (optional trailing slash).
  const match = url.pathname.match(/^\/[^/]+\/[^/]+\/issues\/(\d+)\/?$/);
  if (!match) {
    return false;
  }
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0;
}

function computeEmptyText(
  tab: GitHistoryPanelTab,
  missing: boolean,
  commitCount: number,
  issueCount: number,
): string {
  if (missing) {
    return 'Not a Git repository.';
  }
  if (tab === 'commits' && commitCount === 0) {
    return 'No commits yet.';
  }
  if (tab === 'issues' && issueCount === 0) {
    return 'This repository has no GitHub issues.';
  }
  return '';
}
