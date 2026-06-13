# PocketShell Desktop

> **Read the docs in this order: [CLAUDE.md](CLAUDE.md) → [agents.md](agents.md) → [process.md](process.md).**
> agents.md is the source of truth for project state; **process.md defines the mandatory
> three-actor process** (orchestrator plans → implementer writes code/tests → reviewer
> approves → orchestrator verifies & merges) that governs every change. Do not skip it.

**Read [agents.md](agents.md) first** — it contains the critical project state
that survives context compaction: architecture decisions, what exists, open issues,
hard-won lessons, and user preferences. **Then read [process.md](process.md).**

## Key docs

- [agents.md](agents.md) — **Source of truth** for project state and context
- [process.md](process.md) — orchestrator/implementer/reviewer process
- [docs/plan.md](docs/plan.md) — v0.1.0 plan, architecture

## Quick rules

- All output in English
- Config directory: `~/.zlaude/` (NOT `~/.claude/`)
- No "Co-Authored-By: Claude" in commits
- Follow the three-actor process from process.md
- Don't claim done until it actually works (launches, connects, shows terminal)
