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

Rule: agents must not touch the same files. If overlap is unavoidable, run
them sequentially instead.

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
