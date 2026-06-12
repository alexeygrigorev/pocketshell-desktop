# Agent Roles

PocketShell Desktop uses the agent workflow defined in [process.md](process.md).

## Roles

- **Orchestrator** — plans, dispatches, verifies, merges. This main thread.
- **Implementer** — writes code + tests for a single issue. Reports through
  issue comments. Never commits, pushes, or closes.
- **Reviewer** — inspects diffs, runs build/tests, posts APPROVED or CHANGES
  REQUESTED. Never edits code.
- **Researcher** — read-only spikes: design audits, library feasibility,
  JTBD inventories. Returns structured output.

## Quick Rules

- Work from GitHub issues. All communication through issue comments.
- Implementers and reviewers run in isolated worktrees.
- One merge to `main` at a time.
- Commit only after reviewer APPROVED.
- Run local verification before pushing to `main`.
