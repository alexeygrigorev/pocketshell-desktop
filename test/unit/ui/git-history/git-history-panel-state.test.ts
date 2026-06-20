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
  type GitHistoryPanelStateInput,
} from '../../../../src/ui/git-history/git-history-panel-state';
import { renderGitHistoryPanelHtml } from '../../../../src/ui/git-history/git-history-panel-html';
import type {
  GitStatus,
  GitCommit,
  GitBranch,
  GitWorktree,
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
  it('renders both Overview and Commits tab buttons', () => {
    const model = buildGitHistoryPanelModel(baseInput());
    const html = renderGitHistoryPanelHtml(model, { nonce: 'n', cspSource: 'https://host' });
    expect(html).toContain('data-tab="overview"');
    expect(html).toContain('data-tab="commits"');
    // The Issues tab is deferred — there should be no third tab.
    expect(html).not.toContain('data-tab="issues"');
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
