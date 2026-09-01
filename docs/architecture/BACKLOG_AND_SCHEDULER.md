# Backlog validation and admission diagnostics

CORE-002 provides persistent, deterministic backlog validation and eligibility
information without starting an agent or creating a worktree. It is not the
production outer Scheduler: ChatGPT Scheduler chooses one eligible Linear issue
and authorizes it for ShipGraph.

```text
shipgraph.backlog.yml
        |
        v
strict validation (including the complete DAG)
        |
        v
SQLite persisted tickets and dependencies
        |
        v
runtime ticket states and append-only events
        |
        v
dependency completion and eligibility
        |
        v
QUEUED -> ELIGIBLE reconciliation
        |
        v
capacity calculation
        |
        v
deterministic diagnostic/admission candidates
```

## Approved work is separate from runtime state

For local backlog use, `shipgraph.backlog.yml` is repository-owned and describes
the static contract for work that has been approved for execution. Its ticket
definitions contain
the title, scope, acceptance criteria, verification, risk, agent preference,
release policy, priority, and dependencies. It deliberately contains no
mutable lifecycle state.

SQLite is the runtime execution truth. A ticket imported for the first time is
persisted as `QUEUED`; subsequent syncs compare its static contract but never
reset or overwrite its runtime state. Removing a persisted ticket from YAML is
a fail-closed mismatch, not a deletion operation.

Approval is tracked per ticket in SQLite as part of the sync transaction. The
eligibility and ready paths read only tickets marked as belonging to the
approved backlog; direct persistence callers cannot skip the initial `QUEUED`
boundary or make unapproved work dispatchable. This local admission information
does not authorize ShipGraph to scan the backlog and launch work autonomously.

Agents may suggest work, but only approved backlog entries are executable.
Suggestions are not copied into `shipgraph.backlog.yml` automatically.

## Validation and synchronization

`shipgraph backlog validate` parses the default `shipgraph.backlog.yml` (or an
explicit `--file`/`--path`) and validates the complete graph before touching
SQLite. Unknown keys, unsupported major versions, duplicate IDs or
dependencies, missing dependencies, self-dependencies, and every directed
cycle fail closed. YAML ordering does not matter; forward references are valid.

`shipgraph backlog sync` validates first and then synchronizes one initialized
project inside one SQLite transaction. New ticket rows, dependency rows, and
`ticket.created` events commit together. A failure rolls all of them back.
Repeated syncs are idempotent. Static contract drift and removals are rejected.
After import, eligibility reconciliation promotes only `QUEUED` tickets whose
dependencies are all `COMPLETE`.

## Eligibility and ready selection

`MERGED` is not `COMPLETE`; it cannot unlock a dependent ticket. A `CANCELLED`
dependency produces a structured `dependency-cancelled` blocker. Reconciliation
is restart-safe because it reads the persisted graph and states on every run.

`shipgraph ready` is read-only. It reports approved `ELIGIBLE` tickets only
when their dependencies are still complete, and selects the deterministic
prefix that fits the configured `execution.maxConcurrentTickets` capacity.
Persisted eligibility is revalidated on every read, so stale legacy state fails
closed into the waiting report instead of becoming dispatchable. The v1
execution-active states `PLANNING`, `IMPLEMENTING`, `VERIFYING`, and
`REPAIRING` consume a slot; `QUEUED`, `ELIGIBLE`, post-PR states, exceptional
states, and terminal `COMPLETE`/`CANCELLED` do not. Selection is ordered by
`critical`, `high`, `medium`, `low`, then stable ticket ID. The command reports
what could be admitted next; it does not start it. Production work selection,
global concurrency, and later progression remain Scheduler-owned.
