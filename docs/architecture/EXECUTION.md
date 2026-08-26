# Agent Execution

AGENT-001 adds a deliberately small execution boundary:

```text
ShipGraph execution core
        ↓
provider-neutral AgentExecutionAdapter
        ↓
OpenCode adapter
        ↓
one verified WORK-001 worktree
```

ShipGraph is given one ticket, one existing READY workspace, one explicit model
and one bounded instruction string. It does not choose the next work item,
select a model, poll Linear, create a pull request, review changes, repair a
branch or merge code.

## Isolation

Before persisting a run or starting a provider, ShipGraph verifies the current
project repository binding and the complete WORK-001 workspace identity:

- the workspace is the recorded plain directory under the deterministic root;
- the Git worktree is registered with the bound source repository;
- its branch is the deterministic recorded branch;
- its HEAD is the recorded base SHA; and
- tracked, untracked and ignored content is clean.

If any proof fails, execution stops. ShipGraph never substitutes the normal
checkout, recreates a missing worktree, or adopts a caller-selected directory.

## Durable lifecycle

Run rows are written before a provider process is allowed to start:

```text
CREATED → STARTING → RUNNING →
  SUCCEEDED | FAILED | TIMED_OUT | CANCELLED | NEEDS_HUMAN
```

The row records project/ticket/workspace identity, exact path and base SHA,
provider/model, timestamps, process/session identifiers when available, exit
information, bounded redacted output, normalized evidence and a failure reason.
The original instructions are not stored; only a SHA-256 digest is retained.

SQLite owns the single-active-run invariant for a ticket. A concurrent or
repeated invocation cannot launch a second active run. An active run left by a
crash remains visible and blocks retry. The explicit `shipgraph agent recover`
command marks it `NEEDS_HUMAN` without killing a process whose ownership cannot
be proven. A terminal agent result means only that the execution contract
completed; later verification owns engineering success.

## Process boundary

The OpenCode adapter invokes the executable without a shell, sets both `cwd`
and OpenCode's directory argument to the verified worktree, passes an explicit
model, uses a small allow-listed environment, drains bounded stdout/stderr, and
terminates the owned POSIX process group on timeout or cancellation. OpenCode
JSONL events are reduced to session ID, event types/count and a bounded summary;
raw event objects are not persisted as structured fields; retained stdout is
bounded and redacted process text.

MODEL-001 now owns provider metadata discovery, health, quota/usage ledger
records and deterministic model routing in a separate control-plane subsystem.
A route with a durable execution run persists its decision with an atomic,
run-bound provider-capacity reservation; a route without a run ID is a preview.
Usage finalization releases that reservation only for the owning run. Unknown
quota and usage values remain unknown.
The AGENT-001 command remains explicit-provider execution; MODEL-001 does not
automatically dispatch a ticket, replace that execution contract, or add
post-execution PR/review/release automation.

## Known limitations

- ShipGraph does not reattach to a provider process after a restart. An active
  run remains durable and blocks duplicate execution until an operator invokes
  `shipgraph agent recover`, which records `NEEDS_HUMAN` without killing a
  process whose ownership cannot be proven.
- The explicit AGENT-001 execution command exposes only the OpenCode execution
  adapter. MODEL-001 exposes metadata probes and routing separately; it does not
  automatically dispatch those choices into this command.
- A terminal run describes the bounded provider execution only. The ticket
  remains in the existing implementation lifecycle for later verification,
  review, repair, release and merge tickets to advance.
