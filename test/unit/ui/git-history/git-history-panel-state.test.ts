/**
 * Unit tests for the Git History webview panel state + HTML.
 *
 * Covers: state shape, tab switching, the postMessage round-trips the panel
 * uses (refresh / switchTab / openGitHub), origin→GitHub detection, and the
 * empty / missing-repo states.
 */

import { describe, expect, it } from 'vitest';
import {
  buildGitHistoryPanelModel,
  detectGitHubOrigin,
  isSafeGitHubIssueUrl,
  type GitHistoryPanelStateInput,
} from '../../../../src/ui/git-history/git-history-panel-state';
import { renderGitHistoryPanelHtml } from '../../../../src/ui/git-history/git-history-panel-html';
import type {
  GitStatus,
  GitCommit,
  GitBranch,
  GitWorktree,
  GitHubIssue,
} from '../../../../src/git/types';

function makeStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    isClean: true,
    ...overrides,
  };
}

function makeCommit(overrides: Partial<GitCommit> = {}): GitCommit {
  return {
    hash: '0123456789abcdef0123456789abcdef01234567',
    shortHash: '0123456',
    author: 'Alice',
    authorEmail: 'alice@example.com',
    date: '2026-06-01T12:00:00',
    subject: 'Initial commit',
    files: [],
    ...overrides,
  };
}

function makeBranch(overrides: Partial<GitBranch> = {}): GitBranch {
  return { name: 'main', isCurrent: true, isRemote: false, ...overrides };
}

function makeWorktree(overrides: Partial<GitWorktree> = {}): GitWorktree {
  return {
    path: '/home/user/repo',
    head: '0123456789abcdef0123456789abcdef01234567',
    branch: 'refs/heads/main',
    isMain: true,
    isBare: false,
    isLocked: false,
    isPrunable: false,
    ...overrides,
  };
}

function baseInput(overrides: Partial<GitHistoryPanelStateInput> = {}): GitHistoryPanelStateInput {
  return {
    repoPath: 'host:/home/user/repo',
    status: makeStatus(),
    branches: [makeBranch()],
    worktrees: [makeWorktree()],
    commits: [makeCommit()],
    ...overrides,
  };
}

describe('buildGitHistoryPanelModel — state shape', () => {
  it('defaults to the overview tab and aggregates repo status', () => {
    const model = buildGitHistoryPanelModel(baseInput());
    expect(model.tab).toBe('overview');
    expect(model.missing).toBe(false);
    expect(model.status?.branch).toBe('main');
    expect(model.status?.isClean).toBe(true);
    expect(model.status?.changedFiles).toBe(0);
    expect(model.status?.lastCommit?.shortHash).toBe('0123456');
  });

  it('computes changedFiles as staged + unstaged + untracked', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      status: makeStatus({
        isClean: false,
        staged: [{ path: 'a', status: 'modified' }],
        unstaged: [{ path: 'b', status: 'modified' }],
        untracked: ['c'],
      }),
    }));
    expect(model.status?.changedFiles).toBe(3);
    expect(model.status?.isClean).toBe(false);
  });

  it('maps branches + worktrees into rows, normalizing branch refs', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      branches: [
        makeBranch({ name: 'main', isCurrent: true, tracking: 'origin/main' }),
        makeBranch({ name: 'remotes/origin/dev', isCurrent: false, isRemote: true }),
      ],
      worktrees: [
        makeWorktree({ path: '/r', branch: 'refs/heads/main', isMain: true }),
        makeWorktree({ path: '/r2', branch: undefined, isMain: false }),
        makeWorktree({ path: '/r3', isMain: false, isBare: true, branch: undefined }),
      ],
    }));
    expect(model.branches).toHaveLength(2);
    expect(model.branches[0].tracking).toBe('origin/main');
    expect(model.branches[1].isRemote).toBe(true);
    expect(model.worktrees).toHaveLength(3);
    expect(model.worktrees[0].label).toBe('main');
    expect(model.worktrees[1].label).toBe('(detached)');
    expect(model.worktrees[2].label).toBe('(bare)');
    expect(model.worktrees[0].headShort).toBe('0123456');
  });

  it('maps commits into the timeline rows with file counts', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      commits: [
        makeCommit({ shortHash: 'aaaaaaa', subject: 'first', files: [
          { path: 'a', binary: false, insertions: 1, deletions: 1 },
        ] }),
        makeCommit({ shortHash: 'bbbbbbb', subject: 'second', files: [] }),
      ],
    }));
    expect(model.commits).toHaveLength(2);
    expect(model.commits[0].shortHash).toBe('aaaaaaa');
    expect(model.commits[0].fileCount).toBe(1);
    expect(model.commits[1].fileCount).toBe(0);
  });
});

