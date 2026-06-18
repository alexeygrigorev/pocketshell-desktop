# Process

PocketShell Desktop uses the same three-actor process as PocketShell Android:
orchestrator + implementer + reviewer. This file adapts the Android process for
desktop/Electron development.

## Parallelism

The orchestrator dispatches **multiple implementer/research agents in parallel**
whenever possible. Independent issues should not wait for each other. The
orchestrator tracks each agent and processes results as they complete.

Typical parallel dispatch patterns:
- Multiple implementers on non-overlapping files (e.g., #31 strip extensions
  + #32 update build scripts)
- Research agents alongside implementers (e.g., investigate pre-build while
  fixing compilation errors)
- Reviewer agents for completed implementers while other implementers are still running

Rule: prefer non-overlapping file scope so branches merge cleanly. With
worktree isolation (below), agents CAN edit the same files in parallel — each
gets its own checkout — but overlapping scope still risks merge conflicts, so
keep scope disjoint when you can and run sequentially when overlap is
unavoidable.

## Worktree isolation

Implementer and reviewer agents work in **dedicated git worktrees** under
`.worktrees/` (gitignored). This gives every parallel agent an isolated source
tree, so they can edit, build, and test without stomping on each other or on
the orchestrator's main checkout.

Helper scripts (run with `bash`, not `node`):

- `bash scripts/worktree-create.sh <branch> [--full]` — creates
  `.worktrees/<branch>` on a new branch from current HEAD. **Symlinks** the
  heavy gitignored dirs from the main checkout so the worktree can build/test
  without a multi-GB reinstall (this is the mechanism that makes worktrees
  viable here — `vendor/vscode/` is ~5G and `node_modules/` is gitignored, so a
  plain `git worktree add` has no deps).
  - default: links **`node_modules`** only — enough for source edits + Vitest
    unit tests.
  - `--full`: also links **`vendor/vscode`, `out`, `.build`, `.dev-data`** —
    needed for `gulp` builds, in-host E2E, or launching the app.
- `bash scripts/worktree-remove.sh <branch> [-f]` — removes the worktree and
  deletes the branch (`-f` discards uncommitted changes).

Workflow for an issue:

1. Orchestrator: `bash scripts/worktree-create.sh <issue-slug>` (default unless
   the task builds/runs the app).
2. Implementer: `cd .worktrees/<issue-slug>`, edits + runs tests, commits to the
   branch. Does NOT push.
3. Reviewer: reviews the branch (`git diff main...<branch>`) and runs tests in
   the worktree. Posts APPROVED / CHANGES REQUESTED.
4. Orchestrator: verifies, fast-forwards the branch into `main`, pushes, closes
   the issue, then `bash scripts/worktree-remove.sh <issue-slug>`.

**Concurrency rule:** multiple *default* (unit-test-only) worktrees are safe to
run in parallel — Vitest only reads `node_modules`. Multiple `--full` worktrees
must NOT run `gulp` / in-host E2E / app launches concurrently — they write into
the shared (symlinked) `vendor/vscode/out` and would corrupt each other. Run
build-heavy tasks one at a time.

Caveat (Windows): the symlinks are created on the dev/CI Linux host where agents
run. If a worktree is ever used on a Windows checkout, enable Developer Mode
(`core.symlinks true`) or copy `node_modules` instead.

## Delegation: testing and on-call monitoring

The orchestrator never blocks its own thread on testing or long waits — it
delegates both to subagents and keeps dispatching backlog work.

- **Testing**: the reviewer subagent runs the build and tests for the change
  under review. For broader validation (full unit/e2e suite, reproducing a
  failure, checking a regression) dispatch a dedicated tester subagent
  rather than running it inline on the orchestrator thread.
- **On-call monitoring**: long-running waits (CI runs, builds, deploys,
  remote operations) go to a background subagent or background shell that
  watches and reports back. Do NOT run `gh run watch` (or similar) on the
  orchestrator thread. Green → proceed; red → dispatch a diagnostic/fix
  subagent with the failing job's error.

## Non-Negotiable Loop

Every issue moves through this state machine:

```text
IMPLEMENTER -> REVIEWER -> IMPLEMENTER -> REVIEWER -> ... -> APPROVED -> ORCHESTRATOR VERIFY/MERGE
```

## Roles

### Orchestrator

Owns:
- Planning issues and refining requirements
- Launching implementer agents with self-contained briefs
- Launching reviewer agents
- Relaying review feedback
- Running pre-merge verification
- Committing, pushing, closing issues
- Keeping this process document current

Never:
- Fixes reviewer findings directly
- Writes implementation code for an issue in the loop
- Commits without reviewer APPROVED

### Implementer

Does:
- Reads the issue, linked docs, and relevant existing code
- Writes code and tests in an isolated worktree
- Runs build and tests before reporting done
- Posts a status comment on the issue

Does not:
- Commit, push, or close the issue
- Modify files outside the issue scope

### Reviewer

Does:
- Reads the implementer's latest status comment and the working-tree diff
- Runs build and tests
- For UI flows, runs the app and verifies visually
- Posts APPROVED or CHANGES REQUESTED

Does not:
- Edit code, commit, push, or close

## Verification Checklist

After reviewer approval:

- [ ] `git status` shows only expected files
- [ ] `git diff` reads sensibly
- [ ] Build succeeds
- [ ] Tests pass for touched code
- [ ] No secrets or generated outputs staged
- [ ] Acceptance criteria met
- [ ] UI changes verified in running app
- [ ] E2E tests pass for touched scenarios

## Testing

### Unit tests (Vitest)

Pure logic: SSH connection management, tmux protocol parser, agent parsers,
settings.

### Integration tests

SSH/SFTP against Docker fixture, tmux -CC against Docker tmux, pocketshell
commands against Docker.

### E2E tests (Playwright)

Full user flows driving the Electron app against the Docker SSH fixture.

### Docker fixture

Reuse the deterministic SSH server from PocketShell Android:
`alexeygrigorev/pocketshell/tests/docker/`. Runs on `localhost:2222` with
`pocketshell` helper, agent stubs, `tmux`, `gh` shim.

## Commit Conventions

- Imperative mood, scoped prefix when useful
- First line under 70 characters
- Link the issue with `Closes #N`
- One issue per commit
- Commit only after reviewer APPROVED and orchestrator verification
