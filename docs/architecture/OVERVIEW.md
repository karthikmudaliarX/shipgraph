# ShipGraph Architecture Overview

ShipGraph is the deterministic engineering execution layer for one explicitly
authorized work item. An outer Scheduler or human selects one eligible Linear
issue and authorizes it. ShipGraph verifies and durably claims that dispatch,
runs the bounded pre-PR path, creates the GitHub PR handoff, and stops. Scheduler
and the release manager own the outer progression after the PR boundary.

## Design goals

- **Deterministic inner loop, external outer loop**: agents may reason freely
  inside a bounded task, but ShipGraph controls authorization, evidence, and
  boundaries deterministically.
- **Exact-SHA provenance**: every review and readiness decision applies to
  exactly one commit SHA. If the candidate head moves, prior evidence becomes
  stale.
- **Explicit authorization**: Scheduler chooses one eligible Linear issue and
  authorizes it; ShipGraph does not scan the backlog, select successor work, or
  auto-advance product priority.
- **Auditability**: claims, execution identity, workspace provenance, provider
  runs, reviews, readiness, and PR handoff evidence are persisted durably and
  can be inspected through the existing read-only CLI surfaces and SQLite audit
  history.
- **Fail-closed provider execution**: unknown provider capability or ownership is
  never upgraded into permission to execute or retry.

## High-level modules

```
src/
  cli/              Command-line interface
  core/
    state-machine/  Ticket lifecycle transitions
  scheduler/        Backlog eligibility and admission diagnostics
  dispatch/         Verified Linear webhook wake-up and durable claim bridge
  domain/           Typed contracts (ticket, config)
  persistence/      SQLite repositories, transitions, and migrations
  adapters/
    agent/          Provider-neutral adapter contract and capability-probed execution
    model/          Capability-probed provider/model metadata adapters
    git-host/       Git-host adapter interface (GitHub)
  events/           Append-only audit-event contract
  config/           Configuration schema and loader
  execution/        Durable ticket/provider execution and recovery
  review/           Independent pre-PR review axes
  repair/           Bounded pre-PR repair
  readiness/        Exact-SHA Pre-PR Readiness evidence
  github/           GitHub PR and usage receipt handoff
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
references to another project. The standalone dependency mutation boundary also
rejects self-edges and cycles against the existing graph plus the full proposed
batch.

On a fresh directory, `shipgraph init` writes a configuration template and
stops. Persistence is created only after the user supplies a valid project name
and `owner/repository` identity. That identity and the validated configuration
are immutable for CORE-001; both `init` and `status` fail closed on drift. Each
project-local database must contain exactly one project row; CLI commands reject
ambiguous multi-project state even though repository isolation is tested with
multi-project databases.

Migrations are forward-only and fail closed if the database records a version
or migration name unknown to the running binary. Before upgrading, operators
should copy `.shipgraph/shipgraph.db` while ShipGraph is stopped. Recovery is
restoring that backup or re-running `shipgraph init` for disposable empty state;
lossless down migrations are intentionally not claimed in CORE-001.

## Scheduler boundary and ShipGraph flow

```text
ChatGPT Scheduler / human
        │ chooses one eligible Linear issue
        │ applies shipgraph:queued
        ▼
Linear webhook
        │ verified signature + live issue re-check
        ▼
Durable ShipGraph claim
        │
        ▼
isolated workspace
        │
        ▼
provider routing → implementation → verification
        │
        ▼
Contract Review + Engineering Review
        │
        ▼
bounded repair when required
        │
        ▼
exact-SHA Pre-PR Readiness
        │
        ▼
GitHub PR + usage receipt → PR_RAISED / PR_OPEN
        │
        ▼
STOP

Later Scheduler / release-manager wake:
CI / reviews / merge / next work
```

KAR-13 implements the bounded Linear webhook wake-up and durable claim bridge.
The webhook does not synthesize a Ticket Contract or execution policy: a trusted
caller supplies the authorized EXEC-001 input after the live Linear issue is
re-checked. Duplicate deliveries and incomplete claims reuse durable claim and
execution identity rather than creating another backlog queue.

After `PR_OPEN`, Scheduler and the release manager decide whether to wait,
escalate, merge, or select later work. ShipGraph does not supervise that outer
loop in v1.

## Provider launch boundary

Provider metadata, authentication, catalog state, execution capability, health,
quota, and local capacity are discovered conservatively. Unknown authentication,
catalog, execution-capability, or health evidence remains non-routable. Unknown
quota, provider concurrency, or execution-envelope limits stay explicitly
unknown; routing may still proceed under conservative bounded defaults unless a
known limit is exhausted.

Safety and approval gates run before provider launch. The final capability probe
also occurs before the durable `RUNNING` transition. KAR-17 permits a provider
fallback only when durable evidence proves that the selected provider became
locally unlaunchable before `RUNNING`, before any provider process or session
could have acted on the workspace, and after the failed reservation has been
safely released. Launched or ambiguous attempts remain fail-closed rather than
starting another provider on the same workspace.

Provider executable paths and provider command/probe arguments are a trusted
local configuration seam. Some adapters may read the user's HOME/XDG credential
stores for an existing CLI login, so repository-supplied or otherwise untrusted
provider configuration must not be executed.

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
evidence. GitHub Projects is optional derived visibility/dashboard only.
ShipGraph SQLite is the local durable record of execution and evidence; no
additional system of record is introduced.

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

## Current status

Delivered through the current v1 boundary:

- CORE-001 / CORE-002 — CLI/config foundation and approved local backlog DAG
- WORK-001 — provenance-checked isolated worktrees
- AGENT-001 / KAR-5 — provider-neutral bounded execution
- MODEL-001 / KAR-6 — provider discovery, routing, health and usage
- KAR-7 — execution limits, approval and human safety gates
- KAR-9 / KAR-10 / KAR-11 — exact-SHA reviews, bounded repair, and Pre-PR Readiness
- KAR-8 — GitHub PR and compact usage/evidence receipt handoff
- KAR-12 — one authorized ticket composed through the full pre-PR path
- KAR-13 — verified Linear webhook dispatch and idempotent durable claim bridge
- KAR-14 — frozen Scheduler/ShipGraph documentation boundary
- KAR-17 — safe provider fallback for proven pre-launch unavailability

KAR-15 external dogfood is still in progress. The implementation should not be
treated as generally proven until the real external execution reaches a PR and
the planned recovery/failure cases are exercised.
