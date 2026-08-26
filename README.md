# ShipGraph

> Deterministic release control for autonomous coding agents.

## What ShipGraph is

ShipGraph is an orchestration kernel that runs a deterministic outer loop around
autonomous coding agents. It decides what work is approved, when it is eligible,
how it is isolated, how it is verified, and whether it may be released.

Agents reason freely inside a bounded task. ShipGraph ensures the task itself
follows a strict, auditable, repeatable lifecycle.

## What ShipGraph is NOT

ShipGraph is **not** a coding agent. It does not generate code, review code, or
merge code on its own. It coordinates agents and enforces release policy.

## Deterministic outer loop

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

## Why exact-SHA release provenance matters

A review or approval applies to exactly one commit SHA. If the PR head changes
after a review, that review is stale. This closes a common autonomy gap where an
agent might get approval on one revision and land another.

## Current status

CORE-001 ✅

CORE-001 establishes the foundation:

- CLI (`doctor`, `init`, `status`)
- Typed configuration (`shipgraph.yml`)
- Typed ticket contract
- Deterministic state machine
- SQLite persistence with explicit migrations
- Append-only audit-event log
- Agent and git-host adapter contracts
- Unit and integration tests
- GitHub Actions CI

CORE-002 shipped:

- Approved `shipgraph.backlog.yml` contract and whole-DAG validation
- Persistent, transactional backlog synchronization
- Deterministic `QUEUED` → `ELIGIBLE` reconciliation
- Read-only capacity-aware `shipgraph ready` selection

Agent execution, PR monitoring, autonomous review, repair loops, auto-merge, and
successor tickets are intentionally **not** implemented yet.

## CLI examples

```bash
# Check the environment
shipgraph doctor

# Structured diagnostics
shipgraph doctor --json

# First run writes shipgraph.yml and waits for a real project identity.
shipgraph init

# Edit project.name and project.repository, then initialize persistence.
shipgraph init

# Show project status
shipgraph status

# Structured status
shipgraph status --json

# Validate the approved backlog without changing SQLite
shipgraph backlog validate

# Import approved work and reconcile eligibility
shipgraph backlog sync

# Report eligible and dispatchable work without starting it
shipgraph ready

# Structured ready queue
shipgraph ready --json
```

`init` never persists the template's empty identity. Once a valid configuration
has initialized the database, both `init` and `status` fail closed if the file's
identity or validated configuration drifts from the persisted project.

## Installation

Requires Node.js 22+ and pnpm.

```bash
pnpm install
pnpm build
```

## Development

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Roadmap

Shipped:

- **CORE-001 ✅** — Project foundation and safe state boundary
- **CORE-002 ✅** — Persistent backlog DAG and eligibility scheduler

Active in this PR:

- **WORK-001** — Safe isolated git worktree lifecycle
  ([design](docs/architecture/WORKSPACES.md))

Next up:

- **AGENT-001** — OpenCode execution adapter
- **MODEL-001** — Dynamic model routing and compute-aware execution policy

Planned successor tickets (not yet implemented):

- **GH-001** — GitHub PR and CI integration
- **REV-001** — Independent correctness and adversarial review
- **REPAIR-001** — Automated review/CI repair loop
- **RELEASE-001** — Exact-SHA release gate and stale-review invalidation
- **TRAIN-001** — Merge → dependency unlock → automatic next-ticket execution
- **SAFETY-001** — Runtime safety and escalation policy
- **OBS-001** — Full audit/why/metrics observability
- **UI-001** — Local build-train dashboard
- **DOGFOOD-001** — Use ShipGraph on a real external repository

## Comparison philosophy

ShipGraph is inspired by autonomous coding-agent systems and orchestrators, but
it occupies a different layer: the deterministic release-control plane. It does
not claim to be a better code generator. It aims to make agent-generated changes
safe to land at scale by enforcing policy, provenance, and isolation.

## License

MIT
