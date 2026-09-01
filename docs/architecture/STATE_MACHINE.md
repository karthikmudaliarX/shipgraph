# Ticket State Machine

Ticket state is the single source of truth for the persisted ticket lifecycle.
Every transition is validated; illegal transitions fail closed. The enum retains
historical post-PR states for compatibility, but the current v1 ShipGraph path
stops after `PR_OPEN`.

## States

### Normal progression

| State | Meaning |
|-------|---------|
| `QUEUED` | Ticket exists but is not yet eligible. |
| `ELIGIBLE` | Dependencies satisfied; ticket may be scheduled. |
| `PLANNING` | An explicitly authorized ticket is entering execution. |
| `IMPLEMENTING` | Agent is executing the implementation. |
| `VERIFYING` | Local verification commands are running. |
| `PR_OPEN` | KAR-8 raised a pull request; ShipGraph stops here in v1. |
| `CI_WAIT` | Historical/outer-loop state for waiting on post-PR CI. |
| `REVIEWING` | Historical/outer-loop review state; KAR-9's reviews are pre-PR evidence. |
| `CHANGES_REQUIRED` | Historical state for a post-PR review request. |
| `REPAIRING` | Bounded KAR-10 pre-PR repair is in progress. |
| `RELEASE_READY` | Historical release state; KAR-11 is named Pre-PR Readiness. |
| `AWAITING_APPROVAL` | Historical outer-loop approval state. |
| `MERGING` | Historical outer-loop merge state owned outside ShipGraph v1. |
| `MERGED` | Historical outer-loop state after code has landed. |
| `COMPLETE` | Historical terminal state after outer-loop completion. |

### Exceptional states

| State | Meaning |
|-------|---------|
| `BLOCKED` | External dependency or unsatisfied precondition. |
| `PAUSED` | Intentionally paused. |
| `FAILED` | Terminal failure unless repaired. |
| `NEEDS_HUMAN` | Requires human intervention. |
| `CANCELLED` | Work cancelled. |

## Transition rules

Transitions are explicit and directional. The state machine exposes:

- `canTransition(from, to)` — predicate.
- `transition(from, to, context?)` — returns `ok` or `reason`.
- `legalNextStates(from)` — list allowed next states.

Illegal transitions, such as `QUEUED → MERGED` or `IMPLEMENTING → COMPLETE`,
are rejected. Self-transitions are also rejected.

## Policy-aware transitions

Some legacy transitions depend on policy. Any transition into `MERGING`, including
`AWAITING_APPROVAL → MERGING`, requires either granted human-approval evidence
or an explicit policy override (`requireHumanApproval: false`). The current v1
ShipGraph execution path does not enter those post-PR states; Scheduler and the
release manager own later progression. Exact-SHA Contract Review, Engineering
Review, and Pre-PR Readiness evidence are enforced by their respective stages,
not by the legacy enum alone.

## Persistence

`persistTicketTransition` is the only normal application entry point that
mutates ticket state. It performs a compare-and-set update and appends the
corresponding `ticket.state_changed` event in one immediate SQLite transaction.
The general ticket repository intentionally exposes no raw state-update method.
