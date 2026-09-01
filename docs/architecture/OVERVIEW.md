# ShipGraph Architecture Overview

ShipGraph is the deterministic engineering execution layer for one explicitly
authorized work item. It claims the supplied Linear issue, runs the bounded
pre-PR path, creates the GitHub PR handoff, and stops. ChatGPT Scheduler owns
selection and progression across work items.

## Design goals

- **Deterministic inner loop, external outer loop**: agents may reason freely
  inside a bounded task, but ShipGraph controls its evidence and boundaries
  deterministically.
- **Exact-SHA provenance**: every review and approval applies to exactly one
  commit SHA. If the PR head moves, prior reviews become stale.
- **Explicit authorization**: Scheduler chooses one eligible Linear issue and
  authorizes it; ShipGraph does not select successor work or auto-advance the
  backlog.
- **Auditability**: every state change is recorded in an append-only event log
  that can answer `shipgraph why <ticket>`.

## High-level modules

```
src/
  cli/              Command-line interface
  core/
    state-machine/  Ticket lifecycle transitions
  scheduler/        Backlog eligibility and admission diagnostics
  domain/           Typed contracts (ticket, config)
  persistence/      SQLite repositories, transitions, and migrations
  adapters/
    agent/          Provider-neutral adapter contract and capability-probed execution
    model/          Capability-probed provider/model metadata adapters
    git-host/       Git-host adapter interface (GitHub)
  events/           Append-only audit-event contract
  config/           Configuration schema and loader
  execution/        Durable agent-run lifecycle and recovery
  review/           Independent pre-PR review axes
  repair/           Bounded pre-PR repair
  readiness/        Exact-SHA Pre-PR Readiness evidence
  github/            GitHub PR and usage receipt handoff
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

## Scheduler boundary and ShipGraph flow

```
ChatGPT Scheduler
       │ chooses one eligible Linear issue and authorizes `shipgraph:queued`
       ▼
ShipGraph: ticket → workspace → implementation → verification
       │
       ▼
Contract Review + Engineering Review → bounded repair
       │
       ▼
exact-SHA Pre-PR Readiness
       │
       ▼
GitHub PR + usage receipt → PR_RAISED / PR_OPEN
       │
       ▼
STOP
```

Linear webhook wake-up and dispatch are the upcoming KAR-13 boundary. After
`PR_OPEN`, Scheduler and the release manager decide whether to wait, merge,
escalate, or select later work; ShipGraph does not supervise that outer loop.

## Influences

The architecture is informed by, but does not clone:

- OpenAI Symphony
- Autonomous issue→PR orchestrators
- Independent multi-agent PR review systems
- Git-worktree agent isolation
- Append-only orchestration event logs
- Dependency-aware ticket schedulers

ShipGraph's differentiator is deterministic single-ticket execution, exact-SHA
evidence, isolated workspaces, and a bounded pre-PR handoff.

## Architectural boundaries

Linear is the system of record for product intent and authorization/dispatch
state. GitHub is the system of record for code, commits, pull requests, and CI
evidence. GitHub Projects is optional derived visibility/dashboard only. ShipGraph SQLite is
the local durable record of execution and evidence; no additional source of
truth is introduced.

The trusted-root invariant is simple: ordinary agents may operate within
ShipGraph's authorization, safety, contract-provenance, verification,
review-provenance, and readiness boundaries, but must not silently rewrite,
bypass, or weaken the mechanisms that authorize work or decide whether it is
acceptable.

Prompts carry intent, the behavioral Ticket Contract, invariants, unusual
constraints, domain terms, relevant prior evidence, and scope boundaries.
Agents discover ordinary repository facts from the repository instead of
receiving repeated directory trees, long architecture explanations, or
implementation recipes.

## Current status (KAR-12)

CORE-001, CORE-002, WORK-001 and AGENT-001 establish the foundation and local
backlog eligibility/admission diagnostics. MODEL-001 through KAR-11 add safe
workspaces, provider routing, execution safety, independent pre-PR reviews,
bounded repair, Pre-PR Readiness, and the GitHub PR/receipt handoff. KAR-12
composes those
pieces for one explicitly supplied and authorized ticket. It does not select
product work, own the global Scheduler, supervise post-PR CI, merge code, or
select successor work.
