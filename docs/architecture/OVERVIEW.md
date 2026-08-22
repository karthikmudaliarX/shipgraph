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
  persistence/      SQLite repositories, transitions, and migrations
  adapters/
    agent/          Agent-adapter interface (OpenCode, Codex, ACP)
    git-host/       Git-host adapter interface (GitHub)
  events/           Append-only audit-event contract
  config/           Configuration schema and loader
  utils/            Shared helpers and error types
```

This is an intentional modular monolith. Boundaries are explicit but the project
remains a single deployable unit.

SQLite assigns each event's project-local sequence inside the append
transaction. Ticket state mutation and its audit event share a compare-and-set
transaction, so concurrent or partial transitions fail closed.

Known event types have strict runtime payload schemas. Before an immutable event
is inserted, ticket and run references are resolved through their owning ticket
and must belong to the event's project. Dependency mutation enforces the same
single-project boundary, so one project's DAG and audit history cannot acquire
references to another project.
The standalone dependency mutation boundary also rejects self-edges and cycles
against the existing graph plus the full proposed batch.

On a fresh directory, `shipgraph init` writes a configuration template and
stops. Persistence is created only after the user supplies a valid project name
and `owner/repository` identity. That identity and the validated configuration
are immutable for CORE-001; both `init` and `status` fail closed on drift.
Each project-local database must contain exactly one project row; CLI commands
reject ambiguous multi-project state even though repository isolation is tested
with multi-project databases.

Migrations are forward-only and fail closed if the database records a version
or migration name unknown to the running binary. Before upgrading, operators
should copy `.shipgraph/shipgraph.db` while ShipGraph is stopped. Recovery is
restoring that backup or re-running `shipgraph init` for disposable empty state;
lossless down migrations are intentionally not claimed in CORE-001.

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
