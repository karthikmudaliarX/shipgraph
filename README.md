# ShipGraph

> Deterministic engineering execution for one explicitly authorized work item.

## What ShipGraph is

ShipGraph is the deterministic engineering execution layer for one explicitly
authorized work item. It claims the supplied ticket, prepares an isolated
workspace, runs implementation, verification, independent pre-PR reviews,
bounded repair, Pre-PR Readiness, and the GitHub PR handoff with its usage
receipt. It stops after `PR_RAISED` / `PR_OPEN`.

ChatGPT Scheduler decides which eligible Linear issue runs next and owns the
outer progression across work items. ShipGraph decides how that one authorized
issue reaches a safe PR.

## What ShipGraph is NOT

ShipGraph is **not**:

- the product backlog owner or global Scheduler
- the merge authority or successor-ticket selector
- the post-PR CI supervisor

It provides bounded execution and evidence; provider agents generate and review
changes inside those boundaries.

## Current v1 boundary

```
ChatGPT Scheduler
       │ chooses one eligible Linear issue and authorizes `shipgraph:queued`
       ▼
ShipGraph: authorized ticket
       │
       ▼
workspace → implementation → verification
       │
       ▼
Contract Review + Engineering Review
       │
       ▼
bounded repair → Pre-PR Readiness
       │
       ▼
GitHub PR + usage receipt → PR_RAISED / PR_OPEN
       │
       ▼
STOP
```

Linear webhook wake-up and dispatch are the upcoming KAR-13 boundary; they are
not implemented here. After a PR, Scheduler and the release manager own later
wait, merge, escalation, and next-work decisions.

## Why exact-SHA provenance matters

A review or approval applies to exactly one commit SHA. If the candidate head
changes after a review or Pre-PR Readiness decision, that evidence is stale and
must be renewed before the PR handoff.

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
workspace. MODEL-001 adds provider discovery, health, usage telemetry, model
routing, and capability-probed execution adapters. KAR-7 adds execution safety
limits; KAR-9 and KAR-10 add independent pre-PR reviews and bounded repair;
KAR-11 adds exact-SHA Pre-PR Readiness; KAR-8 adds the GitHub PR and usage
receipt handoff; and KAR-12 composes these stages for one authorized ticket.

The execution envelope is supplied by Scheduler and applies to one ticket;
MODEL-001 does not claim global ticket capacity or choose subsequent work. A
durable route reserves a provider run slot, and known provider limits are
enforced directly. Usage finalization remains append-only and idempotent for
capacity release; ambiguous provider-process ownership remains reserved until
explicit reconciliation.

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

# Read-only eligibility/admission diagnostics; this does not start work
shipgraph ready

# Structured ready queue
shipgraph ready --json

# Execute one explicitly supplied task with the OpenCode adapter
shipgraph agent run AG-001 --model <discovered-provider/model> --instructions "Implement the approved task"

# Explicitly select the shared ACP boundary's Antigravity adapter
shipgraph agent run AG-001 --provider acp --model-provider gemini --model <discovered-provider/model> --instructions "Implement the approved task"

# Let MODEL-001 select, reserve, and execute the provider in one operation
shipgraph agent run-routed AG-001 --task implementation --risk medium --mode balanced --max-concurrent-tickets 2 --active-concurrent-tickets 0 --instructions "Implement the approved task"

# Refresh capability-probed provider and model metadata
shipgraph providers refresh --json

# Preview a route; --run-id <run-id> binds it to a durable execution reservation
# Retries without --request-id use the durable run ID as their stable key
shipgraph providers route implementation --risk medium --mode balanced --run-id <run-id> --json
# After a terminal run releases that reservation, use a new request ID for a new attempt. Explicit recovery retains it for human reconciliation.
# After independently proving the provider process stopped, release retained capacity explicitly:
shipgraph agent reconcile <run-id> --execution-stopped
# Usage records telemetry only; it never releases provider capacity.

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
They are trusted local configuration: do not point them at repository-supplied
or otherwise untrusted executables. OpenCode, Codex and Antigravity may use the
current user's HOME/XDG stores for existing CLI authentication; ShipGraph's
environment filtering is not host-filesystem or credential-store isolation.
OpenCode, Codex, Grok and Antigravity (`agy`) have conservative execution
defaults; Grok uses its `workspace` sandbox profile and Antigravity uses its
supported `--sandbox` mode. Configure a provider's machine-readable
`catalogArgs` when its model catalog surface is available. A documented login
status surface can be configured with `authArgs` and positive output markers;
without positive authentication evidence a provider remains non-routable.
Providers without a supported catalog or capability-probed execution surface
remain unknown/disabled rather than being guessed into service.
Unsupported quota, token and cost values stay `unknown`.

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

## Delivered through KAR-12

- **CORE-001 ✅** — Project foundation and safe state boundary
- **CORE-002 ✅** — Persistent backlog DAG and eligibility/admission diagnostics
- **WORK-001 ✅** — Safe isolated git worktree lifecycle
- **AGENT-001 ✅** — Provider-neutral bounded agent execution and OpenCode adapter

Delivered:

- **MODEL-001 ✅** — Provider metadata, routing, health, and usage telemetry
- **KAR-7 ✅** — Execution limits and human safety gates
- **KAR-9 ✅** — Independent Contract and Engineering Reviews
- **KAR-10 ✅** — Bounded pre-PR repair
- **KAR-11 ✅** — Exact-SHA Pre-PR Readiness
- **KAR-8 ✅** — GitHub PR and usage receipt handoff
- **KAR-12 ✅** — Single-ticket EXEC-001 composition

The production outer Scheduler, Linear webhook wake-up, post-PR supervision,
merge authority, and successor-ticket selection remain outside ShipGraph's v1
inner-loop boundary.

## Comparison philosophy

ShipGraph is inspired by autonomous coding-agent systems and orchestrators, but
it occupies a different layer: the deterministic engineering execution plane. It does
not claim to be a better code generator. It aims to make agent-generated changes
safe to land at scale by enforcing policy, provenance, and isolation.

## License

MIT
