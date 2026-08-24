# WORK-001: Isolated Git Worktree Lifecycle

## The core safety principle

ShipGraph never performs ticket implementation inside the user's normal
working checkout. Every ticket receives its own isolated Git worktree under a
ShipGraph-owned root outside the repository:

```
~/.shipgraph/worktrees/<project-id>/<ticket-id>/
```

The source checkout may contain unrelated uncommitted work. ShipGraph never
modifies, stages, resets, cleans, checks out, or stashes those files. Allowed
operations against the source repository are limited to what is required to
manage the dedicated branch and worktree (`git worktree add/remove`,
`git branch -d`, read-only inspection). `git reset --hard`, `git clean -fd`,
`git stash`, and force-deletion of user changes are never executed.

## Pipeline

```
eligible ticket
      ↓
persistent reservation (CREATING)
      ↓
exact base SHA (resolved from the local default branch)
      ↓
dedicated branch   shipgraph/<ticket-id>
      ↓
isolated worktree  ~/.shipgraph/worktrees/<project-id>/<ticket-id>
      ↓
validation         HEAD == baseSha, branch matches, clean, registered
      ↓
READY              (+ ELIGIBLE → PLANNING in the same DB commit)
```

## Base SHA invariant

Branches move; commits do not. WORK-001 resolves the configured local default
branch to an exact commit SHA at creation time and persists that SHA. Before a
workspace may be marked READY, the live worktree HEAD must equal the recorded
base SHA. No remote synchronization happens in WORK-001 — no fetch, no pull.
GH-001 will later own remote policy.

## Branch ownership

One dedicated branch per ticket, derived deterministically from the ticket id
(`TA-1` → `shipgraph/ta-1`) and validated with
`git check-ref-format --branch`. A pre-existing branch is never reused, reset,
or deleted. Only an active persisted reservation can claim a branch; anything
else fails closed.

## Persistence model

Workspaces live in the `workspaces` table (migration v4) with statuses
`CREATING`, `READY`, `REMOVED`, `FAILED`, `NEEDS_HUMAN`. Uniqueness is
enforced by partial unique indexes **in the schema**, not only application
logic:

- one active workspace per `(project_id, ticket_id)`
- one active branch per `(source_repository_path, branch_name)`
- one active workspace per `worktree_path`

Audit events are appended for `workspace.creating`, `workspace.ready`,
`workspace.removed`, and `workspace.failed`. Payloads carry identity only
(workspaceId, ticketId, baseSha, branchName, worktreePath) and are runtime
validated by the typed event schema. No secrets or environment dumps.

## Filesystem + SQLite are not globally atomic

Git operations and database writes cannot share one transaction. WORK-001 is
explicit about this:

1. validate project/repository/ticket
2. prove dispatchability (CORE-002 scheduler logic)
3. resolve exact base SHA
4. derive branch/path deterministically
5. reserve persistently as `CREATING` (+ audit event, single commit)
6. create branch/worktree via git
7. verify every READY invariant
8. finalize `READY` **and** transition `ELIGIBLE → PLANNING` **and** append
   audit metadata inside one SQLite commit
9. on failure before READY: compensate or escalate

### Recovery (restart safety)

If ShipGraph crashes after the reservation but before finalization, the next
invocation finds the persisted `CREATING` row and inspects it. If the
recorded path exists as a plain directory, is a registered worktree of the
expected repository, has the expected branch checked out at exactly the
recorded base SHA, and is clean, the reservation is safely finalized.
Anything else fails closed into `NEEDS_HUMAN`. Ambiguous state is never
deleted automatically.

### Compensation

When a failure happens inside the same controlled process, ShipGraph removes
the newly created worktree and branch only when it can *prove* they belong to
this reservation (registered, correct branch, `HEAD == baseSha`, clean).
Otherwise everything is preserved and the workspace is marked `NEEDS_HUMAN`.

### Removal residual window

`workspace remove` performs the git removal first and records `REMOVED`
second. A crash between the two leaves a REMOVED-on-disk/READY-in-db state,
which `workspace inspect` surfaces as `MISSING`; nothing is auto-repaired.

## Dirty worktrees are preserved

A dirty ticket worktree is never removed; there is deliberately no
`--force`. Removal requires a clean, registered, correctly-bound `READY`
workspace whose recorded path exactly equals the deterministic location. The
branch is deleted only when it provably still points at the recorded base
SHA (no unique work); otherwise it is retained.

## Ambiguity fails closed

Symlinks anywhere in the worktree chain (root, project segment), malicious
ticket ids, pre-existing paths, tampered branches, wrong HEADs, dirty trees,
and metadata copied into a different repository all fail closed. Once a
project has recorded any workspace, its source repository binding is
enforced; copied metadata in another checkout is refused.

## CLI

```
shipgraph workspace create <ticket-id> [--json]
shipgraph workspace inspect <ticket-id> [--json]   # read-only health report
shipgraph workspace list [--json]                  # current project only
shipgraph workspace remove <ticket-id> [--json]    # conservative, no force
```

Health values reported by `inspect`: `HEALTHY | DRIFTED | MISSING |
NEEDS_HUMAN`.
