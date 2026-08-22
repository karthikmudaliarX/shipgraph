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

Some transitions depend on policy. Any transition into `MERGING`, including
`AWAITING_APPROVAL → MERGING`, requires either granted human-approval evidence
or an explicit policy override (`requireHumanApproval: false`). Policy states
whether approval is required; `releaseEvidence.humanApprovalGranted` records
whether it was granted for the attempted transition. `RELEASE_READY →
AWAITING_APPROVAL` does not require evidence. Exact-SHA review evidence remains
outside CORE-001.

## Persistence

`persistTicketTransition` is the only normal application entry point that
mutates ticket state. It performs a compare-and-set update and appends the
corresponding `ticket.state_changed` event in one immediate SQLite transaction.
The general ticket repository intentionally exposes no raw state-update method.