describe('buildGitHistoryPanelModel — tabs', () => {
  it('honors an explicit commits tab', () => {
    const model = buildGitHistoryPanelModel(baseInput({ tab: 'commits' }));
    expect(model.tab).toBe('commits');
  });

  it('emptyText reports not-a-repo when missing, and no-commits on empty commits tab', () => {
    const missing = buildGitHistoryPanelModel(baseInput({ missing: true }));
    expect(missing.missing).toBe(true);
    expect(missing.emptyText).toBe('Not a Git repository.');

    const emptyCommits = buildGitHistoryPanelModel(baseInput({ tab: 'commits', commits: [] }));
    expect(emptyCommits.emptyText).toBe('No commits yet.');
  });
});

describe('detectGitHubOrigin', () => {
  it('returns undefined for empty / missing input', () => {
    expect(detectGitHubOrigin(undefined)).toBeUndefined();
    expect(detectGitHubOrigin('')).toBeUndefined();
    expect(detectGitHubOrigin('   ')).toBeUndefined();
  });

  it('parses SCP-style git@ URLs', () => {
    expect(detectGitHubOrigin('git@github.com:owner/repo.git')).toEqual({
      url: 'https://github.com/owner/repo',
      slug: 'owner/repo',
    });
  });

  it('parses HTTPS URLs (with and without .git)', () => {
    expect(detectGitHubOrigin('https://github.com/owner/repo.git')).toEqual({
      url: 'https://github.com/owner/repo',
      slug: 'owner/repo',
    });
    expect(detectGitHubOrigin('https://github.com/owner/repo').slug).toBe('owner/repo');
  });

  it('parses ssh:// and git:// URLs', () => {
    expect(detectGitHubOrigin('ssh://git@github.com/owner/repo.git')?.slug).toBe('owner/repo');
    expect(detectGitHubOrigin('git://github.com/owner/repo.git')?.slug).toBe('owner/repo');
  });

  it('returns undefined for non-GitHub remotes', () => {
    expect(detectGitHubOrigin('git@gitlab.com:owner/repo.git')).toBeUndefined();
    expect(detectGitHubOrigin('https://bitbucket.org/owner/repo')).toBeUndefined();
  });

  it('returns undefined for malformed github paths', () => {
    expect(detectGitHubOrigin('https://github.com/onlyone')).toBeUndefined();
  });

  it('wires the origin into the model when present', () => {
    const model = buildGitHistoryPanelModel(baseInput({ originUrl: 'git@github.com:owner/repo.git' }));
    expect(model.github?.slug).toBe('owner/repo');
    expect(model.github?.url).toBe('https://github.com/owner/repo');
  });

  it('leaves github undefined for a non-GitHub origin', () => {
    const model = buildGitHistoryPanelModel(baseInput({ originUrl: 'git@gitlab.com:owner/repo.git' }));
    expect(model.github).toBeUndefined();
  });
});

