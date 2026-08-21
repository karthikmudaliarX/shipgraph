# State Machine

Ticket state is the single source of truth for where work is in the release
pipeline. Every transition is validated; illegal transitions fail closed.

## States

### Normal progression

| State | Meaning |
|-------|---------|
| `QUEUED` | Ticket exists but is not yet eligible. |
| `ELIGIBLE` | Dependencies satisfied; ticket may be scheduled. |
| `PLANNING` | Agent is planning the implementation. |
| `IMPLEMENTING` | Agent is executing the implementation. |
| `VERIFYING` | Local verification commands are running. |
| `PR_OPEN` | A pull request has been opened. |
| `CI_WAIT` | Waiting for CI to report status. |
| `REVIEWING` | Independent review is in progress. |
| `CHANGES_REQUIRED` | Review requested changes. |
| `REPAIRING` | Agent is repairing the implementation. |
| `RELEASE_READY` | All quality gates satisfied; awaiting approval. |
| `AWAITING_APPROVAL` | Human or policy approval required. |
| `MERGING` | Merge is being performed. |
| `MERGED` | Code has landed. |
| `COMPLETE` | Ticket closed successfully. |

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

Some transitions depend on policy. For example, `RELEASE_READY → MERGING`
requires either human approval or an explicit policy override. The state
machine accepts a `TransitionContext` so callers can supply release policy
without hard-coding it inside the machine.

## Persistence

State updates are performed inside SQLite transactions. The corresponding
`ticket.state_changed` event is appended in the same transaction so that state
and audit log remain consistent.
