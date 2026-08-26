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

WORK-001 shipped:

- Persistent, provenance-checked isolated Git worktrees
- Deterministic workspace lifecycle and fail-closed cleanup

AGENT-001 shipped one bounded provider execution in an already verified
workspace. MODEL-001 (this PR) adds deterministic provider discovery, health,
usage telemetry and model routing. Neither ticket chooses work, creates pull
requests, reviews changes, or merges code.

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

# Execute one explicitly supplied task with the OpenCode adapter
shipgraph agent run AG-001 --model <discovered-provider/model> --instructions "Implement the approved task"

# Refresh capability-probed provider and model metadata
shipgraph providers refresh --json

# Choose a provider/model for one explicitly supplied engineering step
shipgraph providers route implementation --risk medium --mode balanced --json

# Inspect persisted provider health and discovered models
shipgraph providers list --json

# Inspect durable execution state
shipgraph agent inspect <run-id> --json
shipgraph agent list --json
```

`init` never persists the template's empty identity. Once a valid configuration
has initialized the database, both `init` and `status` fail closed if the file's
identity or validated configuration drifts from the persisted project.

Provider settings identify executable and catalog surfaces, not model names.
OpenCode and Codex have conservative command defaults; configure a provider's
machine-readable `catalogArgs` when its surface is available, and leave a
provider disabled when it is not. Unsupported quota, token and cost values stay
`unknown`.

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
- **WORK-001 ✅** — Safe isolated git worktree lifecycle
- **AGENT-001 ✅** — Provider-neutral bounded agent execution and OpenCode adapter

Active in this PR:

- **MODEL-001** — Provider registry, dynamic model catalog, health, usage ledger
  and deterministic routing ([design](docs/architecture/ADAPTERS.md))

Next up:

- **KAR-7** — Execution budgets and human safety gates

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