describe('renderGitHistoryPanelHtml — postMessage round-trips', () => {
  it('renders Overview + Commits tab buttons, and Issues only for GitHub origins', () => {
    // Non-GitHub origin: only Overview + Commits (Issues tab is hidden).
    const nonGithub = buildGitHistoryPanelModel(baseInput());
    const htmlNon = renderGitHistoryPanelHtml(nonGithub, { nonce: 'n', cspSource: 'https://host' });
    expect(htmlNon).toContain('data-tab="overview"');
    expect(htmlNon).toContain('data-tab="commits"');
    expect(htmlNon).not.toContain('data-tab="issues"');

    // GitHub origin with a ready gate: all three tabs render.
    const github = buildGitHistoryPanelModel(baseInput({
      originUrl: 'git@github.com:owner/repo.git',
      issuesGate: { kind: 'ready' },
      issues: [{ number: 1, title: 'first', state: 'open', labels: [] }],
    }));
    const htmlGh = renderGitHistoryPanelHtml(github, { nonce: 'n', cspSource: 'https://host' });
    expect(htmlGh).toContain('data-tab="issues"');
  });

  it('posts switchTab from a tab button', () => {
    const model = buildGitHistoryPanelModel(baseInput());
    const html = renderGitHistoryPanelHtml(model);
    // The webview JS posts switchTab when a non-active tab is clicked.
    expect(html).toMatch(/switchTab/);
    expect(html).toContain("vscode.postMessage({ action: 'switchTab', tab })");
  });

  it('posts refresh from the Refresh button', () => {
    const model = buildGitHistoryPanelModel(baseInput());
    const html = renderGitHistoryPanelHtml(model);
    expect(html).toContain('data-action="refresh"');
    expect(html).toContain("vscode.postMessage({ action: 'refresh' })");
  });

  it('renders the Open on GitHub button + posts openGitHub with the URL when origin is GitHub', () => {
    const model = buildGitHistoryPanelModel(baseInput({ originUrl: 'git@github.com:owner/repo.git' }));
    const html = renderGitHistoryPanelHtml(model);
    expect(html).toContain('data-action="openGitHub"');
    expect(html).toContain('data-url="https://github.com/owner/repo"');
    expect(html).toContain("vscode.postMessage({ action: 'openGitHub', url })");
  });

  it('omits the Open on GitHub button when origin is not GitHub', () => {
    const model = buildGitHistoryPanelModel(baseInput({ originUrl: 'git@gitlab.com:owner/repo.git' }));
    const html = renderGitHistoryPanelHtml(model);
    expect(html).not.toContain('data-action="openGitHub"');
  });

  it('CSP includes the nonce on script-src when a nonce is supplied', () => {
    const model = buildGitHistoryPanelModel(baseInput());
    const html = renderGitHistoryPanelHtml(model, { nonce: 'abc123', cspSource: 'https://x' });
    // The CSP string is HTML-escaped inside the meta tag.
    expect(html).toMatch(/script-src &#39;nonce-abc123&#39;/);
    expect(html).toContain('nonce="abc123"');
  });

  it('renders the missing-repo empty state on the Overview tab', () => {
    const model = buildGitHistoryPanelModel(baseInput({ missing: true, status: undefined }));
    const html = renderGitHistoryPanelHtml(model);
    expect(html).toContain('Not a Git repository.');
  });

  it('renders the commit timeline on the Commits tab with short hashes + subjects', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      tab: 'commits',
      commits: [makeCommit({ shortHash: 'deadbee', subject: 'Fix bug' })],
    }));
    const html = renderGitHistoryPanelHtml(model);
    expect(html).toContain('deadbee');
    expect(html).toContain('Fix bug');
  });
});

// ---------------------------------------------------------------------------
// Issues tab (app §6 / #649)
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 42,
    title: 'Sample issue',
    state: 'open',
    labels: [],
    updatedAt: '2026-06-09T10:11:12Z',
    ...overrides,
  };
}

describe('buildGitHistoryPanelModel — Issues tab gating', () => {
  it('hides the Issues tab for a non-GitHub origin', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      originUrl: 'git@gitlab.com:owner/repo.git',
      issuesGate: { kind: 'ready' },
      issues: [makeIssue()],
    }));
    expect(model.issuesGate.kind).toBe('hidden');
    expect(model.issues).toBeUndefined();
  });

  it('hides the Issues tab for a missing repo', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      missing: true,
      originUrl: 'git@github.com:owner/repo.git',
      issuesGate: { kind: 'ready' },
    }));
    expect(model.issuesGate.kind).toBe('hidden');
  });

  it('defaults the gate to hidden when omitted (even for a GitHub origin)', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      originUrl: 'git@github.com:owner/repo.git',
    }));
    expect(model.issuesGate.kind).toBe('hidden');
    expect(model.issues).toBeUndefined();
  });

  it('honors a ready gate for a GitHub origin and maps issue rows', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      originUrl: 'git@github.com:owner/repo.git',
      issuesGate: { kind: 'ready' },
      issues: [
        makeIssue({ number: 100, title: 'Bug A', state: 'open', labels: ['bug'] }),
        makeIssue({ number: 99, title: 'Closed one', state: 'closed', labels: [] }),
      ],
    }));
    expect(model.issuesGate.kind).toBe('ready');
    expect(model.issues).toHaveLength(2);
    expect(model.issues?.[0]).toEqual({
      number: 100,
      title: 'Bug A',
      state: 'open',
      labels: ['bug'],
      updatedAt: '2026-06-09T10:11:12Z',
      url: 'https://github.com/owner/repo/issues/100',
    });
    expect(model.issues?.[1].url).toBe('https://github.com/owner/repo/issues/99');
    expect(model.issues?.[1].state).toBe('closed');
  });

  it('builds the per-row URL through the detectGitHubOrigin slug (trusted), not API input', () => {
    // The URL is rebuilt from the origin's owner/repo + the issue number,
    // never from any untrusted field on the issue. A different origin slug
    // yields a different (still github-sourced) URL.
    const ssh = buildGitHistoryPanelModel(baseInput({
      originUrl: 'ssh://git@github.com/acme/widgets.git',
      issuesGate: { kind: 'ready' },
      issues: [makeIssue({ number: 7 })],
    }));
    expect(ssh.issues?.[0].url).toBe('https://github.com/acme/widgets/issues/7');
  });

  it('leaves the URL undefined when the origin is non-GitHub (gate forced hidden)', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      originUrl: 'git@gitlab.com:owner/repo.git',
      issuesGate: { kind: 'ready' },
      issues: [makeIssue({ number: 5 })],
    }));
    expect(model.issuesGate.kind).toBe('hidden');
    expect(model.issues).toBeUndefined();
  });

  it('carries a hint gate verbatim and omits issue rows', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      originUrl: 'git@github.com:owner/repo.git',
      issuesGate: { kind: 'hint', hint: 'run `gh auth login`' },
    }));
    expect(model.issuesGate).toEqual({ kind: 'hint', hint: 'run `gh auth login`' });
    expect(model.issues).toBeUndefined();
  });

  it('carries an unavailable gate and omits issue rows', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      originUrl: 'git@github.com:owner/repo.git',
      issuesGate: { kind: 'unavailable' },
    }));
    expect(model.issuesGate.kind).toBe('unavailable');
    expect(model.issues).toBeUndefined();
  });

  it('emptyText reports "no issues" on an empty issues tab', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      tab: 'issues',
      originUrl: 'git@github.com:owner/repo.git',
      issuesGate: { kind: 'ready' },
      issues: [],
    }));
    expect(model.emptyText).toBe('This repository has no GitHub issues.');
  });
});

