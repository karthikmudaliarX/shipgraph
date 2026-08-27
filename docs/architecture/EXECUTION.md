# Agent Execution

AGENT-001 adds a deliberately small execution boundary:

```text
ShipGraph execution core
        ↓
provider-neutral AgentExecutionAdapter
        ↓
capability-probed provider adapter
        ↓
one verified WORK-001 worktree
```

ShipGraph is given one ticket, one existing READY workspace, one explicit model
and one bounded instruction string. It does not choose the next work item,
select a model, poll Linear, create a pull request, review changes, repair a
branch or merge code.

## Isolation

Before persisting a run or starting a provider, ShipGraph verifies the current
project repository binding and the complete WORK-001 workspace identity. For an
implementation run this includes the original exact base SHA and a strictly
clean worktree. Review and repair runs use the same immutable repository,
deterministic path, dedicated branch and creation-audit proof, while allowing
the implementation's changed HEAD and contents so those agents can inspect and
repair the actual change:

- the workspace is the recorded plain directory under the deterministic root;
- the Git worktree is registered with the bound source repository;
- its branch is the deterministic recorded branch;
- its HEAD is the recorded base SHA for a new implementation hand-off; and
- tracked, untracked and ignored content is clean for that new hand-off.

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

Command adapters invoke their executable without a shell, pin the process cwd
to the verified worktree, pass the selected model explicitly, use a small
allow-listed environment, drain bounded stdout/stderr, and terminate the owned
POSIX process group on timeout or cancellation. OpenCode and Codex JSONL, plus
Grok and Antigravity (`agy`) JSON, are reduced to session ID, event types/count
and a bounded summary; raw event objects are not persisted as structured
fields; retained stdout is bounded and redacted process text. Each adapter
probes the exact version/help surface it will use before the provider becomes
execution-available. Gemini's MODEL-001 identity is implemented through
Antigravity (`agy`), not Gemini CLI. Grok uses its `workspace` sandbox profile
and Antigravity uses its supported `--sandbox` mode; cwd alone is not treated
as filesystem isolation.

MODEL-001 now owns provider metadata discovery, health, quota/usage ledger
records and deterministic model routing in a separate control-plane subsystem.
A route with a pre-persisted CREATED execution run persists its decision with an
atomic, provider/model- and run-bound provider-capacity reservation; a route
without a run ID is a non-persistent preview. MODEL-001 resolves only an
active reservation to an execution-bound AGENT target, and AGENT-001 consumes
that existing CREATED run rather than creating a second unreserved run.
Terminalizing the owning run releases that reservation in the same SQLite
transaction. Explicit recovery marks the run `NEEDS_HUMAN` but retains the
reservation when provider-process ownership cannot be proven; usage
finalization cannot release an active run's slot. Usage finalization remains
append-only and idempotent for capacity release. Unknown quota and usage values
remain unknown.
The AGENT-001 command remains explicit-provider execution; MODEL-001 resolves a
routed selection to the exact adapter but does not automatically dispatch a
ticket, replace that execution contract, or add post-execution PR/review/release
automation.

## Known limitations

- ShipGraph does not reattach to a provider process after a restart. An active
  run remains durable and blocks duplicate execution until an operator invokes
  `shipgraph agent recover`, which records `NEEDS_HUMAN` without killing a
  process whose ownership cannot be proven.
- The explicit AGENT-001 execution command still requires a caller to supply a
  ticket, workspace, instructions and model. A routed hand-off additionally
  prepares a CREATED AGENT run before binding the MODEL-001 route; MODEL-001
  does not automatically dispatch routed choices or add scheduler/Linear
  orchestration.
- A terminal run describes the bounded provider execution only. The ticket
  remains in the existing implementation lifecycle for later verification,
  review, repair, release and merge tickets to advance.
