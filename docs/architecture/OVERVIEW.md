# ShipGraph Architecture Overview

ShipGraph is a deterministic release-control plane for autonomous coding agents.
It is **not** a coding agent itself. It orchestrates the outer loop that takes
approved work through isolation, execution, verification, review, and release.

## Design goals

- **Deterministic outer loop, agentic inner loop**: agents may reason freely
  inside a bounded task, but ShipGraph controls state transitions deterministically.
- **Exact-SHA provenance**: every review and approval applies to exactly one
  commit SHA. If the PR head moves, prior reviews become stale.
- **Approved-backlog auto-advancement**: only approved work is eligible for
  execution. Completed work unlocks dependent tickets automatically.
- **Auditability**: every state change is recorded in an append-only event log
  that can answer `shipgraph why <ticket>`.

## High-level modules

```
src/
  cli/              Command-line interface
  core/
    state-machine/  Ticket lifecycle transitions
    scheduler/      Eligibility and dependency ordering (future)
    policy/         Release and safety policy (future)
  domain/           Typed contracts (ticket, config)
  persistence/      SQLite repositories and migrations
  adapters/
    agent/          Agent-adapter interface (OpenCode, Codex, ACP)
    git-host/       Git-host adapter interface (GitHub)
  events/           Append-only audit-event contract
  config/           Configuration schema and loader
  utils/            Shared helpers and error types
```

This is an intentional modular monolith. Boundaries are explicit but the project
remains a single deployable unit.

## Outer-loop workflow

```
approved backlog
       │
       ▼
dependency resolution
       │
       ▼
ticket contract
       │
       ▼
isolated workspace
       │
       ▼
agent execution
       │
       ▼
verification
       │
       ▼
pull request
       │
       ▼
independent review
       │
       ▼
repair (if needed)
       │
       ▼
exact-SHA release gate
       │
       ▼
merge
       │
       ▼
unlock next approved ticket
```

## Influences

The architecture is informed by, but does not clone:

- OpenAI Symphony
- Autonomous issue→PR orchestrators
- Independent multi-agent PR review systems
- Git-worktree agent isolation
- Append-only orchestration event logs
- Dependency-aware ticket schedulers

ShipGraph's differentiator is the combination of a deterministic outer loop,
agentic inner loop, exact-SHA release provenance, and approved-backlog
auto-advancement.

## Current status (CORE-001)

CORE-001 establishes the foundation: CLI, typed contracts, state machine,
SQLite persistence, event log, adapter interfaces, tests, and CI. It does **not**
run agents, open PRs, perform reviews, or merge code. Those capabilities are
planned in successor tickets.