describe('renderGitHistoryPanelHtml — Issues tab states', () => {
  const githubOrigin = 'git@github.com:owner/repo.git';

  it('omits the Issues tab nav button for a non-GitHub origin', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      originUrl: 'git@gitlab.com:owner/repo.git',
    }));
    const html = renderGitHistoryPanelHtml(model);
    expect(html).not.toContain('data-tab="issues"');
  });

  it('renders the Issues tab nav button for a GitHub origin with a non-hidden gate', () => {
    for (const gate of [
      { kind: 'ready' as const },
      { kind: 'hint' as const, hint: 'x' },
      { kind: 'unavailable' as const },
    ]) {
      const model = buildGitHistoryPanelModel(baseInput({
        originUrl: githubOrigin,
        issuesGate: gate,
      }));
      const html = renderGitHistoryPanelHtml(model);
      expect(html).toContain('data-tab="issues"');
    }
  });

  it('renders the configure-gh hint card when the gate is hint', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      tab: 'issues',
      originUrl: githubOrigin,
      issuesGate: { kind: 'hint', hint: 'install gh and run `gh auth login`' },
    }));
    const html = renderGitHistoryPanelHtml(model);
    expect(html).toContain('Configure gh to see issues');
    expect(html).toContain('install gh and run `gh auth login`');
    expect(html).not.toContain('data-action="openIssue"');
  });

  it('renders the unavailable card when the gate is unavailable', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      tab: 'issues',
      originUrl: githubOrigin,
      issuesGate: { kind: 'unavailable' },
    }));
    const html = renderGitHistoryPanelHtml(model);
    expect(html).toContain('Issues unavailable');
    expect(html).toContain("Couldn't list GitHub issues");
  });

  it('renders the empty state when ready with zero issues', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      tab: 'issues',
      originUrl: githubOrigin,
      issuesGate: { kind: 'ready' },
      issues: [],
    }));
    const html = renderGitHistoryPanelHtml(model);
    expect(html).toContain('This repository has no GitHub issues.');
  });

  it('renders issue rows with number, title, labels, an open button + the openIssue action', () => {
    const model = buildGitHistoryPanelModel(baseInput({
      tab: 'issues',
      originUrl: githubOrigin,
      issuesGate: { kind: 'ready' },
      issues: [
        makeIssue({ number: 100, title: 'Bug A', state: 'open', labels: ['bug', 'ui'] }),
        makeIssue({ number: 99, title: 'Done', state: 'closed', labels: [] }),
      ],
    }));
    const html = renderGitHistoryPanelHtml(model);
    expect(html).toContain('#100');
    expect(html).toContain('Bug A');
    expect(html).toContain('#99');
    expect(html).toContain('Done');
    // Labels render as pills.
    expect(html).toContain('>bug<');
    expect(html).toContain('>ui<');
    // Per-row Open button posts openIssue with the github-sourced URL.
    expect(html).toContain('data-action="openIssue"');
    expect(html).toContain('data-url="https://github.com/owner/repo/issues/100"');
    expect(html).toContain('data-url="https://github.com/owner/repo/issues/99"');
    expect(html).toContain("vscode.postMessage({ action: 'openIssue', url })");
  });
});

// ---------------------------------------------------------------------------
// isSafeGitHubIssueUrl — the openExternal security gate
// ---------------------------------------------------------------------------

describe('isSafeGitHubIssueUrl', () => {
  it('accepts a canonical https://github.com/<owner>/<repo>/issues/<n> URL', () => {
    expect(isSafeGitHubIssueUrl('https://github.com/owner/repo/issues/649')).toBe(true);
    expect(isSafeGitHubIssueUrl('https://github.com/acme/widgets/issues/1')).toBe(true);
  });

  it('accepts an optional trailing slash', () => {
    expect(isSafeGitHubIssueUrl('https://github.com/owner/repo/issues/649/')).toBe(true);
  });

  it('rejects a non-https scheme', () => {
    expect(isSafeGitHubIssueUrl('http://github.com/owner/repo/issues/1')).toBe(false);
    expect(isSafeGitHubIssueUrl('ssh://github.com/owner/repo/issues/1')).toBe(false);
    expect(isSafeGitHubIssueUrl('ftp://github.com/owner/repo/issues/1')).toBe(false);
  });

  it('rejects a non-github.com host (including look-alike / subdomain tricks)', () => {
    expect(isSafeGitHubIssueUrl('https://github.com.evil.com/owner/repo/issues/1')).toBe(false);
    expect(isSafeGitHubIssueUrl('https://evil.com/owner/repo/issues/1')).toBe(false);
    expect(isSafeGitHubIssueUrl('https://www.github.com/owner/repo/issues/1')).toBe(false);
    expect(isSafeGitHubIssueUrl('https://github.evil.com/owner/repo/issues/1')).toBe(false);
  });

  it('rejects userinfo (credentials in the authority)', () => {
    expect(isSafeGitHubIssueUrl('https://user@github.com/owner/repo/issues/1')).toBe(false);
    expect(isSafeGitHubIssueUrl('https://user:pass@github.com/owner/repo/issues/1')).toBe(false);
  });

  it('rejects a query string', () => {
    expect(isSafeGitHubIssueUrl('https://github.com/owner/repo/issues/1?redirect=https://evil.com')).toBe(false);
    expect(isSafeGitHubIssueUrl('https://github.com/owner/repo/issues/1?x=1')).toBe(false);
  });

  it('rejects a fragment', () => {
    expect(isSafeGitHubIssueUrl('https://github.com/owner/repo/issues/1#evil')).toBe(false);
  });

  it('rejects paths that smuggle extra segments or drop required ones', () => {
    // Too few segments.
    expect(isSafeGitHubIssueUrl('https://github.com/issues/1')).toBe(false);
    expect(isSafeGitHubIssueUrl('https://github.com/owner/issues/1')).toBe(false);
    // Extra path segment (e.g. a path-traversal-style redirect).
    expect(isSafeGitHubIssueUrl('https://github.com/owner/repo/issues/1/evil')).toBe(false);
    expect(isSafeGitHubIssueUrl('https://github.com/owner/repo/extra/issues/1')).toBe(false);
    // Wrong final segment.
    expect(isSafeGitHubIssueUrl('https://github.com/owner/repo/pulls/1')).toBe(false);
  });

  it('rejects a non-positive or non-numeric issue number', () => {
    expect(isSafeGitHubIssueUrl('https://github.com/owner/repo/issues/0')).toBe(false);
    expect(isSafeGitHubIssueUrl('https://github.com/owner/repo/issues/-5')).toBe(false);
    expect(isSafeGitHubIssueUrl('https://github.com/owner/repo/issues/abc')).toBe(false);
  });

  it('rejects malformed / unparseable input', () => {
    expect(isSafeGitHubIssueUrl('')).toBe(false);
    expect(isSafeGitHubIssueUrl('not a url')).toBe(false);
    expect(isSafeGitHubIssueUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeGitHubIssueUrl('data:text/html,<script>')).toBe(false);
  });

  it('rejects a data: or javascript: URL even if it mentions github', () => {
    expect(isSafeGitHubIssueUrl('data:text/html,https://github.com/owner/repo/issues/1')).toBe(false);
  });
});
